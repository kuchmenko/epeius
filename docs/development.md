# Development tooling

## Repository setup

Requires Bun 1.3.9 and Go 1.26.4:

```bash
bun install --frozen-lockfile
bun run setup
bun run generate
```

`setup` installs pinned Go generators and Staticcheck in `.tools/bin` and downloads Go modules. No global protocol generator is needed. `generate` creates ignored Go and TypeScript bindings from `proto/epeius/quote/v1/quote.proto`, plus ABI projections from `contracts/abi`. Canonical inputs, generator configuration, dependency locks and `generated/go/go.mod`/`go.sum` remain tracked; generated source files do not. [ABI provenance and update instructions](../contracts/abi/README.md) describe the pinned router versions, upstream licenses, hashes, and independent encoding checks. Generation reads local files only; it never downloads an ABI or accepts one from the engine. Initial dependency/tool installation may need network access; generation works offline once prerequisites are installed.

`bun run engine`, `terminal`, `smoke` and `e2e` generate before loading their source entrypoint; `bun run check` generates before typechecking, testing and building. Run `bun run generate` first when invoking `go build`, `go test`, `bun test` or a source file directly. Go embeds the local ABI mirrors at compile time; a source archive or container build must generate them before compiling. The compiled engine needs no code generator or ABI files at runtime. Do not remove generated files from an in-progress build context.

Testnet tooling has a separate lockfile and dependency directory:

```bash
bun install --cwd scripts/testnet --frozen-lockfile --ignore-scripts
bun scripts/abi.ts
bun scripts/testnet/prepare.mjs
bun test scripts/testnet
```

`--cwd scripts/testnet` keeps its `node_modules` local and uses `scripts/testnet/bun.lock`, separate from root workspace dependencies. `--ignore-scripts` prevents dependency lifecycle scripts. ABI-only generation needs Bun and Go's `gofmt`, but not protobuf plugins. `bun run harness <arguments>` and `bun run --cwd scripts/testnet test` generate ABI outputs before importing harness code. See [Testnet harness and contracts](testnet.md) before running network commands.

## Verification

```bash
bun run check
bun run check:generated
bun run smoke --chain base --in WETH --out USDC --amount 0.01
forge test --root contracts
```

- `check` runs Biome, TypeScript checks, Go vet, Staticcheck for the first-party quote engine, Go race tests, Bun tests, and builds. Staticcheck inherits its default checks except ST1005 because fixed outward simulation messages are sentence-style protocol text. Generated Go remains covered by formatting, vet, race, and generation reproducibility checks, not Staticcheck. Run `bun run setup` first so the pinned Staticcheck binary is available. It also requires Foundry 1.5.0: the mocked seed preflight test uses `cast` for local ABI encoding and hashing, without signing or network submission.
- `check:generated` generates protobuf and ABI outputs twice into separate empty temporary directories and compares their full contents. It validates canonical ABI hashes on both runs. It checks reproducibility without relying on local or committed outputs; it does not claim to detect stale committed bindings, since those are no longer tracked.
- `smoke` uses the TOML endpoint and an already running engine. Pass one explicit configured chain, token pair and positive amount; the command above is an example, not a default. Use `--config <path>` for another configuration. It requires every engine chain to be connected, checks token identities against local configuration, and validates the requested quote's connected route endpoints, pinned block and stable raw-output winner. It is read-only and does not stop the engine. Run a separate invocation to check the reverse direction.
- `forge test` runs local executor and harness tests, including authentic Uniswap/Pancake partial-input behavior. Use `forge test --root contracts --fuzz-runs 10000` for the larger valid-allocation fuzz run. Run `forge fmt --check contracts/src/Executor.sol contracts/test/Executor.t.sol contracts/test/ExecutorRouters.t.sol` to check the maintained Solidity sources. Neither command deploys to Base Sepolia.

CI uses credential-free local RPC and Connect fixtures. Live testnet checks are separate. Passing local or dev checks is not evidence of production behavior.

Pull requests also run `buf breaking` against `main`. CI runs on pull requests and pushes to `main`; newer runs for the same pull request cancel older runs. Keep the existing `foundation` and `harness` job names stable when configuring required checks.

`check` already includes Go vet/race and the Bun/Go Connect transport test; do not rerun those suites merely under different command names. Build the local harness prerequisites above before claiming the optional dry-deploy fixture passed rather than skipped. ABI regression evidence must remain independent: production terminal encoding uses a pinned ABI library, while Go ABI, Cast, and stored golden vectors check the same bytes. Do not generate expected test vectors with the production terminal encoder. Strict decimal parsing remains separate from ABI encoding.

For execution review, run the CLI with local Connect/RPC fixtures and a stub Cast, capturing stderr and stdout separately. Exercise approval, direct swap, split allocation, rejection, and non-TTY refusal. Check call order, no-send paths, one send, hash-before-wait, and JSONL values in execution evidence; inspect rendered terminal captures for readable full addresses and exact amounts. A screenshot alone does not prove transaction behavior. No live wallet or Tenderly request is needed for these checks.

## Output locations

| Path or stream | Producer | Interpretation |
| --- | --- | --- |
| `dist/epeius-engine` | engine build | Local Go executable; rebuilt by `bun run engine` |
| `generated/go/`, `generated/ts/` | `bun run generate` | Ignored protocol bindings; Go module manifests remain tracked |
| `generated/abi/`, `services/quote-engine/internal/contractabi/` | `bun scripts/abi.ts` or `bun run generate` | Ignored typed TS ABIs and embedded geth ABIs generated from `contracts/abi`; never edit mirrors |
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

