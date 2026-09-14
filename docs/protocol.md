# ConnectRPC protocol

Protocol source is [`proto/epeius/quote/v1/quote.proto`](../proto/epeius/quote/v1/quote.proto). Generated Go and TypeScript bindings are checked in under [`generated/go`](../generated/go) and [`generated/ts`](../generated/ts). Regenerate them with `bun run generate`.

## Service

`QuoteService` exposes:

- `GetStatus`: current in-memory chain status established at engine startup.
- `GetQuote`: deterministic unary exact-input route search.
- `PrepareExecution`: create or recheck immutable execution terms and simulation evidence for an explicitly enabled configured chain.
- `StreamQuote`: declared but not implemented.

The engine builds and simulates unsigned transactions. Signing, user confirmation, submission, and receipt checks belong to the terminal. This trust split is part of the current contract.

## Status

Each `ChainStatus` contains chain key and ID, startup connectivity, sanitized error, quote support, configured tokens, startup block, and execution flag.

`connected: true` means startup RPC verification succeeded. It is not continuous health monitoring. `quotingSupported: false` can coexist with connectivity when tokens or deployments are absent. `executionEnabled: true` is necessary but not sufficient: local TOML, engine status, terminal RPC, and prepared transaction chain IDs must match.

## Quotes

Clients send canonical token addresses, positive decimal atomic input, search budget, chain key, and chain ID. Both chain fields are required to prevent accidental network mismatch.

`QuoteFinal` contains:

- `quoteId`, later used with one selected `routeId`;
- canonical `block` used for every candidate;
- zero or more `routes` in deterministic search order;
- zero or more `errors`, optionally tied to a route; and
- `searchComplete`.

`bestRouteId` is present when at least one route succeeds. It selects the greatest raw `amountOutAtomic` using arbitrary-precision integer comparison. Ties keep the first route in deterministic candidate order, independent of completion order. It does not reorder or remove routes or errors. Partial searches may recommend the best returned route, not a global best. Selection excludes gas, approval costs, and latency.

`searchComplete: true` means all candidate attempts finished before the budget. It does not mean all candidates succeeded. `false` means some routes may be missing; returned routes and errors still describe completed work. No route means failure to find a usable route, even if search completed.

Each route identifies provider, configured deployment, exact atomic output, block, latency, and protocol-defined legs. V3 routes have one or two legs and use `feePips`, measured in millionths. Balancer V2 routes have one leg, store complete lowercase `bytes32 poolId` in `pool`, and leave selector absent. Optional cost fields remain absent: unknown or uncomputed, never zero.

All calls at quote time use one canonical EIP-1898 block hash. There is no fallback to latest state. Quote output is informational and does not authorize execution.

`epeius.atomic.v1.AtomicPlanService.GetPlanQuote` is an additive quote path. Its request uses present format version 1, 32-byte unsigned chain ID and input amount, 20-byte token addresses, and a positive search budget. The response has a random 32-byte quote ID, explicit `searchComplete`, and ordered zero or more candidates. This slice returns only one full-input homogeneous branch with one or two sequential Uniswap V3 kind-1 or Pancake V3 kind-2 operations from enabled Atomic V1 deployments. It does not discover split branches, emit mixed-provider candidates, rank candidates, or populate `networkCostOut`.

Each candidate carries the complete typed program, one exact positive output per operation, one pinned block, and a 32-byte candidate ID. The ID commits ordered provider kind and exact factory/router/pool/fee, operation, program branch, program, and candidate-quote branch hashes under their `Epeius.Atomic*.v1` domains. Labels, quoter address, latency, and diagnostics do not enter this identity. `PreparePlan` accepts an explicit stored candidate without requoting or substitution; existing quote and preparation APIs remain unchanged.

## Execution preparation

Initial `PrepareExecutionRequest` supplies quote ID, sender, slippage basis points, and either `routeId` for direct execution or `allocations` for an executor. `execution_mode = ATOMIC_V1` selects the additive Atomic V1 path. Atomic V1 accepts one already-returned Uniswap V3 route with one or two token-continuous legs, or exactly two already-returned direct Uniswap V3 routes. Atomic allocations must both be positive and sum exactly to the original quote input. Their physical pools, identified by unordered token pair and fee, must be globally distinct. The engine re-quotes only these selected routes at their literal inputs; it does not discover split candidates. Unspecified mode preserves the legacy configured-executor rule that two allocations use distinct venues. A recheck supplies only `preparationId`. Current sender and recipient are the same wallet.

