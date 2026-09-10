# Epeius

Epeius is a proof of concept trading terminal and quote engine for EVM, currently targeting Base.

The foundation connects a Bun/TypeScript terminal to a Go service over ConnectRPC. The engine checks the selected network and reads its latest block. **Quotes and execution are not implemented yet.** No keys, signing, or transaction sending are supported.

## Quick start

Requires **Bun 1.3.7** and **Go 1.26.4**, on Linux or macOS. Run commands from the repository root.

```bash
bun install --frozen-lockfile
bun run setup
bun run generate
cp .env.example .env
bun run dev
```

The example configuration uses the public Base Sepolia RPC. Startup shows the verified network, block, and engine address. Keep it running and use a second terminal for commands. Ctrl+C stops the engine.

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

`quote` accepts explicit token addresses, atomic input amount, sender, recipient, slippage, and search budget. It calls the real API, reports `unimplemented`, and exits 1. `execute` also exits 1 without signing or sending. Token-symbol lookup and decimal amount conversion are not available yet.

`smoke` starts its own engine on a free port, verifies RPC startup, and checks the CLI receives the expected `unimplemented` error. It exits 0 only for that expected result and stops its engine. Its sample addresses are transport inputs, not claims about deployed tokens or liquidity.

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
  internal/rpc/                  Network verification
  internal/quote/                Contract integration tests
proto/epeius/quote/v1/            QuoteService contract
generated/go/                    Generated Go module
generated/ts/                    Generated TypeScript bindings
scripts/                         Local launch and check commands
```

`QuoteService` exposes `GetQuote`, finite `StreamQuote`, and `PrepareExecution`. All currently return `Unimplemented`. Generated files are checked in; edit the proto and run `bun run generate`, not the generated code.

CI runs credential-free tests, including real Bun-to-Go streaming, cancellation, and local RPC fixtures. Live smoke checks are separate. No fork, DEX adapter, wallet, custom contract, or deployment is included in this milestone.
