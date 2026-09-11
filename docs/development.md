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

- `check` runs Biome, TypeScript checks, Go race tests, Bun tests, and builds. It also requires Foundry 1.5.0: the mocked seed preflight test uses `cast` for local ABI encoding and hashing, without signing or network submission.
- `check:generated` regenerates bindings in a temporary directory and compares them with checked-in files.
- `smoke` uses root TOML endpoint and an already running engine. It requires every engine chain to be connected and checks positive Base WETH/USDC quotes in both directions. It is read-only and does not stop the engine.
- `forge test` runs local executor and harness tests, including authentic Uniswap/Pancake partial-input behavior. Use `forge test --root contracts --fuzz-runs 10000` for the larger valid-allocation fuzz run. It does not deploy to Base Sepolia.

CI uses credential-free local RPC and Connect fixtures. Live testnet checks are separate. Passing local or dev checks is not evidence of production behavior.

`check` already includes Go vet/race and the Bun/Go Connect transport test; do not rerun those suites merely under different command names. Build the local harness prerequisites above before claiming the optional dry-deploy fixture passed rather than skipped. ABI regression evidence must remain independent: production terminal encoding uses a pinned ABI library, while Go ABI, Cast, and stored golden vectors check the same bytes. Do not generate expected test vectors with the production terminal encoder. Strict decimal parsing remains separate from ABI encoding.

For execution review, run the CLI with local Connect/RPC fixtures and a stub Cast, capturing stderr and stdout separately. Exercise approval, direct swap, split allocation, rejection, and non-TTY refusal. Check call order, no-send paths, one send, hash-before-wait, and JSONL values in execution evidence; inspect rendered terminal captures for readable full addresses and exact amounts. A screenshot alone does not prove transaction behavior. No live wallet or Tenderly request is needed for these checks.

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

## Terminal execution modules

`main.ts` dispatches commands and maps typed results to the existing exit codes. `execution-command.ts` connects config, wallet, RPC, prompts, and JSONL output. `execution.ts` runs preparation, validation, consent, immutable recheck, one handoff, and verification using supplied operations. `execution-policy.ts` independently checks local configuration, amounts, calldata, and receipt deltas. `trade.ts` refreshes only after `approval-confirmed`; it does not infer approval success from an output callback.

`ExecutionResult` distinguishes `preview`, `canceled`, `approval-confirmed`, `swap-verified`, `failed`, and `unknown`. Known submitted outcomes keep their transaction hash. Pre-send validation errors still reach the CLI error path. Preview and verified approval/swap map to exit 0; cancellation, failure, and unknown map to exit 1. A trade is complete only after a verified swap, not after approval. `ExecutionEvent` types the existing machine payloads without changing their wire fields.

`config.ts` owns TOML parsing and conditional normalization for the terminal and E2E runner. `wallet-cast.ts` owns credentials, account discovery, and Cast submission; `chain.ts` owns read-only RPC and canonical receipt polling. `format.ts` renders human review with checked token metadata. No wallet registry, generic plugin layer, JavaScript private keys, WalletConnect, or account-abstraction implementation is present.
