# Testnet harness and contracts

The harness creates disposable A/B/C fixtures using the checked-in Base Sepolia profile, validates configured official Uniswap deployments, deploys authentic Pancake contracts plus local test contracts, seeds V3 and V4 pools, and writes a runtime config. Network writes require explicit `--broadcast`.

For execution guarantees and the partial-input limitation, read [Execution contract](execution.md). Detailed dependency provenance remains beside the harness in [`scripts/testnet/README.md`](../scripts/testnet/README.md).

## Requirements and setup

Run from repository root. Requires Bun 1.3.9, Go 1.26.4 (including `gofmt` for ABI generation), Git, and Foundry 1.5.0 (`forge` and `cast`).

Harness dependencies use their own `scripts/testnet/bun.lock` and local `scripts/testnet/node_modules`; they are not part of the root workspace install.

```bash
bun install --cwd scripts/testnet --frozen-lockfile --ignore-scripts
bun scripts/abi.ts
bun scripts/testnet/prepare.mjs
bun test scripts/testnet
forge test --root contracts
```

Generated ABIs are ignored build inputs and must exist before harness imports. `bun run harness <arguments>` generates them before launching; direct source invocations below assume the setup above. Before engine, terminal or E2E source commands, also run the root `bun install --frozen-lockfile`, `bun run setup`, and `bun run generate`.

Preparation clones pinned Pancake source to `.testnet/pancake`, rejects checkout changes, compares compiled pool bytecode with the released package artifact, writes `.testnet/PancakeBootstrap.json`, and builds Foundry contracts under `contracts/out` and `contracts/cache`. These commands do not deploy or spend test ETH. `forge test` is local and includes real Pancake partial-consumption and intermediate-residue cases.

Foundry downloads native solc 0.7.6 and 0.8.24 when missing. Pancake uses its own `contracts/pancake/foundry.toml`; its build artifacts and cache stay under `.testnet/pancake-out` and `.testnet/pancake-cache`. Bun runs the scripts, not a WebAssembly compiler.

## Harness profile, environment, and wallets

[`scripts/testnet/harness.toml`](../scripts/testnet/harness.toml) is the default harness profile. It selects the chain key and ID, RPC environment-variable name, WETH address, official Uniswap factory, quoter, router, and position manager, fixture token decimals and pairs, deployment fee lists, and artifact paths. Use `--config PATH` to select another profile. These values are not hidden defaults in harness code; deployment addresses and fee lists used by generated runtime TOML come from the profile or deployment manifest.

The profile is loaded when each harness process starts, not hot-reloaded. A different profile does not establish support for its network or providers. Validate chain capabilities, official contract links, and simulation support before live use. Base Sepolia remains the verified default profile.

The profile's required positive `engine.quote_concurrency` is copied into generated runtime TOML. Seed validates every configured fee's factory tick spacing, pair price/range, liquidity, and mint amount before its first write. These checks enforce V3 and integer bounds, not a token-decimals allowlist; equal-decimal pairs remain valid.

Fixture token symbols and decimals are configured in `fixtures.tokens`; there is no A/B/C-only restriction in deployment or seeding. `fixtures.pairs` maps stable journal identifiers to two distinct token symbols, for example `AB = ["A", "B"]`. Keep existing identifiers unchanged when resuming a deployment. The live E2E script still tests the A/C scenario of the default fixture; it is not a general token discovery tool.

Put the environment variable named by `chain.rpc_url_env` in a private environment file. The default profile names `BASE_SEPOLIA_RPC_URL`. Bun 1.3.9 does not provide `process.loadEnvFile`, so the harness has no `--env` option. Prefix every harness invocation:

```bash
bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs COMMAND ...
```

Use separate encrypted harness and terminal wallets. Keep keystores and password files outside Git with file permissions that exclude group and world access. The harness address must match the harness keystore. Include it as a seed recipient because it pays liquidity token amounts. Terminal wallet receives tokens for swaps.

RPC URL values are not printed or passed to subprocess arguments. Only password-file path reaches Foundry. There is no private-key option or implicit environment wallet. Signing is local with `cast mktx`; submission occurs only with `--broadcast` after configured chain ID, signer, contract links, balance, and gas checks pass.

Ethereum transport, ABI encoding/decoding, CREATE addresses, hashing and units use pinned viem. Contract calls use the trusted [canonical ABI inputs](../contracts/abi/README.md), not ABIs supplied by an RPC response. Raw RPC requests disable retries and use a fresh 60-second abort signal covering response headers and body. Cast remains the encrypted wallet adapter; independent Cast encodings in tests are separate evidence.

Contract return data must decode and re-encode to exactly the same bytes. Malformed padding, trailing bytes, invalid booleans and out-of-range values now fail admission rather than being silently truncated. This is an intentional stricter check before planning writes. V3 price, tick-range and liquidity recipes remain protocol-specific harness policy.

## Deploy and seed

Set shell variables such as `ENV_FILE`, `HARNESS_ADDRESS`, `TERMINAL_ADDRESS`, `KEYSTORE`, and `PASSWORD_FILE`, then review dry runs first:

