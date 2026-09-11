# Terminal

The Bun terminal is the user-facing CLI. It reads local configuration, calls the engine over ConnectRPC, formats quote results, owns the local signer, asks for confirmation, submits explicitly approved transactions on configured execution-enabled chains, and verifies receipts.

## Quick start

With the engine running:

```bash
bun run terminal -- status
bun run terminal -- tokens --chain base
bun run terminal -- quote --chain base --in WETH --out USDC --amount 0.01
```

Commands:

| Command | Purpose | Running engine needed |
| --- | --- | --- |
| `chains` | List configured chains and whether RPC variables are set | No |
| `chain check KEY` | Verify one RPC and read a block | No |
| `status` | Show engine startup status for every chain | Yes |
| `tokens` | List supported token symbols, addresses, and decimals | Yes |
| `quote` | Request an informational exact-input quote | Yes |
| `prepare` | Prepare and simulate without signing or sending | Yes |
| `execute` | Confirm and send one approval or swap, then verify its receipt | Yes |
| `trade` | Quote, select, prepare, confirm, send, and verify in one flow | Yes |

Use `--config PATH` to select TOML. `--engine-url URL` overrides its endpoint for remote terminal commands. `--chain KEY` selects a chain; otherwise `terminal.default_chain` is used. Every quote sends both chain key and ID, and the engine rejects a mismatch.

Read-only commands load terminal settings and token metadata without requiring valid execution settings, a wallet, or Tenderly. Execution configuration is checked for the selected chain when execution is requested; executor configuration is required only for allocations. Configuration is not cached or hot-reloaded.

## Tokens and amounts

Symbols are case-insensitive and resolve only among the selected chain's configured tokens. Unknown or ambiguous symbols fail. `ETH` is not an alias for `WETH`; an address does not bypass pair restrictions.

```bash
bun run terminal -- quote --in USDC --out WETH --amount 25

bun run terminal -- quote --chain base \
  --in 0x4200000000000000000000000000000000000006 \
  --out 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --amount-atomic 10000000000000000 \
  --search-budget-ms 2000 --json
```

Provide exactly one of `--amount` or `--amount-atomic`. Decimal conversion uses token decimals and integer arithmetic without floating point or rounding. Excess decimal places, scientific notation, zero, negative values, and uint256 overflow fail.

Search budget must be 1 through 2,147,478,647 ms. Transport timeout is the search budget plus 5 seconds. Cancellation or transport timeout fails the request instead of returning a partial response.

## Reading output

Normal result output goes to stdout. Human-readable text is the default. `--json` emits one Protobuf JSON value for `chains`, `chain check`, `status`, `tokens`, and `quote`; default-valued fields can be omitted. Diagnostics and warnings go to stderr.

A human quote shows:

- quote ID and selected chain;
- canonical block number and hash;
- exact decimal and atomic input;
- every route's ID, provider, output, legs, pool selectors, and latency;
- provider errors; and
- a warning when search was partial.

Routes stay in deterministic search order, not best-to-worst order. `bestRouteId` recommends the highest raw `amountOutAtomic` among returned routes, using exact integer comparison and keeping the first candidate on ties. It is absent when no routes succeeded. Partial search can still recommend a returned route, but never a global best. Gas, approval cost, and latency do not affect selection; `networkCostOutAtomic` and `effectiveOutAtomic` remain absent, not zero. A route can coexist with errors from other candidates. `quote` exits 0 when at least one route exists and 1 when none exist.

`status` exits 1 if any configured chain is unavailable. `chain check` exits 1 for a failed check. Machine consumers should read both the JSON and exit code.

## Configured-chain execution

Read [Execution contract](execution.md) before sending. Requires Foundry `cast`, an encrypted keystore, a password file, Tenderly credentials, native gas, funded configured tokens, a positive `chain_id`, and `execution_enabled = true`. The local TOML chain ID must match engine status, the terminal RPC, and the prepared transaction. Tokens, deployment contracts, and pool fees are accepted only from TOML; addresses supplied as token input do not bypass that allowlist.

Token addresses, symbols, and decimals reported by the engine must match the local chain token configuration before `tokens`, `quote`, `prepare`, or `execute` proceeds. Decimal conversion and quote formatting use this checked metadata, including when `--engine-url` selects a remote engine. Both decimal and atomic input modes enforce the check; `status` remains an informational view of the engine response.

```bash
bun run terminal -- prepare --chain base-sepolia --config .testnet/runtime.toml \
  --quote-id QUOTE_ID --route-id ROUTE_ID --slippage-bps 50 \
  --keystore /local/path/terminal --password-file /local/path/password

bun run terminal -- execute --chain base-sepolia --config .testnet/runtime.toml \
  --quote-id QUOTE_ID --route-id ROUTE_ID --slippage-bps 50 \
  --keystore /local/path/terminal --password-file /local/path/password
```

`prepare` writes one JSON line to stdout with `preparation` and `sent: false`. It never signs or sends. `execute` prints formatted terms and its prompt to stderr, then JSONL events to stdout:

1. A submitted hash with `submission: "submitted"` and `verification.outcome: "pending"`.
2. A separate receipt verification event, or a pending/unknown event if verification cannot finish.

Human review uses token metadata checked against local TOML. It shows approval-only or swap action, chain ID, full account/recipient/token/target/spender addresses, decimal and atomic amounts, route/deployment/hops/fees, allocation inputs and total when present, UTC and Unix deadline, preparation expiry, and simulation block. It does not replace the full transaction bytes in machine output. Reject/requote status is checked before route or allocation matching, so an engine refusal is not reported as a changed route. Human reasons escape terminal controls; the terminal does not maintain an English-message whitelist. Raw Protobuf JSON preserves engine envelope text, so arbitrary hostile engine output is not promised to be redacted.

