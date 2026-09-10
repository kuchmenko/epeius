# Epeius

Epeius is a proof of concept trading terminal and quote engine for EVM, currently targeting Base.

One Go engine serves all chains configured in `epeius.toml`. The Bun terminal calls it over ConnectRPC. Configured Uniswap V3 and Pancake V3 deployments support one-hop and two-hop exact-input quotes. Base mainnet remains read-only. Base Sepolia can explicitly enable execution through Tenderly simulation and a local terminal signer.

Read the [execution contract and known limitations](docs/execution.md) before sending transactions. A successful simulation or receipt does not guarantee full input consumption; the first milestone checks actual amounts without a custom executor.

## Quick start

Requires **Bun 1.3.9** and **Go 1.26.4**. Run from the repository root:

```bash
bun install --frozen-lockfile
bun run setup
bun run generate
cp .env.example .env
bun run engine
```

If `.env` already exists, edit it instead of overwriting it. Public RPCs are rate-limited; replace their URLs with your provider's HTTPS URLs if needed. No test ETH is required.

Keep the engine running. In another terminal:

```bash
bun run terminal -- status
bun run terminal -- tokens --chain base
bun run terminal -- quote --chain base --in WETH --out USDC --amount 0.01
```

Ctrl+C stops the engine and releases its port. `engine` builds the Go executable before starting; it does not install dependencies or regenerate bindings. `setup` installs pinned generators into `.tools/bin` and downloads Go dependencies. No global generators are needed.

## Configuration and RPC credentials

`epeius.toml` lives in the repository root:

```toml
[terminal]
default_chain = "base"
engine_url = "http://127.0.0.1:8080"
search_budget_ms = 2000

[engine]
listen_addr = "127.0.0.1:8080"

[chains.base]
chain_id = 8453
rpc_url_env = "BASE_RPC_URL"

[chains.base-sepolia]
chain_id = 84532
rpc_url_env = "BASE_SEPOLIA_RPC_URL"
```

Each chain references its own environment variable. Keep URL values in the ignored `.env` file, not TOML:

```dotenv
BASE_RPC_URL=https://mainnet.base.org
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
```

Bun loads `.env` and passes the environment to Go. Exported variables take precedence. The Go executable does not load `.env` itself. For a file outside the checkout, use an explicit path:

```bash
bun --env-file=/absolute/path/to/.env scripts/engine.ts
```

The default config path is `./epeius.toml` in the working directory. There is no parent-directory search or config merging. Select a different file explicitly:

```bash
bun run engine -- --config /absolute/path/to/epeius.toml
bun run terminal -- status --config /absolute/path/to/epeius.toml
```

Unknown config fields and duplicate chain IDs are rejected. Chain keys use lowercase letters, digits, and hyphens, starting with a letter. IDs are positive integers up to 9,007,199,254,740,991. The default chain must exist in the config. When changing the listen port, update `terminal.engine_url` too, or pass `--engine-url` to the terminal.

The engine checks all configured RPCs in parallel at startup. Each check has a 10-second timeout and verifies the actual chain ID. A failed chain stays unavailable with a reason; other chains can run. If every chain fails, startup fails. `status` shows startup verification, not continuous health monitoring. After fixing an unavailable chain, restart the engine. There is no automatic retry, reconnect, or provider fallback.

Remote RPC URLs require HTTPS; HTTP is allowed only for loopback IPs and `localhost`. The engine binds only to a loopback IP. Credentials and RPC URL values are not included in status output.

Adding a TOML chain enables connectivity checks without changing a chain enum. It does **not** add quote support: configure supported tokens and deployments for that chain. Each deployment has `kind` (`uniswap-v3` or `pancake-v3`), `factory`, `quoter`, `router`, and `fees`. Tokens have `address`, `symbol`, and `decimals`. The checked-in config includes the read-only Base deployment; the testnet harness creates a separate runtime config for its own pools.

## Commands

| Command | Purpose | Running engine needed |
| --- | --- | --- |
| `bun run engine` | Build and start all configured chains | No |
| `bun run terminal -- chains` | List configured chains and whether RPC variables are set; no network calls | No |
| `bun run terminal -- chain check base` | Verify one chain's RPC and read a block | No |
| `bun run terminal -- status` | Show all chains known to the engine | Yes |
| `bun run terminal -- tokens --chain base` | List supported token addresses, symbols, and decimals | Yes |
| `bun run terminal -- quote ...` | Request an informational exact-input quote | Yes |
| `bun run terminal -- prepare ...` | Prepare and simulate, without signing or sending | Yes |
| `bun run terminal -- execute ...` | Confirm and send one approval or swap, then check its receipt | Yes |
| `bun run terminal --help` | Show CLI usage without configuration | No |

`chains` and `chain check` use the Go configuration loader; they build the executable if it is missing. `--config PATH` works on terminal commands. `--engine-url URL` overrides the endpoint for `status`, `tokens`, and `quote`. `--chain` selects a chain, otherwise the terminal uses `terminal.default_chain`. Every quote sends the selected key and chain ID explicitly; the engine rejects mismatches.

