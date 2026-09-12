# Execution contract

Epeius supports direct Uniswap V3, Pancake V3, Aerodrome Slipstream, Balancer V2, and Uniswap V4 calls, plus an explicitly configured Uniswap/Pancake exact-input executor, on chains enabled in TOML. Providers have no hidden chain ID or exact-address allowlist; compatible deployments can be admitted by configuration after provider-specific startup checks. Local TOML, engine status, terminal RPC, and prepared transaction identities must all match. The Go engine builds and simulates unsigned transactions. The terminal owns the local signer, confirmation, submission, and receipt checks. Execution remains opt-in; adding a deployment or executor does not enable it.

This policy supersedes the earlier milestone restriction to Base Sepolia (chain ID 84532). Base Sepolia remains the verified and default test setup. Every new network or provider needs separate capability and simulation-support validation; current tests are not multi-network live proof.

## Routes and deployments

A route uses one configured deployment. Uniswap V3, Pancake V3, and Slipstream use one or two pools; arbitrary-length routes are not supported. Uniswap and Pancake use `fee_pips`, measured in millionths. Slipstream uses signed `tick_spacing`, which identifies the pool and is not its dynamic fee. Balancer uses one full lowercase `bytes32 poolId` and no route selector.

For example, an A-to-C quote can offer a direct Uniswap A/C pool, a two-hop Uniswap A/B and B/C route, and a separate Pancake route. Direct execution selects one alternative. Executor preparation accepts one or two caller-chosen allocations; two allocations must use different venues. Each second hop consumes actual first-hop output, not an independently fixed estimate. There is no allocation optimizer.

Token addresses and provider settings come from TOML. V3 pool addresses and parameters must match the configured factory. Balancer validates each full pool ID against Vault `getPool`, its encoded address, pool `getPoolId`, contract code, and registered tokens. Provider kinds choose supported implementations; they do not make arbitrary ABIs configurable. Uniswap V4, Slipstream, and Balancer configuration and startup admission are detailed in their [V4](providers/uniswap-v4.md), [Slipstream](providers/aerodrome-slipstream.md), and [Balancer V2](providers/balancer-v2.md) guides. Router addresses come from configuration, not user-supplied transaction targets. Native ETH swaps, transfer-tax tokens, rebasing tokens, arbitrary Permit2 use outside V4 flow, and arbitrary calldata execution are unsupported.

Before confirmation and again before submission, the terminal checks the route against its local TOML token, deployment, target, and selector or pool-ID lists. It independently encodes expected swap calldata from the displayed route, recipient, input, minimum output, and deadline, and requires an exact byte match. Uniswap permits one exact-input call inside its deadline multicall; Pancake and Slipstream permit their deadline-bearing exact-input calls. Balancer permits one `Vault.swap` with `GIVEN_IN`, empty user data, external balances, and signer as sender and recipient. Approval must target the local input token and authorize only the declared amount to the configured spender: router for direct V3, Vault for Balancer, or executor for allocations. An engine response alone cannot authorize a different target or operation. The local config itself must be trusted.

## Quotes and immutable preparations

An informational quote does not need a wallet and does not authorize execution. A preparation binds one selected quote to the sender, recipient, amount, route, minimum output, deadline, and unsigned transaction. The sender and recipient are the same wallet in this milestone.

`trade` discovers the local account and validates its execution context before requesting its first executable trade quote. `prepare` and `execute` establish that context before preparation. This ordering does not add a sender to the quote protocol or make informational commands require a wallet.

Rechecking a preparation can update the simulation result, but cannot silently change the transaction's conditions. Changing the route, minimum output, or deadline requires a new preparation and confirmation. Preparations are held in memory; restarting the engine invalidates their identifiers.

The terminal verifies the minimum against the requested `--slippage-bps`: `floor(quotedOutput * (10000 - slippageBps) / 10000)`. The basis is the saved route output for direct execution or summed exact-allocation outputs for the executor, not a refreshed simulation estimate. The minimum must remain positive. All encoded amounts and deadlines must fit `uint256`. These checks establish consistency with the displayed quote, not an independent fair-market price: the engine still supplies the quoted output.

Application expiry and the on-chain deadline have different jobs. Application expiry limits how long the terminal accepts a preparation. The router checks the deadline against the block timestamp. Neither reserves pool liquidity or guarantees inclusion before expiry.

Uniswap SwapRouter02's V3 swap tuples do not include a deadline. Its trusted `multicall(uint256,bytes[])` wrapper supplies that check. This router-local wrapper is not a new generic multicall contract. Pancake V3 includes a deadline in its swap parameters.

## Approval is a separate transaction

If the wallet's allowance is insufficient, the engine reports `APPROVAL_REQUIRED`. A simulated approval followed by a swap is a preview, not proof that the real wallet is ready to swap.