## Engine implementation contracts

`quote/handler.go` schedules opaque `QuoteCandidate` callbacks from `ProtocolQuoter`; it owns budgets, cancellation, concurrency, stable ordering and raw-output ranking. `v3.go` owns V3 candidate paths and quote/requote; `v3_deployments.go` owns its topology checks. The shared `Reader` requires EVM calls and snapshots, not a V3 provider.

`PreparationStrategy` in `quote/preparation.go` selects a supported route or allocation plan, then builds one transaction, an independent spender and explicit simulation obligations from frozen economic terms. `routers.go` and `executor.go` implement the current variants. `execution.go` stores detached terms and rechecks them without rebuilding calldata. `tenderly.go` consumes balance/allowance probes; it does not infer router or executor policy from a route.

`quote/composition.go` selects shipped implementations. `config.Load` accepts protocol validation supplied by startup; the shipped `config.ValidateV3Chain` checks current V3 and fixed-executor settings. New implementations can live beside the current ones without adding protocol switches to search, preparation lifecycle or simulation. The alternate-implementation test exercises config through quote and preparation with no V3 legs, different target/spender, stable ties and build-once rechecks. It is a test implementation, not a new supported protocol.

Go RPC uses go-ethereum with canonical hash-pinned EIP-1898 calls. ABI decoding uses canonical artifacts and strict re-encoding where needed. Factory address padding, trailing bytes and an out-of-range QuoterV2 uint160 result are now rejected explicitly; the SDK alone does not enforce every ABI integer width.

## Terminal execution modules

`main.ts` dispatches commands and maps typed results to the existing exit codes. `execution-command.ts` connects config, wallet, RPC, prompts, and JSONL output. `execution.ts` builds a validated plan once, then runs consent, immutable recheck, one send, and verification using supplied operations. `execution-policy.ts` owns common trust, amount, expiry and immutable-term checks. `uniswap.ts`, `pancake.ts` and `executor.ts` own their encoding, admission and presentation; `v3.ts` contains shared V3 path rules. `receipt.ts` proves the plan's explicit ERC20 delta obligations. `trade.ts` refreshes only after `approval-confirmed`; it does not infer approval success from an output callback.

`ExecutionResult` distinguishes `preview`, `canceled`, `approval-confirmed`, `swap-verified`, `failed`, and `unknown`. Known submitted outcomes keep their transaction hash. Pre-send validation errors still reach the CLI error path. Preview and verified approval/swap map to exit 0; cancellation, failure, and unknown map to exit 1. A trade is complete only after a verified swap, not after approval. `ExecutionEvent` types the existing machine payloads without changing their wire fields.

Runtime `ExecutionAction`, `VerificationOutcome` and `ExecutionOutcome` constants name the existing string values. Action-specific verification and exhaustive switches prevent a swap proof from becoming an approval result or a new outcome from silently falling through to failure. Wire tests keep literal expected JSONL values independent of these constants.

`config.ts` owns TOML parsing; `readExecutionConfig` receives protocol configuration from explicit `execution-composition.ts` wiring. Protocol-specific selector descriptions come from the selected implementation, not a formatting switch. The alternate-plan test uses a different target and spender, a custom selector and explicit custody obligations without changing the common flow.

`wallet-cast.ts` owns credentials, account discovery, and Cast submission. `chain.ts` uses raw viem RPC requests and canonical receipt polling, with retries/batching disabled and a fresh 15-second abort covering headers and body. It does not delegate canonical acceptance to a convenience waiter. `format.ts` renders human review with checked token metadata. No wallet registry, generic plugin layer, JavaScript private keys, WalletConnect, or account-abstraction implementation is present.

An approval receipt for a different transaction now produces the existing `pending_or_unknown` / `unavailable` event and an internal `unknown` result, retaining the submitted hash. It does not trigger quote refresh or another send. A matching canonical failed receipt remains `failed`. This intentional behavior correction is separate from the structural refactor.

## Extension rules

Keep Ethereum mechanics in viem on the Bun/TypeScript side and go-ethereum on the Go side. Application code still defines strict input admission, canonical receipt acceptance, exact economic deltas, immutable terms and no-resend policy. A convenience SDK action is not a reason to change those contracts: use lower-level SDK calls when its defaults differ. Cast remains the encrypted signer adapter; Tenderly remains a separate vendor API.

Adding a compatible EVM network normally adds configuration and capability verification. Adding a deployment of an existing protocol normally adds its trusted configuration. A new protocol implementation owns its candidate generation, quote/requote, deployment checks, transaction encoding and route admission; common scheduling, ranking, preparation lifecycle and consent should not acquire another protocol switch. The terminal selects its own trusted implementation and validates calldata independently of the engine.

Protocol kind, deployment ID and executor venue are separate identities. The existing executor's two immutable slots do not grow when another deployment of the same kind is configured. Another executor version needs its own implementation and verified contract; it must not widen the old membership checks.

Extension does not mean every unknown feature fits the current wire model. Mixed-protocol hops, native assets, exact-output swaps, automatic split selection and multiple transactions need explicit product/model decisions. The current one-deployment route, exact-input ERC20 policy and fixed executor limits remain in force. Test-only alternate implementations should prove extension without shipping a new protocol or relaxing independent trust checks.
