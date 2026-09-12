# Uniswap V4

## Supported behavior

Epeius supports configured one-hop, exact-input ERC-20 swaps through Uniswap V4. Pools must use a static fee and the zero hook address. Native ETH, dynamic-fee pools, hooks, two-hop V4 routes, mixed-provider routes, and executor allocations are not supported.

The engine only builds and simulates unsigned transactions. The terminal independently checks the route, Permit2 permission, Universal Router calldata, and receipt evidence before it asks for consent or submits through the local signer.

## Configuration

Common deployment fields name the fixed Quoter and Universal Router. V4-specific contracts, router identity, and allowlisted pools belong to `options`:

```toml
[chains.base.deployments.uniswap-v4]
kind = "uniswap-v4"
quoter = "0x..."
router = "0x..."

[chains.base.deployments.uniswap-v4.options]
pool_manager = "0x..."
state_view = "0x..."
permit2 = "0x..."
router_code_hash = "0x..." # keccak256 of deployed Universal Router runtime code

[[chains.base.deployments.uniswap-v4.options.pools]]
currency0 = "0x..." # lower-address currency
currency1 = "0x..."
fee_pips = 500
tick_spacing = 10
hooks = "0x0000000000000000000000000000000000000000"
```

All five options are required and unknown fields are rejected. `currency0` must sort before `currency1`. Pool entries must be unique; fee must be from 0 through 1,000,000, tick spacing must be from 1 through 32,767, and hooks must be zero. Both currencies must also be configured chain tokens.

`router_code_hash` pins one reviewed deployed Universal Router generation. It is not calculated from a local build. Obtain it from the configured chain's deployed runtime bytecode and verify that deployment against Uniswap's published addresses before trusting it.

## Startup admission

At the pinned startup block, the engine requires code at PoolManager, Quoter, StateView, Permit2, and Universal Router. It then verifies:

1. Quoter `poolManager()`, StateView `poolManager()`, and Universal Router `poolManager()` equal the configured PoolManager.
2. The Universal Router runtime hash equals `router_code_hash`.
3. The configured Permit2 immutable appears in that exact pinned router runtime.

The exact hash prevents unrelated decoy bytecode from passing the Permit2 check. The Permit2 check binds the separately configured permission target to the pinned router. A failed deployment remains unavailable while healthy deployments can continue.

Configured pools are checked when quoted, not at startup. A pool whose StateView `getSlot0(poolId)` returns an uninitialized price is a normal no-route result at that block. RPC failure or malformed state remains a provider error.

## Contracts and ABIs

Epeius uses fixed canonical ABIs and encoding rules:

- StateView `getSlot0(bytes32)` checks pool initialization.
- Quoter `quoteExactInputSingle` returns the exact-output estimate at one pinned block.
- Universal Router `execute` runs the V4 swap, settle, and take actions with a deadline.
- Permit2 `allowance` and `approve` provide the router's token permission.
- PoolManager getters on the periphery contracts establish deployment linkage.

Pool ID is `keccak256(abi.encode(PoolKey))`. The route carries the complete pool key, and both engine and terminal require it to match one configured pool exactly. Canonical ABI files under `contracts/abi` remain authoritative; matching function names alone do not establish compatibility.

## Quote and preparation flow

Each allowlisted pool contributes at most one candidate for its configured currency pair. The engine checks pool initialization and quotes at the same EIP-1898 block hash. Informational quotes do not depend on the wallet.

Preparation can require two separate permissions, but one fresh quote can authorize at most one transaction:

1. If the ERC-20 allowance to Permit2 is insufficient, approve the exact input amount to Permit2.
2. Obtain a fresh quote. If Permit2 does not authorize the Universal Router for the exact amount through the swap deadline, grant that exact permission with its fixed 30-minute lifetime.
3. Obtain another fresh quote. The engine may now simulate and return the swap transaction.

Each approval needs separate terminal consent and canonical receipt confirmation. An old quote never advances from one permission to the next or from permission to swap. The terminal rejects a `READY` response that carries hidden approval fields and independently reconstructs the expected Permit2 and Universal Router calldata.

Tenderly or the explicitly selected local Anvil simulator must prove the exact unsigned swap against the pinned state. Missing or incomplete simulation evidence rejects preparation. A successful receipt must still prove full wallet input consumption, output at least the reviewed minimum, and no new router residue.

## Validation

Run repository checks and inspect the configured chain before enabling execution:

```bash
bun run check
bun run check:generated
bun run terminal -- chains
bun run terminal -- chain check base
```

The checked-in Base fork fixture exercises both swap directions against deployed V4 contracts. See [development tooling](../development.md#uniswap-v4-base-fork-acceptance) for the complete fork setup and [testnet checks](../testnet.md) for the Base Sepolia harness. Fork and testnet runs are scoped evidence; they do not prove production behavior.

## References

- [Uniswap V4 deployments](https://docs.uniswap.org/contracts/v4/deployments)
- [Universal Router technical reference](https://docs.uniswap.org/contracts/universal-router/technical-reference)
- [V4 PoolKey](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolKey.sol)
- [V4 StateView](https://github.com/Uniswap/v4-periphery/blob/main/src/lens/StateView.sol)
- [Universal Router PaymentsImmutables](https://github.com/Uniswap/universal-router/blob/3663f6db6e2fe121753cd2d899699c2dc75dca86/contracts/modules/PaymentsImmutables.sol)
- [Permit2 allowance transfer](https://github.com/Uniswap/permit2/blob/main/src/AllowanceTransfer.sol)
