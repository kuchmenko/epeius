# Epeius

Epeius is a proof of concept trading terminal and quote engine for EVM, currently targeting Base.

The Bun/TypeScript terminal calls a Go service over ConnectRPC. Base mainnet quoting supports direct WETH/USDC routes in both directions. No keys, signing, or transaction sending are supported.

## Quick start

Requires **Bun 1.3.7** and **Go 1.26.4**, on Linux or macOS. Run commands from the repository root.

```bash
bun install --frozen-lockfile
bun run setup
bun run generate
cp .env.example .env
bun run dev
```

The example configuration uses the public Base Sepolia RPC. It verifies connectivity only; quoting is unsupported there. For quotes, configure Base mainnet below. Startup shows the verified network, block, and engine address. Keep it running and use a second terminal for commands. Ctrl+C stops the engine.

`setup` downloads Go dependencies and pinned generators into `.tools/bin`. Buf and TypeScript tooling come from the Bun lockfile; no global installation is needed. `dev` builds the Go executable but does not install dependencies or regenerate code.

## Networks

Set both values in `.env`:

```dotenv
# Base Sepolia (chain ID 84532)
EPEIUS_ENVIRONMENT=base-sepolia
EPEIUS_RPC_URL=https://sepolia.base.org
```

For Base mainnet (chain ID 8453):

```dotenv
EPEIUS_ENVIRONMENT=base-mainnet
EPEIUS_RPC_URL=https://mainnet.base.org
```

Both are **read-only**. Wrong-chain RPCs fail startup. Public endpoints are rate-limited; use your provider URL if needed. Keep credentials in `.env`, which Git ignores. No test ETH is required.

`mainnet.base.org` can rate-limit a four-tier search. `https://base-rpc.publicnode.com` is another public Base mainnet endpoint; select it explicitly through `EPEIUS_RPC_URL`. There is no automatic retry or provider fallback.

Optional settings: `EPEIUS_LISTEN_ADDR` defaults to `127.0.0.1:8080`; `EPEIUS_ENGINE_URL` defaults to `http://127.0.0.1:8080`. Change both when selecting a different port. The engine only binds loopback IPs.

Root Bun commands load `.env` and pass it to Go. Exported environment variables take precedence. Running the Go binary directly requires exported variables; it does not read `.env`.

## Commands

```bash
bun run dev                       # Engine and terminal startup view
bun run engine                    # Engine only, with JSON readiness output
bun run terminal -- quote --help   # CLI options
bun run check                     # Formatting, lint, types, tests, builds
bun run check:generated            # Compare bindings against fresh generation
bun run smoke                     # Read-only live check using the selected network
```

`quote` accepts explicit token addresses and an atomic input amount. It exits 0 when at least one route is returned, otherwise 1. Human output includes exact decimal and atomic amounts, block data, fee tiers, pools, and provider errors. Add `--json` for protobuf JSON. `execute` exits 1 without signing or sending.

The terminal retains a 5-second transport deadline. Use a smaller search budget to receive partial results before that deadline; client cancellation or deadline expiry fails the request rather than returning partial data.

With engine running against Base mainnet, quote 1 WETH to native USDC:

```bash
bun run terminal -- quote \
  --environment base-mainnet \
  --sender 0x1111111111111111111111111111111111111111 \
  --recipient 0x1111111111111111111111111111111111111111 \
  --in 0x4200000000000000000000000000000000000006 \
  --out 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --amount-atomic 1000000000000000000 \
  --slippage-bps 50 \
  --search-budget-ms 2000
```

For 100 USDC to WETH, swap `--in` and `--out` and use `--amount-atomic 100000000`. Addresses and atomic units remain explicit.

`smoke` starts its own engine on a free port. On mainnet it checks positive WETH/USDC quotes in both directions; on Sepolia it checks connectivity and explicit rejection of quoting. It stops its engine when done.

For either network without changing `.env`:

```bash
EPEIUS_ENVIRONMENT=base-mainnet EPEIUS_RPC_URL=https://mainnet.base.org bun run smoke
EPEIUS_ENVIRONMENT=base-sepolia EPEIUS_RPC_URL=https://sepolia.base.org bun run smoke
```

## Layout

```text
apps/terminal/                    Bun CLI and Connect client
services/quote-engine/            Go module
  cmd/epeius-engine/              Engine entry point
  internal/rpc/                  Network verification and pinned reads
  internal/quote/                Quote handler and transport tests
  internal/providers/uniswapv3/   Direct quotes and original local ABIs
proto/epeius/quote/v1/            QuoteService contract
generated/go/                    Generated Go module
generated/ts/                    Generated TypeScript bindings
scripts/                         Local launch and check commands
```

`GetQuote` searches fee tiers 100, 500, 3000, and 10000 pips at one canonical block hash. This is a limited candidate set, not every pool on Base. Results follow fee order, not economic rank. `searchComplete` means all candidate attempts finished within the budget; individual failures remain in `errors`. A partial search retains finished quotes. RPCs must support EIP-1898 block-hash calls; the engine never falls back to latest state.

Sender, recipient, and slippage are validated inputs but do not affect QuoterV2's raw output. Quotes are informational, not executable minimum-output guarantees. `StreamQuote` and `PrepareExecution` remain unimplemented. Generated files are checked in; edit the proto and run `bun run generate`, not the generated code.

CI runs credential-free tests, including Bun-to-Go transport and local RPC fixtures. Live smoke checks are separate.