Application consent, wallet authorization to sign and send, and ERC-20 approval are separate actions. The user confirms the approval separately. After its canonical successful receipt, obtain a fresh quote and a fresh swap preparation, then confirm that swap separately. A successful approval is not rolled back if the later swap fails. In `trade`, automatic selection uses the fresh recommendation; manual selection keeps the requested route ID or stops. Both require new swap consent. Explicit executor allocations are never refreshed automatically.

The terminal presents the action, complete addresses, exact decimal and atomic amounts, route and allocation details, deadline, expiry, and simulation block on stderr before asking for consent. An approval review is approval-only, not a swap promise. Machine JSONL stays on stdout with complete transaction bytes. Cast is the only wallet implementation: it opens the local keystore and makes one send attempt. JavaScript never receives the private key.

## What simulation proves

Tenderly simulates the actual sender, target, calldata, and value against a specified network state. A ready preparation must use real balances and allowances, without state overrides that manufacture readiness. Missing or inconclusive simulation evidence is not success.

Every bundle step sets `transaction_index = -1` to start from the pinned block's end state, matching the RPC reads. Omitting that field uses the block's starting state: an approval confirmed within that block can appear absent in simulation. This distinction was verified on Base Sepolia by comparing the same allowance before the block, after the block, and at explicit Tenderly transaction indexes. Bundle steps then carry simulated state forward in order.

Check that the transaction succeeds, consumes the declared input, delivers at least the minimum output, and introduces no intermediate-token residue in the router. For custom test tokens, use exact token amounts and balance/transfer evidence; USD valuations are neither required nor proof of correctness.

Simulate alternative routes separately from the same starting block. A sequential bundle carries earlier state changes into later calls, so it is suitable for approval followed by swap, but not for comparing independent alternatives.

Simulation does not guarantee future success. Other transactions can change pool state before inclusion. RPC or simulator failure must not silently bypass the pre-send check.

Known simulation failures use fixed engine messages that distinguish missing configuration, unavailable service, timeout, incomplete evidence, and failed amount, balance, or allowance checks. Unknown upstream failures remain generic; engine preparation diagnostics do not include upstream URLs, headers, response bodies, or request echoes. Rejected and requote responses contain neither swap nor approval transactions. An inability to confirm a canonical block requires a fresh quote; it does not prove a reorg or an on-chain loss.

## Direct-router limitation: partial input consumption

`amountOutMinimum` constrains the output, not full input consumption. A V3 pool can reach its limiting price before consuming all requested input. If the output still satisfies the minimum, the router call can succeed.

In an ordinary single-hop swap paid directly from the wallet, unconsumed input stays in the wallet. For a two-hop swap, intermediate tokens can instead remain in the router. For example, the first hop can exchange 100 A for 80 B, while the second hop consumes only 60 B. The remaining 20 B can stay in the router even though the transaction succeeds.

The direct-router path checks consumption before submission through simulation and after execution through actual transaction evidence. It does **not** enforce an on-chain full-consumption-or-revert guarantee. A change in pool state between simulation and inclusion can still produce an unexpected result. A post-execution failure report cannot undo a confirmed trade or automatically recover stranded tokens. `trade` currently uses this direct path; choosing `--allocations` on `prepare`/`execute` opts into the executor instead.

The terminal must distinguish a confirmed successful receipt from a trade whose amounts passed verification. Neither a successful receipt nor the final output balance alone proves full input and intermediate-token consumption. Existing router balances must not be counted as this trade's output or residue.

Base RPC can return a preliminary receipt with `status = 1` and an all-zero `blockHash` before the block is sealed. That is not confirmed execution. Wait for a nonzero block hash that matches the canonical block at the receipt's block number before checking amounts or using newly deployed contracts. This check is not a claim of L1 finality; later reorgs remain possible.

The receipt waiter follows only the original submitted hash; it does not accept a replacement transaction. The hash event is emitted before waiting. Failure after wallet handoff can leave the result unknown, including when no hash was returned. The terminal never resends automatically. A canonical successful swap receipt must also pass exact-transaction token-delta verification; malformed or removed logs cannot establish success.

## Configured executor

The [typed executor](../contracts/README.md) receives intermediate tokens and measures each hop's actual input consumption and output. Incomplete consumption reverts the entire swap transaction, including earlier route swaps. It preserves pre-existing touched-token balances, clears temporary router allowances, and sends only new aggregate output to the caller. Its two immutable router identities are Uniswap SwapRouter02 and Pancake V3-only SwapRouter. The constructor has no token allowlist or admin; reviewed standard ERC20 admission remains TOML policy. Direct contract callers can bypass application admission, and malicious tokens are not supported.

After separately authorizing and verifying a deployment, add its address and existing deployment IDs to both engine and terminal TOML. Replace the placeholder before use:

```toml
[chains.base-sepolia.executor]
address = "DEPLOYED_EXECUTOR_ADDRESS"
uniswap_deployment = "uniswap"
pancake_deployment = "pancake"
```

