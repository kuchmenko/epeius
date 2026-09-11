# Epeius

Epeius is an open-source EVM quote engine and trading terminal for researching deterministic multi-venue routing and verifiable execution. One Go engine serves every configured positive chain ID. A Bun terminal uses ConnectRPC to request quotes and, only when `execution_enabled = true`, prepare and submit transactions with a local signer. Supported direct providers include Uniswap V3, Pancake V3, Aerodrome Slipstream, and Balancer V2. Chain, token, contract, and pool-selector allowlists come from TOML; there are no implicit network, token, or provider defaults. The checked-in root configuration keeps execution disabled on every chain.

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
- [Balancer V2 provider](docs/providers/balancer-v2.md)
- [Development tooling](docs/development.md)
- [ConnectRPC protocol](docs/protocol.md)

Read the execution contract before sending transactions. Direct-router `trade` retains its partial-input limitation. Explicit `prepare`/`execute --allocations` supports the exact-input executor with one or two caller-chosen allocations; it requires a verified deployment and TOML configuration. [Base Sepolia acceptance](docs/base-sepolia-acceptance.md) records the tested deployment, exact Tenderly simulations and live transactions. This is not proof that a newly configured network or provider supports safe live execution.
