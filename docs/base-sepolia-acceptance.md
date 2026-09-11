# Base Sepolia acceptance — 2026-09-10

Scope: chain **84532**, existing disposable A/B/C fixtures and designated test wallets. No mainnet, new fixture seeding, external funding, or merge. Signed drafts: [direct trade #5](https://github.com/kuchmenko/epeius/pull/5), [stacked executor #6](https://github.com/kuchmenko/epeius/pull/6).

## Deployment provenance

- Executor: [`0x3772f50a5d96fb12fca1558f0b9423c1651823cf`](https://sepolia.basescan.org/address/0x3772f50a5d96fb12fca1558f0b9423c1651823cf).
- Deployment: [`0x63d0b49c…`](https://sepolia.basescan.org/tx/0x63d0b49cfca67e99ff37f2402a7a1572f31eaa93bc3fa98f5d536c1cfa9ecc2c), canonical block 46647610, hash `0x611106aae5930dc80ff3764c0957bfc3c93e18dc66cace4746ecd097edccc832`.
- Constructor routers: Uniswap `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4`; Pancake `0xdc373102d0d0ec9ab2d65c0d8faa668891fdf009`.
- Compiled artifact: `contracts/out/Executor.sol/Executor.json`, Solidity 0.8.24 and pinned dependencies. Constructor execution via read-only `eth_call` produced runtime bytes; the entire deployed runtime matched these bytes at the canonical deployment block, including immutable router values. Both getters matched independently before trusted runtime TOML was written.
- Runtime keccak256: `0x2c27405feab5ef8b55c3047b93b9a8ea7c97cf866e36117f3c08b4c83ca6ba93`.
- Existing Uniswap code hashes matched the prior fixture manifest; factory/WETH links passed harness checks. Pancake's canonical creation transaction matched the preserved journal and pinned package creation-bytecode prefix. All 12 existing pools had active liquidity. The original manifest was not changed.

This is artifact correspondence for this deployment, not an explorer source-verification claim or an audit. Application preparation's getter/code checks alone do not perform this full provenance check.

## Direct matrix: eight live swaps passed on the combined stack

Each swap used the real engine, exact Tenderly transaction simulation, local terminal signing, canonical receipt checks and exact-transaction ERC20 deltas. Inputs were one whole token: A uses 18 decimals, C uses 8. Two-hop paths use B (6 decimals). Fees were 500 per hop.

| Venue / hops / direction | Actual output, atomic | Swap |
| --- | ---: | --- |
| Pancake / 1 / A→C | 99920042 | [transaction](https://sepolia.basescan.org/tx/0x6a11e98139e65c113ecffc01e0dc663f2df13411ce1d3eef904de7d9a60633dc) |
| Pancake / 1 / C→A | 999799630173964586 | [transaction](https://sepolia.basescan.org/tx/0x9f1ce8d8476dab703392ecf447deb3ff2af2afabe12b8d01fc04cb1baa00dedb) |
| Pancake / 2 / A→C | 99880036 | [transaction](https://sepolia.basescan.org/tx/0xc588b670e8ebe0354d5606d3d4bbf5c4795aad17d3fab7ece8a24f01612214a3) |
| Pancake / 2 / C→A | 999198950196654322 | [transaction](https://sepolia.basescan.org/tx/0xd1aa930d885fffe78d68956fbcfa5a575d7847ab673df8064d5ddb4ea350c099) |
| Uniswap / 1 / A→C | 99940012 | [transaction](https://sepolia.basescan.org/tx/0x2cae0c0ec187701f2595e23e72f36364e930906d8a0552b68bfef00d791b346b) |
| Uniswap / 1 / C→A | 999599870072971807 | [transaction](https://sepolia.basescan.org/tx/0x5fb7b47fce5ec00e4ba4842a85c1ea616061510bc6dc7fd182af8fd79a996b53) |
| Uniswap / 2 / A→C | 99880036 | [transaction](https://sepolia.basescan.org/tx/0x4441e71eec24eaa7d150d0609c410964be38201d0bf2ce5581d89b4031439cc3) |
| Uniswap / 2 / C→A | 999198950196654322 | [transaction](https://sepolia.basescan.org/tx/0xc33feaf514d8a7b65112b8ae03827e581e00bd149325add9b5eb60cd97c92866) |

## Interactive selection: three live swaps passed on PR #5

Actual `trade` commands ran in a tmux TTY, with each displayed approval and fresh swap separately reviewed and answered. No confirmation flag, mocked signer, injected confirmation callback, or TTY bypass was used. Both auto cases selected Pancake fee 500 before and after approval; fresh quote IDs were different. Manual Uniswap two-hop remained pinned despite a different engine recommendation.

| Selection | Actual output, atomic | Swap |
| --- | ---: | --- |
| Auto A→C | 99920048 | [transaction](https://sepolia.basescan.org/tx/0xff8c864786eb2a7d5574d54ff05c58c750a01cd25d75fd8d3bd2f72ed78b4585) |
| Auto C→A | 999799570274904589 | [transaction](https://sepolia.basescan.org/tx/0x18d33a88dbf20ff80aaffa94c6f2f188f8fca6ffd4451c8c03d767669da4efb1) |
| Manual Uniswap two-hop A→C | 99894737 | [transaction](https://sepolia.basescan.org/tx/0xeffe46c11465eb17445806bde44c569a1cd94dc4bd4356e86656dfe985ef124f) |

These live runs prove approval refresh and explicit reconfirmation, but not a live winner change. Deterministic local fixtures prove changed-winner selection, missing manual route, non-TTY refusal and second-approval stopping without spending test ETH.

## Executor: four live swaps passed on PR #6

All executor transactions matched the displayed calldata byte-for-byte. Exact-size allocation re-quotes shared a block; aggregate slippage was 75 bps. Tenderly simulated the exact executor target/calldata with balance and allowance probes before signing. Actual input equaled the requested total, actual output met the aggregate minimum, and terminal Transfer deltas showed no new residue at caller/executor/used routers. Independent post-receipt RPC reads proved every temporary per-hop executor→router allowance was zero at that canonical block.

| Plan / direction / input | Minimum atomic output | Simulated = actual atomic output | Swap |
| --- | ---: | ---: | --- |
| Uniswap 1 hop / A→C / 1 A | 99190463 | 99940014 | [transaction](https://sepolia.basescan.org/tx/0xb02efaf75381251b8851b8dd2ecd7b7c9727b8cc987a11ff6f196cd0253ed8cb) |
| Pancake 2 hops / C→A / 1 C | 991308355198684457 | 998799350326130436 | [transaction](https://sepolia.basescan.org/tx/0x3df20a5dacf77d16e48b9f4152a074f79abb949485c743d2b1e7520be058b468) |
| Uniswap 1 + Pancake 2 / A→C / 0.37 + 0.64 A | 100169107 | 100926053 | [transaction](https://sepolia.basescan.org/tx/0xeef30cadeac33f882688f04705a719d30cb628638ace8fc35a2c38ae5f50a858) |
| Uniswap 2 + Pancake 2 / C→A / 0.37 + 0.64 C | 1001221778729120850 | 1008787686376947960 | [transaction](https://sepolia.basescan.org/tx/0x32bb32de2b9282bbac5bfe3037765391e74d219540020be3687fb94989a3427c) |

Temporary acceptance collection first used an invalid CLI argument order (no send), then read the wrong hash field after a successful first swap. That swap was not repeated; its receipt/allowances were recovered independently. A later split attempt stopped before swap submission after a lengthy preview; fresh quote and normal execute completed it. Existing approval was retained. The CLI's generic allocation-mismatch diagnostic did not expose the original rejection reason, so expiry is not established as its cause.

## Cost, local gates and limits

31 canonical successful transactions: 1 deployment, 15 exact approvals, 15 swaps. Receipt fees (`gasUsed × effectiveGasPrice + l1Fee`) total **38,366,586,811,225 wei = 0.000038366586811225 test ETH**, exactly matching the two-wallet balance decrease. Deployment wallet spent 15,860,499,165,311 wei; terminal spent 22,506,087,645,914 wei. Final balances: 0.099085972902417149 and 0.009965318307609146 test ETH respectively. No funding or fixture mint/seed transaction was added.

[Machine-readable evidence](base-sepolia-acceptance.json) records all 31 hashes, canonical blocks, gas/fees, exact allocation quote/simulation/output evidence and zero allowances. It contains no signing bytes, credentials, RPC URLs or keystore paths.

- PR #5 head: 67 Bun tests, Go vet/race, lint/types/build, generated-binding check and 4 Foundry tests passed.
- Combined stack: 74 Bun tests and 30 Foundry tests passed, including 10,000 valid split fuzz cases and authentic Uniswap/Pancake partial-consumption/rollback tests.
- CI foundation initially lacked isolated harness dependencies; installing the locked workspace fixed it. Both drafts' foundation/harness checks then passed. No failing test was skipped to hide this failure.
- Revert/rollback, fee-zero pools, adversarial tokens, pre-existing dust and reentrancy were tested locally, not by wasteful live reverting transactions. Live swaps used standard fixtures and fee 500.
- Public pools change between trades. Equal simulated/actual output here is observed evidence, not a guarantee, gas-optimal claim, mainnet proof or L1 finality claim. Direct-router partial-consumption limitations remain. No PR was merged.
