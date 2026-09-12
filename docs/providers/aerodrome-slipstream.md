# Aerodrome Slipstream

## Protocol overview

**Upstream facts.** Slipstream is adapted from Uniswap V3. Its concentrated-liquidity pools are identified by token pair and signed `int24` tick spacing rather than token pair and fee. Swap fees can be dynamic. Gauge and reward changes also exist in Slipstream, but they are outside the Epeius swap path.

For exact-input multihop swaps, the path is packed as `address | int24 | address`, repeated for each next hop. The router sends each hop's actual output into the next hop. The pool can reach an end-price extreme without consuming the full requested input.

**Epeius policy.** Epeius supports exact-input quotes and direct-router preparation for configured, ABI-compatible Slipstream deployments. It does not support Slipstream allocation re-quotes or the configured Uniswap/Pancake executor. It does not use gauges or rewards.

## Comparison with other V3 providers

| Epeius-visible behavior | Uniswap V3 | Pancake V3 | Aerodrome Slipstream |
| --- | --- | --- | --- |
| Pool selector | `uint24` fee | `uint24` fee | signed `int24` tick spacing |
| Path segment | `address | uint24 | address` | `address | uint24 | address` | `address | int24 | address` |
| Direct router tuple | Uniswap SwapRouter02 form; deadline supplied by its multicall | Pancake deadline-bearing tuple | Slipstream deadline-bearing tuple |
| Fee model relevant to Epeius | Selector is fee | Selector is fee | Selector identifies pool; fee may be dynamic |
| Configured executor | Supported | Supported | Not supported |

## Configuration

Define common deployment fields at the deployment table and Slipstream-specific selectors in its nested `options` table:

```toml
[chains.base.deployments.aerodrome-slipstream]
kind = "aerodrome-slipstream"
factory = "0x..."
quoter = "0x..."
router = "0x..."

[chains.base.deployments.aerodrome-slipstream.options]
tick_spacings = [1, 50, 100, 200]
```

`tick_spacings` values must be unique signed `int24` values. Slipstream rejects `fees`; fee-based V3 deployments reject provider `options`. Tokens remain configured under the same chain and determine possible direct and intermediate assets.

Epeius has no hardcoded chain ID or exact-address allowlist for Slipstream. Configuration may admit any ABI-compatible deployment. This is configuration-based admission, not proof that an address is official or safe. Check addresses against the upstream deployment table and Aerodrome security page before trusting them.

Startup fails closed for each configured Slipstream deployment unless all these checks pass at the pinned startup block:

1. Factory, Quoter, and Router addresses contain code.
2. Quoter `factory()` and Router `factory()` both equal the configured Factory.
3. Factory `swapFeeModule()` returns a nonzero address containing code.
4. Fee module `factory()` equals the configured Factory.

A failed deployment is unavailable for quotes and preparation. These linkage checks do not establish source-code provenance, governance safety, or future behavior.

## Contracts and ABIs

Epeius uses fixed Slipstream interfaces, not arbitrary calldata:

- Factory `getPool(tokenA, tokenB, tickSpacing)` resolves pool identity.
- QuoterV2 `quoteExactInputSingle` accepts the Slipstream tuple with signed tick spacing and returns amount, post-swap price, initialized-tick count, and gas estimate.
- SwapRouter `exactInput` receives the packed path, recipient, deadline, input amount, and minimum output.
- Factory and fee-module linkage getters support startup admission.

Canonical ABI files remain authoritative repository inputs. Do not infer compatibility from matching function names alone.

## Quote behavior

Epeius searches configured one-hop and two-hop paths through configured tokens and tick spacings. Candidate order is deterministic. Every pool lookup and quote read is pinned to one EIP-1898 block hash; there is no fallback to latest state. On a two-hop route, the first hop's exact quoted output becomes the second hop's exact input.

Quoter calls encode tick spacing as signed `int24`. A configured spacing produces a route only when Factory `getPool` returns a usable pool. A quote whose post-swap square-root price reaches the relevant TickMath extreme is rejected because full input may not have been consumed.

Informational quotes have no account. Slipstream's DynamicSwapFeeModule can apply `discounted(tx.origin)`, so an account-free quote cannot include a signer-specific discount. During preparation Epeius reads the signer's discount and rejects any nonzero value rather than preparing calldata from mismatched quote terms.