These IDs must name the correct kinds and distinct configured router addresses. Preparation verifies nonempty executor code and both router getters at the execution block, including recheck. These checks prove configured linkage, not bytecode provenance: operators must verify the deployed artifact and constructor arguments independently before admitting its address. No executor is implicitly enabled. The explicitly authorized [Base Sepolia deployment and acceptance](base-sepolia-acceptance.md) records one verified artifact and constructor combination.

Clients admit tokens and metadata against local TOML before quoting. The engine retains cheap in-memory request checks for direct API callers; startup handles existing metadata/deployment checks. No additional token-classification RPC is added to quote search. Executor linkage, allowance reads, and Tenderly checks occur during preparation, not route search. No speedup is claimed.

`--allocations` is a JSON array of one or two `{ "routeId": "...", "amountInAtomic": "..." }` entries, mutually exclusive with `--route-id`. Their positive atomic inputs must sum exactly to the original quote's input. The engine re-quotes each selected path at its exact allocation amount and the same original canonical block, including actual quoted first-hop output as the second-hop input. It never scales full-input outputs. Add outputs first, then calculate one slippage floor. Response `allocations` contains this new quote evidence; legacy `route` is absent. Costs remain unknown/absent.

```bash
# Quote the full total first. Use real returned route IDs and exact atomic amounts.
bun run terminal -- prepare --chain base-sepolia --config .testnet/runtime.toml \
  --quote-id QUOTE_ID \
  --allocations '[{"routeId":"UNISWAP_ROUTE_ID","amountInAtomic":"37"},{"routeId":"PANCAKE_ROUTE_ID","amountInAtomic":"64"}]' \
  --slippage-bps 75 --keystore "$TERMINAL_KEYSTORE" --password-file "$TERMINAL_PASSWORD_FILE"
```

The example requires a quote whose input is 101 atomic units, not 101 whole tokens. `prepare` sends nothing. Only after explicit transaction authorization, use `execute` with the reviewed arguments and confirm the displayed approval or swap. Approval targets the executor for the exact total, never a router. A confirmed approval requires a fresh quote and preparation; old IDs cannot upgrade into swaps. There is no automatic split refresh or allocation choice.

Terminal validation independently checks local executor/deployment/token/fee config, allocation totals, distinct venues, shared quote block, aggregate slippage, and exact ABI calldata. Recheck preserves all allocation terms, deadline, and transaction bytes. The Tenderly bundle simulates that exact executor transaction, probes touched balances at caller/executor/each used router before and after, and proves temporary executor-to-router allowances are zero afterward. Missing evidence rejects preparation. Canonical receipt verification checks exact-transaction Transfer deltas for the same touched owners; it is not independent proof of arbitrary-token behavior or allowance state.

A revert rolls back that transaction's swaps and token transfers. Gas is still paid, and an earlier approval transaction remains confirmed. The same executor call will be used for simulation and actual execution; a simulation-only wrapper would not establish the same guarantee.

Local proofs cover independent Go/TypeScript/cast encoding vectors, exact-size quote and rounding fixtures, CLI request/recheck/refusal paths, Tenderly token-owner/allowance mutations, and authentic-router Foundry tests. [Dated Base Sepolia evidence](base-sepolia-acceptance.md) separately records four live executor scenarios with exact Tenderly simulation and canonical receipts. Live direct-route coverage and selected-route commands in [testnet checks](testnet.md) do not by themselves establish executor acceptance.

## Public testnet checks

Use separate harness and terminal wallets, with small testnet-only balances. Keep encrypted keystores and password files outside Git. Local file permissions and encryption do not protect against compromise of the same OS account when the password is stored on that machine.

The harness uses standard mintable tokens with 18, 6, and 8 decimals. Real one-hop and two-hop swaps on both venues, approval handling, opposite directions, partial consumption, and intermediate residues are separate checks. Network transactions require explicit opt-in; credential-free checks must not deploy or spend test ETH.

Public testnet transactions change pool state and cannot be reset by the harness. Sequential trades need not have equal outputs. Record the selected route, preparation, block context, transaction hash, and verification result; do not describe successful testnet execution as a mainnet result.

## References

- [Uniswap SwapRouter02 V3 interface](https://github.com/Uniswap/swap-router-contracts/blob/v1.1.0/contracts/interfaces/IV3SwapRouter.sol)
- [Uniswap deadline multicall](https://github.com/Uniswap/swap-router-contracts/blob/v1.1.0/contracts/base/MulticallExtended.sol)
- [Uniswap V3 router implementation](https://github.com/Uniswap/swap-router-contracts/blob/v1.1.0/contracts/V3SwapRouter.sol)
- [Tenderly sequential bundle semantics](https://docs.tenderly.co/api-reference/simulator/simulate-bundled-transactions)
- [Tenderly Base Sepolia simulation](https://docs.tenderly.co/node/rpc-reference/base-sepolia/tenderly_simulateBundle)