```bash
# Read checks and estimates only; no signing or broadcasting.
# check requires an existing deployment manifest; deploy dry-run works before deployment.
bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs deploy \
  --sender "$HARNESS_ADDRESS"

# Explicitly authorize deployment after reviewing estimates.
bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs deploy \
  --sender "$HARNESS_ADDRESS" --broadcast \
  --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE"

# Preview, then authorize pool creation and seeding.
bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs seed \
  --sender "$HARNESS_ADDRESS" --recipient "$HARNESS_ADDRESS" \
  --recipient "$TERMINAL_ADDRESS"
bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs seed \
  --sender "$HARNESS_ADDRESS" --recipient "$HARNESS_ADDRESS" \
  --recipient "$TERMINAL_ADDRESS" --broadcast \
  --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE"

# Preview, then authorize the configured Uniswap V4 pool and position.
bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs seed-v4 \
  --sender "$HARNESS_ADDRESS"
bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs seed-v4 \
  --sender "$HARNESS_ADDRESS" --broadcast \
  --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE"

bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs check
bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs config
bun --env-file="$ENV_FILE" scripts/engine.ts --config .testnet/runtime.toml
```

Run `seed-v4` after `deploy` and `seed`, because it uses the deployed fixture tokens and harness token balances. It grants the PositionManager the required token permissions, initializes the configured pool directly through PoolManager, and mints one liquidity position. The receipt's NFT transfer identifies the position; reruns verify its owner and exact liquidity without creating another position.

Dry runs do not save a manifest, sign, or submit. Deployment addresses are predictions until broadcast. Estimates for dependent operations can be unavailable until prior contracts or writes exist. Each actual write is estimated immediately before signing. Gas limits add 20% headroom and legacy gas price uses twice the current suggestion. Printed ceilings exclude Base L1 data fees.

The harness does not fund ETH, discover recipients, or delete resources. Its liquidity helper has no withdrawal flow. Use only disposable test tokens and small Base Sepolia balances.

## Outputs and interpretation

Harness progress and transaction hashes go to stdout; errors go to stderr. Key lines:

- `DRY <step>: <gas> gas` is an estimate only. `estimate unavailable` means a preceding deployment or write is needed; it is not a successful estimate.
- `<step>: estimated ...; L2 ceiling ... (L1 data fee extra)` appears before a broadcast step.
- `<step>: 0x...` records the submitted transaction after a canonical successful receipt was found.
- `<pool>: active liquidity ...` is a read check, not proof that every desired price range or wallet balance is correct.
- `Read checks complete ... No writes.` confirms the `check` command made no writes.
- `Runtime config: ...` identifies the generated TOML path.

Persistent files:

- `.testnet/manifest.json` by default, or `--manifest PATH`: mode-0600 resume journal with exact signed bytes, transaction hashes, receipts, deployed addresses, official code hashes, token metadata, and pool settings. Signed bytes are sensitive broadcast authorizations.
- `.testnet/runtime.toml`: generated terminal/engine configuration containing addresses and environment-variable names, never RPC credential values.
- `.testnet/PancakeBootstrap.json` and `.testnet/pancake/`: preparation artifact and pinned source checkout.
- `contracts/out/`, `contracts/cache/`, and any `contracts/broadcast/`: ignored Foundry outputs.

Never delete or edit the manifest to recover from a timeout. Restart the identical command. Confirmed transactions are checked and skipped. Pending transactions may only be resubmitted using the same stored signed bytes. A consumed nonce without matching receipt stops for manual inspection. Run one harness process per signer/manifest and do not use that signer elsewhere during a run.

Base may expose a preliminary successful receipt with a zero block hash. The harness waits for a nonzero hash matching the canonical block before recording completion. This is not a claim of L1 finality; later reorgs remain possible.

## Fixtures

The default profile's tokens A, B, and C use 18, 6, and 8 decimals. A/B/C are named harness fixtures for seeded scenarios, not the product token allowlist. Product token and contract allowlists come from generated runtime TOML. Each explicit recipient receives 1,000,000 whole units of each token once. Initial prices represent one whole token for one whole token, not equal atomic amounts.

Under the default profile, both V3 venues receive A/B, B/C, and A/C pools. Fee-500 pools use a broad range for normal swaps. Narrow pools use Uniswap fee 3000 and Pancake fee 2500 for exhaustion tests. Uniswap V4 receives the configured A/C fee-500 pool with one broad position. These pairs and fee lists come from `harness.toml`. Public testnet trades change pool state; reruns are new trades, not resets, and sequential outputs need not match.

## Credential-free selected-route evidence

After dependency installation and preparation above, run:

```bash
bun test scripts/e2e.test.ts scripts/testnet
bunx --no-install tsc -p apps/terminal/tsconfig.json
forge test --root contracts
```

The selected-route fixtures run the real terminal `runTrade`, `executePrepared`, receipt verification, and E2E JSONL reader. Engine responses, signing, RPC receipts, and confirmation answers are fixed test inputs. They prove the connection between the returned recommendation, selected route, fresh quote after approval, separate confirmation, and recorded quoted/simulated/actual amounts. They do not prove public-pool pricing, real signing, or interactive TTY input; terminal CLI tests and the opt-in run below cover those separate paths.

