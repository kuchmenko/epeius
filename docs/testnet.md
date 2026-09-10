# Testnet harness and contracts

The harness creates disposable A/B/C fixtures using the checked-in Base Sepolia profile, validates configured official Uniswap deployment links, deploys authentic Pancake contracts plus local test contracts, seeds pools, and writes a runtime config. Network writes require explicit `--broadcast`.

For execution guarantees and the partial-input limitation, read [Execution contract](execution.md). Detailed dependency provenance remains beside the harness in [`scripts/testnet/README.md`](../scripts/testnet/README.md).

## Requirements and setup

Run from repository root. Requires Bun 1.3.9, Git, Foundry 1.5.0 (`forge` and `cast`), and the root Go toolchain when running engine or terminal.

Harness dependencies use their own `scripts/testnet/bun.lock` and local `scripts/testnet/node_modules`; they are not part of the root workspace install.

```bash
bun install --cwd scripts/testnet --frozen-lockfile --ignore-scripts
bun scripts/testnet/prepare.mjs
bun test scripts/testnet
forge test --root contracts
```

Preparation clones pinned Pancake source to `.testnet/pancake`, rejects checkout changes, compares compiled pool bytecode with the released package artifact, writes `.testnet/PancakeBootstrap.json`, and builds Foundry contracts under `contracts/out` and `contracts/cache`. These commands do not deploy or spend test ETH. `forge test` is local and includes real Pancake partial-consumption and intermediate-residue cases.

Foundry downloads native solc 0.7.6 and 0.8.24 when missing. Pancake uses its own `contracts/pancake/foundry.toml`; its build artifacts and cache stay under `.testnet/pancake-out` and `.testnet/pancake-cache`. Bun runs the scripts, not a WebAssembly compiler.

## Harness profile, environment, and wallets

[`scripts/testnet/harness.toml`](../scripts/testnet/harness.toml) is the default harness profile. It selects the chain key and ID, RPC environment-variable name, WETH address, official Uniswap factory, quoter, router, and position manager, fixture token decimals and pairs, deployment fee lists, and artifact paths. Use `--config PATH` to select another profile. These values are not hidden defaults in harness code; deployment addresses and fee lists used by generated runtime TOML come from the profile or deployment manifest.

The profile is loaded when each harness process starts, not hot-reloaded. A different profile does not establish support for its network or providers. Validate chain capabilities, official contract links, and simulation support before live use. Base Sepolia remains the verified default profile.

Fixture token symbols and decimals are configured in `fixtures.tokens`; there is no A/B/C-only restriction in deployment or seeding. `fixtures.pairs` maps stable journal identifiers to two distinct token symbols, for example `AB = ["A", "B"]`. Keep existing identifiers unchanged when resuming a deployment. The live E2E script still tests the A/C scenario of the default fixture; it is not a general token discovery tool.

Put the environment variable named by `chain.rpc_url_env` in a private environment file. The default profile names `BASE_SEPOLIA_RPC_URL`. Bun 1.3.9 does not provide `process.loadEnvFile`, so the harness has no `--env` option. Prefix every harness invocation:

```bash
bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs COMMAND ...
```

Use separate encrypted harness and terminal wallets. Keep keystores and password files outside Git with file permissions that exclude group and world access. The harness address must match the harness keystore. Include it as a seed recipient because it pays liquidity token amounts. Terminal wallet receives tokens for swaps.

RPC URL values are not printed or passed to subprocess arguments. Only password-file path reaches Foundry. There is no private-key option or implicit environment wallet. Signing is local with `cast mktx`; submission occurs only with `--broadcast` after configured chain ID, signer, contract links, balance, and gas checks pass.

## Deploy and seed

Set shell variables such as `ENV_FILE`, `HARNESS_ADDRESS`, `TERMINAL_ADDRESS`, `KEYSTORE`, and `PASSWORD_FILE`, then review dry runs first:

```bash
# Read checks and estimates only; no signing or broadcasting.
bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs check
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

bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs check
bun --env-file="$ENV_FILE" scripts/testnet/harness.mjs config
bun --env-file="$ENV_FILE" scripts/engine.ts --config .testnet/runtime.toml
```

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

Under the default profile, both venues receive A/B, B/C, and A/C pools. Fee-500 pools use a broad range for normal swaps. Narrow pools use Uniswap fee 3000 and Pancake fee 2500 for exhaustion tests. These pairs and fee lists come from `harness.toml`. Public testnet trades change pool state; reruns are new trades, not resets, and sequential outputs need not match.

## Live E2E runner

List four direction-and-hop scenarios per configured deployment without RPC calls, signer access, or sends. A and C remain the named seeded scenario inputs; they are not a general product allowlist:

```bash
bun scripts/e2e.ts --config .testnet/runtime.toml
```

Pass `--chain KEY` to select a configured runtime chain. Without it, the runner uses TOML `terminal.default_chain`.

After starting the engine and reviewing the plan:

```bash
bun scripts/e2e.ts --config .testnet/runtime.toml --broadcast \
  --keystore /local/path/terminal --password-file /local/path/password
```

Broadcast mode creates `.testnet/e2e-<timestamp>.jsonl` with mode 0600, or uses `--report PATH`. It prints the same JSONL events to stdout. Event order is `start`, then per-scenario `quote`, `preparation_preview`, terminal `approval` when needed, fresh `quote` after approval, terminal `swap`, and `scenario_passed`; final success is `passed` with count equal to four times the configured deployment count.

Each terminal send records the submitted hash before waiting for receipt verification. Swap success requires `verification.outcome: "passed"`; approval requires `receipt_success`. Any missing route, rejected preparation, nonzero child exit, inconclusive receipt, malformed remaining output, or failed verification stops the run at the first scenario. Provider diagnostics are suppressed in the final runner error. Inspect the JSONL report and wallet transactions before rerunning; there is no automatic resend.
