# Epeius

Epeius is a proof of concept trading terminal and quote engine for EVM, currently targeting Base.

One Go engine serves all chains configured in `epeius.toml`. The Bun terminal calls it over ConnectRPC. Quotes currently support direct Uniswap V3 WETH/USDC routes on Base mainnet, in both directions. Base Sepolia supports connectivity checks only. No wallet keys, signing, or transaction sending are supported.

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

Adding a TOML chain enables connectivity checks without changing a chain enum. It does **not** add quote support: providers, deployed contracts, and supported pairs must also exist. Contract configuration is deferred.

## Commands

| Command | Purpose | Running engine needed |
| --- | --- | --- |
| `bun run engine` | Build and start all configured chains | No |
| `bun run terminal -- chains` | List configured chains and whether RPC variables are set; no network calls | No |
| `bun run terminal -- chain check base` | Verify one chain's RPC and read a block | No |
| `bun run terminal -- status` | Show all chains known to the engine | Yes |
| `bun run terminal -- tokens --chain base` | List supported token addresses, symbols, and decimals | Yes |
| `bun run terminal -- quote ...` | Request an informational exact-input quote | Yes |
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
- **Unsupported quoting:** a connected network is not necessarily quote-supported. Use Base WETH/USDC for this milestone.
- **RPC failure or partial search:** inspect the route errors; check provider availability and rate limits. The engine never substitutes another endpoint.
- **Old engine/client:** restart using the updated checkout. This protocol update requires matching engine and terminal versions.

`bun run engine` replaces `bun run dev`. The old `EPEIUS_ENVIRONMENT`, `EPEIUS_RPC_URL`, `EPEIUS_LISTEN_ADDR`, and `EPEIUS_ENGINE_URL` settings are no longer used. Move endpoint settings to TOML and RPC credentials to the per-chain variables.

`--environment` is replaced by `--chain`. `--sender`, `--recipient`, and `--slippage-bps` were removed from informational quotes because they did not affect QuoterV2 output. They are not silently ignored. Quotes do not promise an executable minimum output. `execute`, `StreamQuote`, and `PrepareExecution` remain unimplemented.

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

The search covers fee tiers 100, 500, 3000, and 10000 pips at one canonical block hash. Results follow fee order, not economic rank. `searchComplete` means all candidate attempts finished within the budget; individual failures remain in `errors`. RPCs must support EIP-1898 block-hash calls; there is no fallback to latest state. Gas pricing, economic scoring, additional venues, intermediate or split routes, execution, forks, caches, databases, and indexing remain outside this milestone.

Generated files are checked in. Edit the proto and run `bun run generate`, not the generated code. Removed request field numbers are reserved and are not reused.