For a verified, TOML-configured executor, replace `--route-id` with `--allocations '[{"routeId":"UNI_ROUTE","amountInAtomic":"37"},{"routeId":"PANCAKE_ROUTE","amountInAtomic":"64"}]'`. This example requires an original quote of 101 atomic units. One or two explicit allocations are supported; two must use different venues. See [executor preparation and evidence](execution.md#configured-executor) for admission, exact re-quotes, aggregate slippage, approval spender, and remaining live checks. `trade` remains a single direct-router route; it does not choose allocations or use the executor.

For swaps, `verification.outcome: "passed"` means the canonical successful receipt's exact-transaction ERC20 Transfer logs show full wallet input consumption, output at least the configured minimum, and no net intermediate-token residue in the router. `receipt_success` is used for approval receipts; it does not make the old quote executable. Obtain a fresh quote after approval.

`failed` means the receipt or measured token movement did not satisfy checks. `unavailable`, `pending_or_unknown`, or a null hash means outcome is inconclusive. A send may have reached the network even when its hash could not be returned. Inspect wallet transactions before any retry; never resend automatically.

Interactive execution requires typing `approval` or `swap`. Deliberate noninteractive runs may pass exactly one of `--confirm-approval yes` or `--confirm-swap yes`. The wrong action is not confirmed. Preparation IDs are in memory, expire after 30 seconds, and do not survive engine restart. On-chain deadline is 120 seconds from the preparation snapshot; rechecking extends neither deadline. These TTL and timeout values, gas behavior, and other fixed safety constants have not become TOML options.

Keep keystores and password files outside Git. Private keys are never accepted as command arguments. The checked-in root TOML disables execution on every chain. Base Sepolia is the verified and default test setup; configuring another network or provider does not prove capability or simulation support. Starting the engine never writes to a network.

Cast is the only implemented wallet integration. WalletConnect, embedded wallets, and account abstraction are not implemented. Read-only RPC and canonical receipt polling remain separate from Cast; polling follows the original hash, without replacement tracking or resend.

## Integrated trade

```bash
bun run terminal -- trade --chain base-sepolia --config .testnet/runtime.toml \
  --in WETH --out USDC --amount 0.001 --slippage-bps 50 \
  --keystore /local/path/terminal --password-file /local/path/password
```

`trade` accepts the same token, amount, search-budget, chain, and engine-URL options as `quote`, plus execution credentials and slippage. It selects `bestRouteId` by default. Pass `--route-id ID` to override with any returned route, including a nonwinner. Missing selection fails; the terminal never silently falls back to another candidate. Token admission and metadata checks against local TOML happen before requesting quotes. Preparation must match the original token pair, exact input, and full selected route, in addition to the independent local calldata/config checks used by `execute`.

Unlike informational `quote`, `trade` opens the local account and validates execution context before the first quote request. Missing credentials or an invalid execution context therefore stop the trade before quote search. The quote request still contains no sender field.

An approval has its own confirmation and canonical receipt check. After success, `trade` requests exactly one fresh quote and preparation. Automatic selection uses the fresh engine recommendation, which may change venue or path. Manual `--route-id` stays fixed and fails if absent. Fresh terms are shown and require a new interactive `swap` confirmation. Initial `--confirm-approval yes` or `--confirm-swap yes` never authorizes this post-approval swap; noninteractive execution cancels at that point. If the fresh route needs another approval, the flow stops before signing it. Start a new trade explicitly; no automatic approval loop or resend occurs.

Trade stdout always contains JSON lines, regardless of `--json`:

1. `{ "quote": ... }`: full Protobuf JSON `QuoteFinal`, including candidates, recommendation, errors, and search status. Protobuf default-valued fields may be omitted.
2. `{ "selection": { "quoteId": "...", "routeId": "...", "source": "engine", "searchComplete": false, "basis": "raw_output", "afterApproval": false } }`. `source` is `manual` for an override; `basis` describes engine recommendation criteria, not a claim that a manual route wins.
3. `{ "preparation": ..., "sent": false }`: the actual locally validated preparation before confirmation, including route and available simulation evidence. Approval preparations do not contain swap simulation output.
4. Existing submission and receipt verification events described above. There is no combined quote/simulation/actual output estimate: each remains in its own event.

After approval, events 1–3 repeat with a fresh quote ID and `afterApproval: true`, followed by fresh confirmation and swap events or cancellation. Prompts and formatted terms go to stderr. A canceled trade exits 1; a completed, verified swap exits 0. Unknown submission or receipt outcome exits 1 without retry.

## Troubleshooting and removed options

- **Cannot reach engine:** start `bun run engine`; verify endpoint and port.
- **RPC variable missing:** use `chains`, set the named variable, and restart the engine.
- **Wrong chain ID:** use an RPC for the TOML chain; renaming the key does not change network identity.
- **No quote route:** inspect provider errors and partial-search warning; check support, RPC availability, and rate limits.
- **Preparation rejected or expired:** request a fresh quote and route. Do not reuse an old preparation.
- **Receipt unavailable:** keep the printed hash and inspect it before rerunning.

`bun run engine` replaces `bun run dev`. `EPEIUS_ENVIRONMENT`, `EPEIUS_RPC_URL`, `EPEIUS_LISTEN_ADDR`, and `EPEIUS_ENGINE_URL` are no longer used. `--environment` was replaced by `--chain`. Informational quotes do not accept `--sender`, `--recipient`, or `--slippage-bps`. `StreamQuote` is not implemented.