## Preparation and account behavior

Slipstream preparation is direct only. Epeius builds and simulates one unsigned SwapRouter exact-input transaction; the terminal independently checks configured tokens, deployment, signed spacings, target, spender, and calldata before consent or submission. Router is both transaction target and ERC-20 approval spender.

Preparation requires the selected route and deployment to remain valid, the signer discount to be zero, and Tenderly evidence to satisfy the normal direct-route checks. Epeius never owns keys, signs, submits, or decides consent. The terminal owns those actions and verifies the receipt.

## Limits

- Exact-input ERC-20 swaps only.
- One or two hops only; no arbitrary-length or mixed-provider route.
- No Slipstream allocation re-quote, allocation optimizer, or executor capability.
- No account-aware informational quote; nonzero signer discount is rejected during preparation.
- No native ETH, Permit2, transfer-tax token, rebasing token, gauge, or reward support.
- No on-chain full-consumption guarantee. Epeius rejects an extreme end price during quoting and checks consumption in simulation and receipt evidence, but pool state can change before inclusion.
- Configuration and startup linkage do not prove an unofficial deployment trustworthy.

## Local verification

These repository commands are supported:

```bash
# Inspect configuration, then check the configured Base RPC without starting the engine.
bun run terminal -- chains
bun run terminal -- chain check base

# Start the engine, then request a read-only quote in another shell.
bun run engine
bun run terminal -- quote --chain base --in WETH --out USDC --amount 0.01

# Run the repository checks.
bun run check
bun run check:generated
```

`chain check` and `quote` need the configured RPC environment variable. Informational quote commands do not sign or submit. Preparation and execution require the separate wallet, Tenderly, execution-enabled configuration, and consent flow described in [Terminal](../terminal.md#configured-chain-execution).

To repeat an exact prepared transaction without submitting to the source chain, pin the same block used by the quote, fork it locally, and use only values returned in Epeius's unsigned transaction:

```bash
anvil --fork-url "$SOURCE_RPC_URL" --fork-block-number "$BLOCK_NUMBER" \
  --host 127.0.0.1 --port 28545 --silent

cast rpc --rpc-url http://127.0.0.1:28545 \
  anvil_impersonateAccount "$PREPARED_FROM"
cast send --rpc-url http://127.0.0.1:28545 --unlocked \
  --from "$PREPARED_FROM" --gas-limit "$PREPARED_GAS_LIMIT" \
  "$PREPARED_TO" "$PREPARED_DATA"
```

Before and after the local send, query sender and router token balances and require the exact input decrease, output increase of at least the prepared minimum, and no new router residue. Verify that the fork block hash equals the quote block hash. The impersonated address must already have the required balance and allowance at that block unless the test explicitly records fork-only state changes.

The dated [Initial deployment acceptance](../aerodrome-slipstream-acceptance.md) records the pinned setup and resulting balance evidence for one Base deployment; it is not a reusable address allowlist or mainnet execution proof.

## Official references

- [Slipstream repository](https://github.com/aerodrome-finance/slipstream)
- [Specification](https://github.com/aerodrome-finance/slipstream/blob/main/SPECIFICATION.md)
- [Changelog](https://github.com/aerodrome-finance/slipstream/blob/main/CHANGELOG.md)
- [Aerodrome security and contract addresses](https://aerodrome.finance/security#contracts)
- [Upstream deployment tables](https://github.com/aerodrome-finance/slipstream/blob/main/README.md#deployments)
- [Factory `getPool`](https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/interfaces/ICLFactory.sol#L112-L118)
- [QuoterV2 tuple](https://github.com/aerodrome-finance/slipstream/blob/main/contracts/periphery/interfaces/IQuoterV2.sol#L27-L48)
- [Packed path library](https://github.com/aerodrome-finance/slipstream/blob/main/contracts/periphery/libraries/Path.sol#L10-L50)
- [Sequential router exact input](https://github.com/aerodrome-finance/slipstream/blob/main/contracts/periphery/SwapRouter.sol#L124-L160)
- [TickMath bounds](https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/libraries/TickMath.sol#L8-L16)
- [Pool amount and price-limit behavior](https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/CLPool.sol#L678-L725)
- [Dynamic fee discount and `tx.origin`](https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/fees/DynamicSwapFeeModule.sol#L155-L192)
