# Development tooling

## Repository setup

Requires Bun 1.3.9 and Go 1.26.4:

```bash
bun install --frozen-lockfile
bun run setup
bun run generate
```

`setup` installs pinned Go generators and Staticcheck in `.tools/bin` and downloads Go modules. No global protocol generator is needed. `generate` updates checked-in Go and TypeScript bindings from `proto/epeius/quote/v1/quote.proto`, plus contract ABI projections from `contracts/abi`. Edit the canonical inputs, not generated files. [ABI provenance and update instructions](../contracts/abi/README.md) describe the pinned router versions, upstream licenses, hashes, and independent encoding checks. Generation reads local files only; it never downloads an ABI or accepts one from the engine.

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

- `check` runs Biome, TypeScript checks, Go vet, Staticcheck for the first-party quote engine, Go race tests, Bun tests, and builds. Staticcheck inherits its default checks except ST1005 because fixed outward simulation messages are sentence-style protocol text. Generated Go remains covered by formatting, vet, race, and generated-file drift checks, not Staticcheck. Run `bun run setup` first so the pinned Staticcheck binary is available. It also requires Foundry 1.5.0: the mocked seed preflight test uses `cast` for local ABI encoding and hashing, without signing or network submission.
- `check:generated` regenerates protobuf bindings in a temporary directory and compares them with checked-in files. It also checks canonical ABI hashes and compares deterministic TypeScript projections and Go embedded mirrors. `check` includes the same ABI drift check.
- `smoke` uses root TOML endpoint and an already running engine. It requires every engine chain to be connected and checks positive Base WETH/USDC quotes in both directions. It is read-only and does not stop the engine.
- `forge test` runs local executor and harness tests, including authentic Uniswap/Pancake partial-input behavior. Use `forge test --root contracts --fuzz-runs 10000` for the larger valid-allocation fuzz run. Run `forge fmt --check contracts/src/Executor.sol contracts/test/Executor.t.sol contracts/test/ExecutorRouters.t.sol` to check the maintained Solidity sources. Neither command deploys to Base Sepolia.

CI uses credential-free local RPC and Connect fixtures. Live testnet checks are separate. Passing local or dev checks is not evidence of production behavior.

Pull requests also run `buf breaking` against `main`. CI runs on pull requests and pushes to `main`; newer runs for the same pull request cancel older runs. Keep the existing `foundation` and `harness` job names stable when configuring required checks.

`check` already includes Go vet/race and the Bun/Go Connect transport test; do not rerun those suites merely under different command names. Build the local harness prerequisites above before claiming the optional dry-deploy fixture passed rather than skipped. ABI regression evidence must remain independent: production terminal encoding uses a pinned ABI library, while Go ABI, Cast, and stored golden vectors check the same bytes. Do not generate expected test vectors with the production terminal encoder. Strict decimal parsing remains separate from ABI encoding.

For execution review, run the CLI with local Connect/RPC fixtures and a stub Cast, capturing stderr and stdout separately. Exercise approval, direct swap, split allocation, rejection, and non-TTY refusal. Check call order, no-send paths, one send, hash-before-wait, and JSONL values in execution evidence; inspect rendered terminal captures for readable full addresses and exact amounts. A screenshot alone does not prove transaction behavior. No live wallet or Tenderly request is needed for these checks.

## Output locations

| Path or stream | Producer | Interpretation |
| --- | --- | --- |
| `dist/epeius-engine` | engine build | Local Go executable; rebuilt by `bun run engine` |
| `generated/go/`, `generated/ts/` | `bun run generate` | Checked-in protocol bindings; `check:generated` detects drift |
| `generated/abi/`, `services/quote-engine/internal/contractabi/` | `bun scripts/abi.ts` or `bun run generate` | Typed TS ABIs and embedded geth ABIs generated from `contracts/abi`; never edit mirrors |
| `.tools/bin/` | `bun run setup` | Ignored pinned Go tools |
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

## Extension rules

Keep Ethereum mechanics in viem on the Bun/TypeScript side and go-ethereum on the Go side. Application code still defines strict input admission, canonical receipt acceptance, exact economic deltas, immutable terms and no-resend policy. A convenience SDK action is not a reason to change those contracts: use lower-level SDK calls when its defaults differ. Cast remains the encrypted signer adapter; Tenderly remains a separate vendor API.

Adding a compatible EVM network normally adds configuration and capability verification. Adding a deployment of an existing protocol normally adds its trusted configuration. A new protocol implementation owns its candidate generation, quote/requote, deployment checks, transaction encoding and route admission; common scheduling, ranking, preparation lifecycle and consent should not acquire another protocol switch. The terminal selects its own trusted implementation and validates calldata independently of the engine.

Protocol kind, deployment ID and executor venue are separate identities. The existing executor's two immutable slots do not grow when another deployment of the same kind is configured. Another executor version needs its own implementation and verified contract; it must not widen the old membership checks.

Extension does not mean every unknown feature fits the current wire model. Mixed-protocol hops, native assets, exact-output swaps, automatic split selection and multiple transactions need explicit product/model decisions. The current one-deployment route, exact-input ERC20 policy and fixed executor limits remain in force. Test-only alternate implementations should prove extension without shipping a new protocol or relaxing independent trust checks.
