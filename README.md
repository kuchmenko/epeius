# Epeius

Epeius is a proof-of-concept EVM trading terminal and quote engine, currently targeting Base. One Go engine serves every configured chain. A Bun terminal uses ConnectRPC to request quotes and, on explicitly enabled Base Sepolia configurations, prepare and submit transactions with a local signer. Base mainnet remains read-only.

## Quick start

Requires **Bun 1.3.9** and **Go 1.26.4**. From the repository root:

```bash
bun install --frozen-lockfile
bun run setup
bun run generate
cp .env.example .env
bun run engine
```

If `.env` already exists, edit it instead of overwriting it. Public RPCs are rate-limited; replace their URLs with your provider's HTTPS URLs if needed. No test ETH is required for quoting.

Keep the engine running. In another terminal:

```bash
bun run terminal -- status
bun run terminal -- tokens --chain base
bun run terminal -- quote --chain base --in WETH --out USDC --amount 0.01
```

Ctrl+C stops the engine and releases its port. See [Engine](docs/engine.md) and [Terminal](docs/terminal.md) for configuration, output, and troubleshooting.

## Documentation

Start at the [documentation index](docs/README.md):

- [Engine](docs/engine.md)
- [Terminal](docs/terminal.md)
- [Testnet harness and contracts](docs/testnet.md)
- [Execution contract and known limitations](docs/execution.md)
- [Development tooling](docs/development.md)
- [ConnectRPC protocol](docs/protocol.md)

Read the execution contract before sending transactions. A successful simulation or receipt does not guarantee full input consumption; this milestone checks actual amounts but has no custom on-chain executor.
