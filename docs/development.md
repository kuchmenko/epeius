# Development tooling

## Repository setup

Requires Bun 1.3.9 and Go 1.26.4:

```bash
bun install --frozen-lockfile
bun run setup
bun run generate
```

`setup` installs pinned Go generators in `.tools/bin` and downloads Go modules. No global protocol generator is needed. `generate` updates checked-in Go and TypeScript bindings from `proto/epeius/quote/v1/quote.proto`. Edit the proto, not generated files.

Testnet tooling has a separate lockfile and dependency directory:

```bash
bun install --cwd scripts/testnet --frozen-lockfile --ignore-scripts
bun scripts/testnet/prepare.mjs
bun test scripts/testnet
```

`--cwd scripts/testnet` keeps its `node_modules` local and uses `scripts/testnet/bun.lock`, separate from root workspace dependencies. `--ignore-scripts` prevents dependency lifecycle scripts. See [Testnet harness and contracts](testnet.md) before running network commands.

## Verification

```bash
bun run check
bun run check:generated
bun run smoke
forge test --root contracts
```

- `check` runs Biome, TypeScript checks, Go race tests, Bun tests, and builds.
- `check:generated` regenerates bindings in a temporary directory and compares them with checked-in files.
- `smoke` uses root TOML endpoint and an already running engine. It requires every engine chain to be connected and checks positive Base WETH/USDC quotes in both directions. It is read-only and does not stop the engine.
- `forge test` runs local contract tests, including authentic Pancake partial-input behavior. It does not deploy to Base Sepolia.

CI uses credential-free local RPC and Connect fixtures. Live testnet checks are separate. Passing local or dev checks is not evidence of production behavior.

## Output locations

| Path or stream | Producer | Interpretation |
| --- | --- | --- |
| `dist/epeius-engine` | engine build | Local Go executable; rebuilt by `bun run engine` |
| `generated/go/`, `generated/ts/` | `bun run generate` | Checked-in protocol bindings; `check:generated` detects drift |
| `.tools/bin/` | `bun run setup` | Ignored pinned generators |
| stdout/stderr | check and smoke commands | Child output is inherited or summarized; nonzero exit means a check failed |
| `contracts/out/`, `contracts/cache/` | Forge build/tests | Ignored compiler artifacts and cache |
| `.testnet/` | harness preparation, deployment, and E2E | Ignored artifacts and sensitive recovery records; see [testnet output](testnet.md#outputs-and-interpretation) |

`bun run smoke` prints each connected chain, quote summaries, and `Read-only smoke check passed. No transactions sent.` only after all checks pass. A failing run prints a short diagnostic to stderr and exits nonzero.

## Layout

```text
epeius.toml                       Runtime settings and chain definitions
apps/terminal/src/                CLI, config, formatting, signing, receipt checks
services/quote-engine/
  cmd/epeius-engine/              Server and local chain inspection commands
  internal/config/                Strict TOML loading and validation
  internal/rpc/                   Chain verification and pinned reads
  internal/quote/                 Status, quote, preparation, and simulation
  internal/providers/uniswapv3/   Direct Uniswap/Pancake V3 quote calls
proto/epeius/quote/v1/            Connect service contract
generated/go/                     Generated Go module
generated/ts/                     Generated TypeScript bindings
contracts/                        Test tokens, liquidity helper, Pancake bootstrap, tests
scripts/testnet/                  Isolated Bun harness workspace
scripts/                          Launch, generation, checks, smoke, and E2E runner
docs/                             Unified documentation
```
