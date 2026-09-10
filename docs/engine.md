# Engine

The Go engine owns configuration validation, RPC connectivity checks, deterministic route search, unsigned transaction construction, and Tenderly simulation. It never holds keys, signs, or submits transactions. The Bun launcher builds the binary, starts it, and formats its readiness event.

## Start and stop

```bash
bun run engine
bun run engine -- --config /absolute/path/to/epeius.toml
```

`bun run engine` builds `dist/epeius-engine` before starting it. It does not install dependencies or regenerate protocol bindings. Ctrl+C sends a graceful stop and releases the loopback port.

The launcher prints its endpoint and each chain's startup state to stdout. Startup failures and unexpected exits go to stderr. It does not create a log file. Redirect streams in the shell if persistent process logs are needed; this does not change application output contracts.

The first engine stdout line is an internal JSON readiness event consumed by the launcher. Direct binary users may see it. `event: "ready"` means the server is listening, not that every configured chain connected. Inspect each `chains` entry.

## Configuration

Default configuration is `./epeius.toml` in the current working directory. There is no parent search, config merge, or hot reload. TOML is loaded when the process starts; restart the engine and terminal after changing it.

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
```

Keep RPC URLs in ignored environment files, not TOML:

```dotenv
BASE_RPC_URL=https://mainnet.base.org
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
```

Bun loads repository `.env` files and passes the environment to Go. Exported variables take precedence. The Go executable does not load `.env`. To use another file:

```bash
bun --env-file=/absolute/path/to/.env scripts/engine.ts
```

Remote RPC URLs require HTTPS. HTTP is allowed only for loopback IPs and `localhost`. The server itself binds only to a loopback IP. RPC URL values and credentials are not returned in status output.

Unknown TOML fields are rejected. Chain keys use lowercase letters, digits, and hyphens and start with a letter. IDs are positive integers no larger than 9,007,199,254,740,991. Distinct keys may describe the same network ID with different RPCs or deployments; requests select the key and verify its network ID. `terminal.default_chain` must exist. If the listen port changes, update `terminal.engine_url` or pass the terminal's `--engine-url` option.

Adding a positive chain ID enables connectivity checks only. Quotes also require explicit TOML token and deployment allowlists. Supported deployments use `kind = "uniswap-v3"` or `kind = "pancake-v3"` plus TOML-provided `factory`, `quoter`, `router`, and `fees`. These kinds select supported implementations; they do not allow arbitrary ABIs or calldata. There are no built-in Base WETH, USDC, Uniswap, contract-address, fee-list, or provider defaults. The former limits of five tokens and eight fees are removed. Tokens must remain unique and valid; deployment fees must be unique and in the protocol range 0 through 999,999. Fee 0 works only when the configured factory actually has that pool.

Execution may be enabled for any configured positive chain ID with `execution_enabled = true`, at least two tokens, and at least one deployment. Engine status, terminal TOML, terminal RPC, and prepared transaction must agree on chain identity before submission. This supersedes the earlier milestone policy that fixed execution to Base Sepolia. Base Sepolia remains the verified and default test setup; every newly introduced network or provider still needs capability and simulation-support validation before live use. The checked-in root configuration keeps `execution_enabled = false` for all chains.

Execution simulation requires `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT_SLUG`, and `TENDERLY_PROJECT_SLUG` in the engine's private environment. Informational quotes do not require Tenderly. Never put these values in TOML, logs, or committed files. Restart the engine after changing its environment.

## Startup status

The engine checks all RPCs in parallel at startup. Each check has a 10-second timeout and verifies the returned chain ID. One failed chain remains unavailable while other chains can run; startup fails if every chain fails.

`connected` and the displayed block describe startup verification, not continuous monitoring. After fixing an unavailable RPC, restart the engine. There is no automatic retry, reconnect, or provider fallback.

Use local inspection commands without a running server:

```bash
bun run terminal -- chains
bun run terminal -- chain check base
```

`chains` shows whether each referenced environment variable is set and makes no network call. `chain check` verifies one RPC and reads a block. With `--json`, failed checks still emit their structured result to stdout and exit 1; diagnostics remain on stderr.

## Quote search

The engine pins one canonical block hash and searches every configured deployment, direct path, two-hop path, and fee combination. One-hop and two-hop routes are the current capability; arbitrary-length routes are not supported. Results stay in deterministic deployment/path order; they are not ranked by economic value. `searchComplete` means every candidate attempt finished within the budget, not that every attempt succeeded. Per-route failures remain in `errors`.

RPCs must support EIP-1898 block-hash calls. There is no fallback to latest state. Gas pricing, economic ranking, split routes, Slipstream execution, custom executors, databases, and indexing are outside the current engine.

## Troubleshooting

- **No readiness:** read stderr, validate TOML, and check that at least one RPC variable is set to the correct network.
- **Chain unavailable:** run `chain check`, fix its RPC URL or chain ID, then restart the engine.
- **Connected but quotes unsupported:** configure tokens and a supported deployment. Connectivity alone does not add quote support.
- **Partial search or route errors:** inspect terminal `errors`; check provider availability and rate limits. The engine never swaps to another endpoint.
- **Terminal cannot connect:** compare `terminal.engine_url` with the endpoint printed by the launcher.
- **Old client and engine:** restart both from the same checkout. Protocol changes require matching generated bindings.