Add `--json` to terminal result commands for machine-readable stdout. Quote JSON follows Protobuf JSON conventions, including omission of default-valued fields. Diagnostics go to stderr. `quote` exits 0 when at least one route exists, otherwise 1. `chain check` exits 1 on a failed check; `status` exits 1 if any configured chain is unavailable. Failed chain checks still include their result in JSON stdout.

## Tokens and amounts

Use symbols or addresses. Symbols are case-insensitive and resolved only within the selected chain's supported tokens, supplied by the engine. Unknown or ambiguous symbols fail; `ETH` is not an alias for `WETH`. An address does not bypass pair restrictions.

```bash
# 25 USDC to WETH
bun run terminal -- quote --in USDC --out WETH --amount 25

# 0.01 WETH to USDC, using explicit contracts and atomic units
bun run terminal -- quote --chain base \
  --in 0x4200000000000000000000000000000000000006 \
  --out 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --amount-atomic 10000000000000000 \
  --search-budget-ms 2000 --json
```

Provide exactly one of `--amount` or `--amount-atomic`. Decimal conversion uses token decimals and integer arithmetic, never floating point or rounding. For WETH, `0.01` means `10000000000000000` atomic units; for USDC, `12.345678` means `12345678`. Excess decimal places, scientific notation, zero, negative amounts, and uint256 overflow are rejected.

`--search-budget-ms` overrides the TOML default. It must be between 1 and 2,147,478,647 ms. The quote transport deadline is the budget plus 5 seconds, leaving time to return partial results. Cancellation or transport expiry fails the request rather than returning partial data.

## Troubleshooting and previous CLI versions

- **Engine unavailable:** run `bun run engine`; verify `terminal.engine_url` and the listen port. The terminal never silently starts a server for a quote.
- **RPC variable missing:** run `chains` to find its variable name, set it in `.env`, then restart the engine.
- **Wrong chain ID:** use an RPC for the chain configured in TOML. Changing a key's name does not change network identity.
- **Unsupported quoting:** a connected network is not necessarily quote-supported. Configure tokens and deployments, or use the seeded testnet harness configuration.
- **RPC failure or partial search:** inspect the route errors; check provider availability and rate limits. The engine never substitutes another endpoint.
- **Old engine/client:** restart using the updated checkout. This protocol update requires matching engine and terminal versions.

`bun run engine` replaces `bun run dev`. The old `EPEIUS_ENVIRONMENT`, `EPEIUS_RPC_URL`, `EPEIUS_LISTEN_ADDR`, and `EPEIUS_ENGINE_URL` settings are no longer used. Move endpoint settings to TOML and RPC credentials to the per-chain variables.

`--environment` is replaced by `--chain`. `--sender`, `--recipient`, and `--slippage-bps` are not accepted on informational quotes because they do not affect QuoterV2 output. Execution derives the sender from the local keystore and uses it as recipient. `prepare` and `execute` accept `--slippage-bps`. `StreamQuote` remains unimplemented.

## Preparing and executing on Base Sepolia

Requires Foundry `cast` in addition to Bun and Go. Keep encrypted keystores and their password files outside Git. Do not place private keys in command arguments, engine configuration, or Tenderly requests.

Set `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT_SLUG`, and `TENDERLY_PROJECT_SLUG` in the ignored local environment file. Quotes do not require Tenderly. Execution requires a chain with `chain_id = 84532` and `execution_enabled = true`, configured deployments, funded tokens, and sufficient Base Sepolia ETH for gas. No network writes happen merely from starting the engine.

Using a running engine and a quote's returned IDs:

```bash
bun run terminal -- prepare --chain base-sepolia --config .testnet/runtime.toml \
  --quote-id QUOTE_ID --route-id ROUTE_ID --slippage-bps 50 \
  --keystore /local/path/terminal --password-file /local/path/password

bun run terminal -- execute --chain base-sepolia --config .testnet/runtime.toml \
  --quote-id QUOTE_ID --route-id ROUTE_ID --slippage-bps 50 \
  --keystore /local/path/terminal --password-file /local/path/password
```

`prepare` never sends. `execute` displays the preparation and asks for action-specific confirmation, then rechecks immutable terms before sending. For deliberate noninteractive tests, use **one** of `--confirm-approval yes` or `--confirm-swap yes`. The wrong action is not automatically confirmed.

If approval is required, execution sends only that approval. After confirmation, obtain a fresh quote and select its route before executing the swap. Preparation IDs expire and do not survive an engine restart. The initial application lifetime is 30 seconds; the on-chain swap deadline is 120 seconds from the preparation's chain snapshot. Rechecking does not extend either deadline.

Execution prints JSONL events with the submitted transaction hash and a separate verification result. For standard ERC20 tokens, it checks exact-transaction Transfer net deltas for the wallet's input and output and any intermediate router balance. A pending or unknown result is not permission to resend automatically. Inspect the recorded hash and wallet transactions first.

The live E2E runner uses the seeded A/B/C pools and tests each venue in both directions with one and two hops:

```bash
# List scenarios only; no RPC calls, signer access, or sends.
bun scripts/e2e.ts --config .testnet/runtime.toml

# Explicitly send testnet approvals and swaps through the real terminal.
bun scripts/e2e.ts --config .testnet/runtime.toml --broadcast \
  --keystore /local/path/terminal --password-file /local/path/password
```

The runner records hashes and results in an ignored `.testnet/e2e-*.jsonl` file. It stops at the first failed or inconclusive result. Public testnet trades change pool state; reruns are new trades, not a reset.

## Creating the testnet pools

Harness setup also requires Node.js 22+, npm, Git, and Foundry 1.5.0 (`forge` and `cast`). Its pinned dependencies are separate from the terminal workspace:

```bash
npm ci --prefix scripts/testnet --ignore-scripts
node scripts/testnet/prepare.mjs
npm test --prefix scripts/testnet
forge test --root contracts
```

Preparation downloads pinned Pancake source, verifies that compiled pool creation bytecode matches the released artifact, and builds the harness contracts. These commands do not deploy or spend test ETH. Foundry tests run locally, including actual Pancake pool minting and partial-input consumption.

Use a separate encrypted harness wallet. Replace the addresses and local paths below. `HARNESS_ADDRESS` must match the harness keystore; include it among seed recipients because it pays the token amounts for liquidity. `TERMINAL_ADDRESS` receives test tokens for swaps.

```bash
# Read-only deployment estimates; no signing or broadcasting.
node scripts/testnet/harness.mjs deploy --env /local/path/.env \
  --sender HARNESS_ADDRESS

# Deploy A/B/C, liquidity helper, and authentic Pancake contracts.
node scripts/testnet/harness.mjs deploy --env /local/path/.env \
  --sender HARNESS_ADDRESS --broadcast \
  --keystore /local/path/harness --password-file /local/path/password

# Create and seed pools on the official Uniswap and local Pancake factories.
node scripts/testnet/harness.mjs seed --env /local/path/.env \
  --sender HARNESS_ADDRESS --recipient HARNESS_ADDRESS \
  --recipient TERMINAL_ADDRESS --broadcast \
  --keystore /local/path/harness --password-file /local/path/password

node scripts/testnet/harness.mjs check --env /local/path/.env
node scripts/testnet/harness.mjs config --env /local/path/.env
bun --env-file=/local/path/.env scripts/engine.ts --config .testnet/runtime.toml
```

Omit `--broadcast` from `seed` to inspect its plan first. Gas estimates exclude steps that depend on missing contracts and exclude L1 data fees. The harness rejects any network other than Base Sepolia and checks deployed factory/router links.

The seed gives each explicit recipient 1,000,000 whole A/B/C. A has 18 decimals, B has 6, and C has 8. Each venue gets A/B, B/C, and A/C pools at two fees: broad 500-pip pools for normal swaps and narrow 3000-pip Uniswap / 2500-pip Pancake pools for exhaustion tests. Initial prices are one whole token for one whole token, not equal atomic amounts. The test liquidity helper deliberately has no withdrawal flow; use only disposable test tokens.

Keep `.testnet/manifest.json`: it records signed transactions before submission, receipts, deployed addresses, and pool settings. Rerunning deployment or seeding resumes those recorded steps; it does not reset state or mint the same recipient allocation again. An unconfirmed transaction must be inspected before changing the manifest. Never delete the manifest to recover from a timeout. The generated runtime config contains addresses and environment-variable names, not RPC credentials.

## Verification and layout

```bash
bun run check             # Lint, types, Go race tests, Bun tests, builds
bun run check:generated   # Compare bindings against fresh generation
bun run smoke             # Read-only checks against an already running engine
```

`smoke` uses the root config's terminal endpoint, requires all engine chains to have connected, and checks positive Base WETH/USDC quotes in both directions. It never stops the running engine. CI uses credential-free local RPC and Connect fixtures; live checks are separate.

```text
epeius.toml                       Runtime settings and chain definitions
apps/terminal/src/                Commands, terminal config, token input, output
services/quote-engine/
  cmd/epeius-engine/              Server and local inspection commands
  internal/config/               Strict TOML loading and validation
  internal/rpc/                  Chain verification and pinned reads
  internal/quote/                Multi-chain status and quote handler
  internal/providers/uniswapv3/   Direct quotes and original local ABIs
proto/epeius/quote/v1/            Connect service contract
generated/go/                    Generated Go module
generated/ts/                    Generated TypeScript bindings
scripts/                         Launch, tests, and smoke check
```

The search uses each deployment's configured fees at one canonical block hash. Results follow deterministic deployment/path order, not economic rank. `searchComplete` means all candidate attempts finished within the budget; individual failures remain in `errors`. RPCs must support EIP-1898 block-hash calls; there is no fallback to latest state. Gas pricing, economic scoring, Slipstream execution, split routes, custom executors, forks, databases, and indexing remain outside this milestone.

Generated files are checked in. Edit the proto and run `bun run generate`, not the generated code. Removed request field numbers are reserved and are not reused.