Executor responses use `allocations` of `QuotedAllocation`, each containing its exact input and freshly re-quoted route at the original shared block; legacy `route` is absent. Outputs are never scaled. Sum the allocation outputs before calculating the single slippage floor. Allocation order, amounts, full routes, and transaction bytes are immutable preparation terms. Old clients must not treat an executor response as a direct-router response.

Atomic V1 responses contain selected pinned `route` or two `allocations` and an `epeius.atomic.v1.Plan`. Plan has either one branch with one or two operations, or two branches with one direct operation each. The generic executor admits Uniswap V3 kind 1 and Pancake V3 kind 2, while the new plan service currently prepares only homogeneous one-branch candidates. Its `plan_id` commits accepted program, including ordered branches and typed provider/operation identities, exact executor version and runtime hash, signer and recipient, amounts and branch/aggregate minima, quote block, expiry, and deadline. Separate `executor_plan_hash` remains contract event commitment over version 2, chain ID, ExecutorV2 address, sender, and canonical ExecutorV2 `Plan` tuple. `transaction_fingerprint` binds `plan_id` to exact unsigned chain, sender, target, value, calldata hash, and gas limit. Terminal independently recomputes all three and preserves them unchanged on recheck. Older terminals ignore additive fields but reject unfamiliar ExecutorV2 target/calldata as direct route, so they fail closed.

Statuses:

- `READY`: response may contain the swap transaction.
- `APPROVAL_REQUIRED`: response contains a separate approval transaction; the old quote must not be used after approval.
- `REQUOTE_REQUIRED`: quote, block, allowance, or preparation is stale or unavailable.
- `REJECTED`: execution or required safety evidence is unavailable or invalid.

`APPROVAL_REQUIRED` contains only the validated approval transaction, never the swap transaction. `REJECTED` and `REQUOTE_REQUIRED` contain neither transaction. Clients check these statuses before comparing route or allocation terms, since rejected responses need not carry executable terms. Malformed requests and unknown direct route IDs remain Connect `InvalidArgument`; unknown allocation route IDs remain `REJECTED`.

Preparation binds sender, recipient, atomic input, minimum output, route, deadline, and unsigned transaction. Rechecking may update simulation block, simulated output, and message, but may not change executable terms. IDs are process-local and expire; engine restart invalidates them.

See [Execution contract](execution.md) for simulation evidence, deadlines, receipt semantics, partial consumption, and unsupported tokens and calls.

## JSON and errors

Terminal `--json` uses Protobuf JSON. Default-valued fields can be omitted, field names use JSON conventions, and decimal uint256 values remain strings. Diagnostics are separate stderr output, not protocol messages.

Provider failures can be returned inside a successful `QuoteFinal`. Transport cancellation, deadline expiry, invalid arguments, unavailable engine/RPC, and failed preconditions fail the RPC. Clients must not convert an RPC failure into an empty successful quote.

Preparation reasons for known engine failures are fixed safe text, not upstream error strings. Unknown upstream failures are generic. Missing Tenderly configuration, transport failure, timeout, incomplete evidence, and failed simulation safety checks remain distinct explanations under `REJECTED`. Changed approval state or inability to confirm a canonical block uses `REQUOTE_REQUIRED`. Canonical uncertainty is not a proven reorg, and failed simulation is not proof of actual token loss. Clients must not parse English messages as error codes or maintain a message whitelist.

Terminal `ExecutionResult` and `ExecutionEvent` are internal TypeScript types, not additions to this protocol. Result kinds do not add a JSONL discriminator. Existing quote, selection, preparation, cancellation, submitted-hash, and verification payloads retain their fields and order. Human review goes to stderr; raw Protobuf JSON on stdout keeps envelope text and full transaction bytes. This is not a guarantee of redacting arbitrary output from a malicious engine.

## Compatibility

Removed `QuoteRequest` fields and their numbers are reserved: `environment`, `sender`, `recipient`, and `slippage_bps`. Do not reuse them. `--chain` replaced the former environment option. Run engine and terminal from matching generated bindings after protocol changes.
