# Base Sepolia deployment harness

Run from the repository root. Node 22+, npm, git, forge and cast are required.

```sh
npm ci --prefix scripts/testnet --ignore-scripts
node scripts/testnet/prepare.mjs
npm test --prefix scripts/testnet
forge test --root contracts

# Reads and estimates only; no keystore required.
node scripts/testnet/harness.mjs check --env "$ENV_FILE"
node scripts/testnet/harness.mjs deploy --env "$ENV_FILE" --sender "$HARNESS_ADDRESS"

# Only after reviewing the estimate: explicitly authorize each write phase.
node scripts/testnet/harness.mjs deploy --env "$ENV_FILE" --sender "$HARNESS_ADDRESS" \
  --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE" --broadcast
node scripts/testnet/harness.mjs seed --env "$ENV_FILE" --sender "$HARNESS_ADDRESS" \
  --recipient "$HARNESS_ADDRESS" --recipient "$TERMINAL_ADDRESS"
node scripts/testnet/harness.mjs seed --env "$ENV_FILE" --sender "$HARNESS_ADDRESS" \
  --recipient "$HARNESS_ADDRESS" --recipient "$TERMINAL_ADDRESS" \
  --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE" --broadcast
node scripts/testnet/harness.mjs check --env "$ENV_FILE"
node scripts/testnet/harness.mjs config --env "$ENV_FILE"
```

`BASE_SEPOLIA_RPC_URL` comes from the environment or `--env` file. Values are never printed or passed to subprocess arguments. Passwords remain in the password file; only its path is passed to Foundry. File permissions must exclude group/world access. Wallet address must match `--sender`. There is no private-key option or implicit environment wallet. Signing is local with `cast mktx`; RPC submission happens only with `--broadcast` after chain 84532, signer, links, and gas checks.

Default manifest is `.testnet/manifest.json`; select another with `--manifest`. It records exact signed bytes, transaction hashes, receipts and addresses before/after submission. Signed transactions are sensitive broadcast authorizations: keep this ignored file private. Restart the identical command after interruption. Confirmed transactions are checked and skipped; pending transactions can only be resubmitted with the same signed bytes. A consumed nonce with no matching receipt stops for manual inspection. Never delete/edit the manifest to retry blindly. Run one harness process per signer/manifest and do not use that signer elsewhere during a run.

Dry runs do not save the manifest, sign, or submit. Deployment addresses are predictions until broadcast. Dependent seed estimates can be unavailable before creation/approval/initialization; each actual write gets its own estimate immediately before signing. Gas limits have 20% headroom; legacy gas price uses twice the current suggestion. Printed fee ceilings exclude Base L1 data fees. No ETH funding, mass recipient discovery, or deletion is performed.

`config` writes `.testnet/runtime.toml` beside the manifest, including terminal/engine settings and both deployments. NPM, bootstrap, deployer, pools and transaction records stay in the separate manifest, not runtime TOML.

## Fixtures and real swap semantics

Tokens use OpenZeppelin's standard ERC20 with deployer-only minting: A has 18 decimals, B 6, C 8. Explicit recipients each receive 1,000,000 whole units per token. Recipients must include the liquidity payer. Repeating the same seed command does not mint again.

Both providers have A/B, B/C and A/C pools. Fee 500 pools have a broad concentrated range (~±12,000 ticks). Uniswap fee 3000 and Pancake fee 2500 pools have narrow ranges (±two tick spacings). Initialization represents one whole token per whole token, not equal raw units. Integer square roots preserve 18/6/8 decimal scaling regardless of address ordering. The manifest includes sorted tokens, initialization price, tick range and liquidity for each pool.

The owner-only `LiquiditySeeder` calls real `pool.mint`, authenticates the selected pool through the factory, and pays only during the synchronous callback. Positions remain in this helper permanently; no NFT manager or withdrawal UI is needed for disposable test liquidity. Both providers' real routers and callback checks remain unchanged. No gauges, farming contracts, descriptors, proxies, or mocked DEX are deployed.

`testRealPancakeMintAndPartialInputConsumption` deploys authentic compiled core and released router bytecode in Foundry, seeds an asymmetric 18/6 narrow pool, and swaps 100,000 whole A. It asserts both callback payments, positive output, input consumption below 1% of requested input, exact recipient output balance delta, and exhaustion of active liquidity. This demonstrates the partial-consumption caveat without a mocked pool. On testnet use a narrow pool and an extreme amount in simulation, not a destructive swap against fixtures needed by other scenarios. Quoter output alone does not prove full input consumption. A later on-chain executor must enforce actual input balance deltas.

`testRealPancakeTwoHopLeavesIntermediateResidue` uses a broad A/B first pool and narrow B/C second pool. The real router successfully spends exactly 1,000 A and delivers positive C while retaining more than 100 B. A future no-intermediate-residue invariant must reject this outcome even though the ordinary router transaction succeeds with `amountOutMinimum = 1`.

## Pinned provenance

- Pancake source: [pancakeswap/pancake-v3-contracts, commit 986847948755cba528324d41be19480731c36c2a](https://github.com/pancakeswap/pancake-v3-contracts/tree/986847948755cba528324d41be19480731c36c2a), GPL-2.0-or-later. Downloaded under ignored `.testnet/pancake`; preparation rejects a changed checkout. The repo retains its license files and source SPDX notices.
- Core compilation: solc 0.7.6, Istanbul, optimizer 400, metadata hash none, matching upstream pool settings. Preparation compares the entire compiled pool creation bytecode with npm `@pancakeswap/v3-core@1.0.2`, and verifies init-code hash `0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2`. This is the hash embedded in authentic Pancake periphery address derivation. Core factory is compiled with the same settings; pool bytecode is unchanged.
- `@pancakeswap/v3-periphery@1.0.2` supplies authentic released SwapRouter and QuoterV2 artifacts (GPL-2.0-or-later); npm integrity hashes are locked in `package-lock.json`. No external link placeholders are accepted.
- `contracts/pancake/PancakeBootstrap.sol` is GPL-2.0-or-later. It atomically deploys unmodified core contracts and sets their links because upstream `setFactoryAddress` is public and one-time. Factory ownership returns to the signer. Pool addresses derive from the pool deployer, not factory.
- Custom ERC20/seeder source: MIT; dependency `@openzeppelin/contracts@5.0.2` MIT, compiled with solc 0.8.24/Paris. Dependencies and transitive integrity hashes are pinned in the package lock. Old solc dependencies are build-only; install with `--ignore-scripts`.
- Uniswap uses [official Base Sepolia deployments](https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments): v3-core 1.0.0, v3-periphery 1.0.0, swap-router-contracts 1.1.0. No Uniswap code is copied or redeployed. The harness checks nonempty bytecode and factory/WETH links before use and stores runtime code hashes. Router02 exposes `factory()`, not `factoryV3()`; its exactInput selector is `0xb858183f` and deadline multicall selector is `0x5ae401dc`.

All local downloads, deployment records and outputs use existing `.testnet/` and `contracts/{out,cache,broadcast}/` ignores. Do not commit these artifacts or credentials.
