# Aerodrome Slipstream Initial acceptance — 2026-09-11

Scope: Base chain **8453**, reviewed Initial deployment, read-only Tenderly simulation, and a disposable local Anvil fork. No mainnet transaction was signed or submitted. The local fork transaction hash is not a Base transaction.

This is dated evidence for one configured deployment, not Epeius's current admission limit. Epeius now has no hardcoded Slipstream chain ID or exact-address allowlist. See the reusable [Aerodrome Slipstream provider guide](providers/aerodrome-slipstream.md) for current configuration, startup checks, behavior, and limits.

## Pinned state and account

- Block: **51180007**, hash `0x4e568ac52344c6b51c267c3b712ff88889d1fe30c60f9187e78b07554e2a392b`.
- Sender: [`0x3BF66b5Ba807eC0e8faA33AC15c283E05Dfad379`](https://basescan.org/address/0x3bf66b5ba807ec0e8faa33ac15c283e05dfad379), used only as an impersonated simulation sender.
- The sender had real WETH, native gas, maximum WETH allowance to the configured Initial router, no account code, and zero discount in the factory's current dynamic fee module.
- Input: **0.00001 WETH** (`10000000000000` atomic). No 1 WETH fixture was needed.

The account state is live and can change. Recheck balance, allowance, code, and discount at the selected block before repeating this procedure.

## Canonical Epeius and Tenderly preparation

The feature engine used the configured Base RPC and Tenderly credentials with execution enabled in an ignored runtime TOML. It quoted the configured spacing-100 WETH/USDC pool and prepared the selected route for the sender above.

- Route: `aerodrome-slipstream-initial:100`.
- Pool: `0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59`.
- Quoted output: `25624` atomic USDC.
- Minimum output at 50 bps slippage: `25495` atomic USDC.
- Tenderly simulated output: `25624` atomic USDC.
- Preparation status: `READY`.
- Target: configured Initial router `0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5`.
- Simulation block number and hash exactly matched the quote block.

The engine's simulation bundle set `transaction_index = -1`, sent the exact sender, target, calldata, value, and gas limit, and used no balance or allowance overrides. This proves the Epeius-to-Tenderly preparation path against canonical end-of-block state. It does not prove future inclusion or execution after pool state changes.

## Exact local-fork execution

Anvil forked the same block and reproduced its hash:

```bash
anvil --fork-url "$BASE_RPC_URL" --fork-block-number 51180007 \
  --host 127.0.0.1 --port 28545 --silent
```

The sender was unlocked only inside Anvil with `anvil_impersonateAccount`. The exact unsigned target and calldata returned by Epeius were then sent to the local fork. No state override, fabricated WETH balance, fabricated allowance, private key, or mainnet submission was used.

- Local-only transaction: `0xde63ce42093ef78ce5c78bce139c339509ec2e4e9c3cc6be89cf3a85d7dddde8`.
- Receipt status: success.
- Sender WETH decrease: exactly `10000000000000` atomic.
- Sender USDC increase: exactly `25624` atomic.
- Router WETH delta: zero.
- Router USDC delta: zero.

This proves that the exact prepared calldata executes against the authentic deployed contracts and consumes the full input while meeting the minimum output. It is local-fork evidence, not a Base receipt or production result.

## Repeatable method

1. Find an EOA with sufficient real input-token balance, router allowance, native balance, empty code, and zero Slipstream discount.
2. Pin one canonical block number and hash; keep quote, Tenderly simulation, and fork on that state.
3. Use a small amount, request an Epeius quote, select the Slipstream route explicitly, and call `PrepareExecution` with the EOA as sender.
4. Require `READY`, matching quote/simulation block identity, exact configured target, zero value, and independently checked calldata.
5. Fork the same block, verify its hash, impersonate the EOA, and send only the exact prepared transaction to Anvil.
6. Compare sender and router token balances before and after. Require full input consumption, output at least the minimum, and no new router residue.
7. Label canonical simulation, local-fork execution, and any public-chain receipt as separate evidence. Never present one as proof of another.

For an approval-flow fixture, transfer a small amount of real WETH within the fork to a disposable Anvil account and approve normally. That modified state is useful fork evidence but cannot be reproduced by canonical Tenderly simulation without overrides.
