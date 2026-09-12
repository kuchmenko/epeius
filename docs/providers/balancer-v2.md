# Balancer V2 provider

## Overview

Balancer V2 routes swaps through one Vault shared by registered pools. Unlike the supported V3 providers, a Balancer route identifies one pool with a full `bytes32 poolId`; it has no fee-pip or tick-spacing selector and does not use a separate quoter contract. Epeius asks the Vault for a `GIVEN_IN` quote and prepares the matching direct Vault swap.

## Configuration

Balancer-owned settings live under the deployment's strict `options` table:

```toml
[chains.ethereum.deployments.balancer-v2]
kind = "balancer-v2"

[chains.ethereum.deployments.balancer-v2.options]
vault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"
pools = [
  "0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014",
]
```

`vault` must be a nonzero EVM address. `pools` must contain unique lowercase 32-byte hexadecimal IDs. The provider rejects the common V3 `factory`, `quoter`, `router`, and `fees` fields and unknown Balancer options. Configuration supplies deployment data; the implementation has no hidden network or address allowlist.

## Startup checks

At one canonical pinned block, the engine requires Vault bytecode and checks every pool through Vault `getPool`, the address encoded in the pool ID, pool `getPoolId`, pool bytecode, and Vault `getPoolTokens`. A failed pool remains an explicit candidate error while other verified pools in the same deployment stay available. The deployment fails startup verification if the Vault or every configured pool fails.

These calls prove configured on-chain identity and ABI behavior at that block. They do not prove source-code provenance or future state.

## Quotes and preparation

Each configured pool yields at most one direct candidate for a requested token pair. The engine confirms both tokens are registered, excludes swaps where either token is the pool's BPT address, and calls `queryBatchSwap` with:

- `GIVEN_IN`;
- one swap step and exact input amount;
- input and output assets in route order;
- external balances;
- empty user data.

The returned signed deltas must contain exactly the requested positive input and one negative output. Missing token pairs are normal no-route results. Candidates remain sorted by full pool ID.

Preparation encodes one `Vault.swap` with the same pool ID, asset order, exact input, user-selected slippage minimum, recipient, and deadline. The signer is both sender and recipient, internal balances are disabled, and transaction value is zero. Approval authorizes only the exact input amount to the configured Vault. Balancer does not provide allocation re-quoting and is not admitted by the current fixed V3 executor.

The terminal independently checks the configured deployment and full pool ID, rejects BPT and selector-bearing routes, re-encodes the complete tuple, and requires exact target, value, and calldata equality before handing one transaction to Cast. Simulation and receipt checks prove exact input consumption and minimum output; Vault balances are persistent pool custody, not router residue.

## Account-dependent behavior

Informational quotes take no wallet address. Epeius supplies a fixed nonzero `FundManagement` address required by `queryBatchSwap`, uses external balances, and performs the quote as a pinned read-only call. Preparation does depend on selected signer: signer must hold enough input, approve configured Vault, remain both sender and recipient, and pass simulation before terminal consent.

The provider supports canonical Weighted, Stable, and Composable Stable pool implementations, whose swap calculation does not use the request sender or recipient. Custom or managed pools whose `onSwap` logic depends on either account are unsupported because the quote request intentionally has no wallet address. Startup identity checks do not prove pool source provenance, so operators must not configure account-dependent implementations; preparation simulation still fails closed for the selected signer.

## Limitations

Only direct, single-pool, exact-input ERC-20 swaps are supported. Native assets, internal balances, BPT swaps, relayers, custom user data, batch or multi-pool routes, SOR, transfer-tax tokens, and rebasing tokens are unsupported. The checked-in configuration keeps execution disabled.

## Local verification

```bash
bun run check
bun run check:generated
ETHEREUM_ARCHIVE_RPC_URL="$ETHEREUM_RPC_URL" go -C services/quote-engine test ./internal/quote -run '^TestBalancerHistoricalArchiveFixtures$' -count=1
BALANCER_FORK_E2E=1 go -C services/quote-engine test -race ./internal/quote -run '^TestBalancerForkExecutionEndToEnd$' -count=1
```

The archive and fork tests are optional and require an archive-capable Ethereum RPC. The fork test uses only resettable local state and never broadcasts to Ethereum. Passing mock, fork, or simulator checks is not production execution evidence.

## Official references

- [Balancer V2 single swaps](https://docs-v2.balancer.fi/reference/swaps/single-swap.html)
- [Vault interface](https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/interfaces/contracts/vault/IVault.sol)
- [Pool IDs and specialization](https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/vault/contracts/PoolRegistry.sol)
- [Pinned canonical ABI sources and hashes](../../contracts/abi/provenance.json)