The initial fixture recommends Uniswap at 12,000 atomic output over Pancake at 10,000. After approval, a different quote ID/block returns Uniswap at 11,000 and Pancake at 14,500, with an incomplete search. Auto mode selects fresh Pancake; manual Uniswap remains selected. Expected minimum, simulation, and actual outputs are fixed independently: auto 14,427 / 14,490 / 14,480; manual 10,945 / 10,990 / 10,980. The tests also decline the fresh swap and reject a second required approval, leaving only the first approval sent. Ranking and deterministic tie-breaking tests belong to the engine, not this fixture.

## Live E2E runner

List four direction-and-hop scenarios per configured deployment without RPC calls, signer access, or sends. A and C remain the named seeded scenario inputs; they are not a general product allowlist:

```bash
bun scripts/e2e.ts --config .testnet/runtime.toml
```

Pass `--chain KEY` to select a configured runtime chain. Without it, the runner uses TOML `terminal.default_chain`.

After starting the engine and reviewing the plan:

```bash
bun --env-file="$ENV_FILE" scripts/e2e.ts --config .testnet/runtime.toml --broadcast \
  --keystore "$TERMINAL_KEYSTORE" --password-file "$TERMINAL_PASSWORD_FILE" \
  --report .testnet/coverage-acceptance.jsonl
```

Broadcast mode creates `.testnet/e2e-<timestamp>.jsonl` with mode 0600, or uses `--report PATH` (which must not exist). It prints the same JSONL events to stdout. Event order is `start`, then per-scenario `quote`, `preparation_preview`, terminal `approval` when needed, a fresh `quote` after each permission, terminal `swap`, and `scenario_passed`; at most two permission transactions are allowed. Final success is `passed` with `track: "coverage"` and count matching the listed plan. Quote events include the pinned block, selected route, engine `bestRouteId`, search completeness, and errors. This matrix deliberately selects a named venue/hop route rather than the engine recommendation; it establishes execution coverage, not winner selection. Uniswap V4 deployments list one-hop scenarios only. Pass `--in TOKEN --out TOKEN` together to replace the default A/C fixture symbols.

Each terminal send records the submitted hash before waiting for receipt verification. Final swap success requires `verification.outcome: "passed"`; approval requires `receipt_success`. An earlier successful event cannot hide a later failure or cancellation. Any missing route, rejected preparation, nonzero child exit, inconclusive receipt, malformed remaining output, or failed verification stops the run at the first scenario. Provider diagnostics are suppressed in the final runner error. Inspect the JSONL report and wallet transactions before rerunning; there is no automatic resend.

### Selected-route acceptance is a separate opt-in run

`--selection` runs two real `trade` commands, A→C and C→A, instead of the named matrix. Both tracks are needed; selected-route success does not replace venue/hop coverage. Listing either plan remains credential-free:

```bash
bun scripts/e2e.ts --config .testnet/runtime.toml --selection

# Only after transaction approval, from an interactive terminal:
bun --env-file="$ENV_FILE" scripts/e2e.ts --config .testnet/runtime.toml \
  --selection --broadcast \
  --keystore "$TERMINAL_KEYSTORE" --password-file "$TERMINAL_PASSWORD_FILE" \
  --report .testnet/selection-acceptance.jsonl
```

Review each displayed preparation and type `approval` or `swap` only for that transaction. The runner passes no confirmation flag and requires a TTY. A verified approval permits one fresh quote, not a swap authorization. Auto mode reselects the fresh engine recommendation; manual terminal `trade --route-id ID` keeps that route or fails if missing. The fresh route and amounts require another explicit confirmation. The flow accepts at most two separately confirmed permission transactions, refreshing the quote after each; a third required permission stops the trade. Previously confirmed permissions remain in place.

Selected reports begin with `start` and `track: "selection"`. Each `trade` event wraps the terminal JSON under `result`: full `quote`, explicit `selection` (quote/route IDs, `source`, `searchComplete`, `basis: "raw_output"`, `afterApproval`), full `preparation` before confirmation, submitted hash, then verification. Compare `preparation.route.amountOutAtomic` (quoted), `preparation.simulatedAmountOutAtomic` (simulated at `simulationBlock`), and `verification.outputReceivedAtomic` (actual transaction transfers). Retain quote block/hash, preparation ID, transaction hash, and actual input spent as well. `scenario_passed` follows each verified swap; final `passed` count is 2. Confirmation cancellation is not success.

The recommendation means highest gross output among returned successful routes, with deterministic candidate-order ties. All candidates remain visible. An incomplete search is not a global optimum; the report makes it explicit even when protobuf JSON omits a false `quote.searchComplete`. No network-cost or gas-optimal claim follows from these checks. Public pools change between transactions: do not assert fixed winners, equal sequential outputs, or same-state winner changes from live runs. The fixed fixtures above establish refresh-selection behavior without spending test ETH. A live run with existing allowance does not establish the approval-refresh path; inspect the recorded events rather than inferring that path from overall success.
