# Plan 001: Establish the terminal and quote-engine foundation

Status: implemented and locally verified.

> Epeius is a proof of concept trading terminal and quote engine for EVM, currently targeting Base.

## Scope

Build the repository, CLI/service connection, shared API, network verification, launch commands, tests, CI, and a short README. Quotes and swaps remain unimplemented.

The latest decision replaces fork work with read-only Base mainnet and Base Sepolia testing. Do not add Anvil, fork configuration, fork scripts, or fork acceptance gates. Sepolia connectivity does not prove DEX availability or liquidity.

## Structure

```text
apps/terminal/
  src/
  package.json
  tsconfig.json
services/quote-engine/
  cmd/epeius-engine/
  internal/rpc/
  internal/quote/
  go.mod
  go.sum
proto/epeius/quote/v1/quote.proto
generated/go/
generated/ts/
scripts/
.github/workflows/ci.yml
package.json
bun.lock
buf.yaml
buf.gen.yaml
biome.json
.env.example
.gitignore
README.md
```

The terminal owns input, Connect client calls, and output. The Go entry point wires the service; `internal/rpc` verifies EVM RPC access. `internal/quote` initially contains contract integration tests. Use the generated unimplemented handler directly rather than adding a pass-through production wrapper.

Keep the engine Go module under `services/quote-engine`. Shared Go bindings have a small module under `generated/go`, referenced through a local `replace`. One Bun workspace and root lockfile cover the terminal. The root declares the Protobuf runtime used by generated TypeScript outside the terminal package.

Do not create empty provider, routing, scoring, discovery, or contract directories.

## API and implementation

Use Bun/TypeScript, Go `net/http`, Connect-Go/Connect-ES, Protobuf/Buf, and go-ethereum RPC/ethclient. Pin dependencies and generators. Generated bindings are checked in.

Keep QuoteService's three methods:

- `GetQuote(QuoteRequest) -> QuoteFinal`
- `StreamQuote(QuoteRequest) -> stream QuoteEvent`
- `PrepareExecution(PrepareExecutionRequest) -> PrepareExecutionResponse`

The request carries environment, sender, recipient, token addresses, atomic input amount, slippage basis points, and search budget. Stream events distinguish route results, provider errors, and final results. Missing cost is distinct from zero. Preparation selects quote ID and route ID; future transaction data is unsigned only. Amounts are integer strings, never floating point.

All production methods return Connect `Unimplemented`. No fake successful quotes, READY responses, GetStatus/doctor API, or Execute RPC. CLI `quote` reports the expected error and exits 1. CLI `execute` reports unsupported execution without signing or sending. Token-symbol lookup and decimal conversion are deferred; input uses addresses and atomic units.

## Entry points

Run from the repository root:

```bash
bun install --frozen-lockfile
bun run setup
bun run generate
cp .env.example .env
bun run dev
```

`setup` prepares Go dependencies and pinned local generators. `dev` builds and starts Go, waits for verified readiness, and displays the terminal startup view in the Bun process. Ctrl+C stops its engine. It does not install dependencies or generate code implicitly.

Separate commands: `bun run engine`, `bun run terminal -- quote --help`, `bun run check`, `bun run check:generated`, and `bun run smoke`.

Root Bun commands load `.env` and pass values to Go. The Go executable itself requires exported variables. Process failures produce nonzero exits; cleanup affects only owned children. Never log credential-bearing URLs.

## Environments

- `base-mainnet`: chain ID 8453; public example endpoint `https://mainnet.base.org`.
- `base-sepolia`: chain ID 84532; public example endpoint `https://sepolia.base.org`.

Both are read-only. Explicit `EPEIUS_ENVIRONMENT` and `EPEIUS_RPC_URL` must agree. Startup verifies chain ID and reads a block header within a deadline before reporting ready. Missing configuration, wrong chain, and unavailable RPC fail clearly, without fallback. Loopback is required for the local engine listener. Public RPC endpoints are rate-limited and may be replaced by operator-provided endpoints.

No keys or test ETH are required. Future signing must verify its own endpoint; startup checks alone do not authorize transactions.

## Verification

Credential-free checks cover:

- Actual Bun clients calling actual Go Connect handlers for all three methods.
- Test-only finite streams with ordered messages and completion.
- Cancellation and deadline propagation, including stopped server work.
- Network checks, RPC failures, and credential-safe errors.
- CLI unit bounds and preservation of amounts above JavaScript integer precision.
- Process readiness, failure, and shutdown without affecting unrelated services.
- Formatting, lint, TypeScript checks, Go race tests, builds, and repeatable generation.

The live smoke command starts its own engine, verifies the configured network, invokes the CLI, asserts the specific Unimplemented result, and cleans up. Run it separately on both Base mainnet and Base Sepolia. Report connectivity evidence separately from local tests; no claims about quoting or swaps.

CI runs credential-free checks and generation consistency. No deployment workflow. Verify documented installation and commands from an isolated source copy without existing dependencies or build output.

## README

Use the product sentence above. Include current capabilities, prerequisites, quick start, network configuration, commands, a short layout, and limitations. Do not include private motivation, intended recipients, comparisons to another trading product, or claims about engineering quality. No AI attribution or tool metadata.

## Done and deferred work

Done when the documented setup works, both networks pass live smoke checks, process cleanup and transport behavior are tested, and all checks/builds pass. Missing live RPC access is a blocked check, never a silent success.

Next milestone: first real exact-input Uniswap V3 quote at a pinned Base block through GetQuote. Provider adapters, ranking, business-level streaming, execution, synthetic liquidity, forks, custom contracts, databases, and deployments remain outside this foundation.

## Verified outcome

The documented frozen install, setup, generation, checks/builds, and live smoke commands passed from an isolated source copy with no existing node_modules, local generators, or build output. Seven Bun tests passed, alongside Go race tests and real Bun-to-Go stream/cancellation tests. Generation verification also rejected an extra stale generated file.

Live read-only checks passed for Base mainnet (8453) and Base Sepolia (84532). No transactions were sent. Hosted CI has not run. Linux was exercised; macOS was not tested.

Bun 1.3.7 was observed to disable an existing SIGINT handler when another handler was removed. The launcher owns OS signal handling and passes AbortSignal to subprocess work; repeated shutdown tests pass with this approach.
