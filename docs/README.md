# Epeius documentation

Use this page as the index for current components and operator workflows.

## Components

- [Engine](engine.md): Go quote server, chain configuration, startup checks, route search, and engine logs.
- [Terminal](terminal.md): CLI commands, token and amount input, human and JSON output, transaction preparation, and receipt verification.
- [Testnet harness and contracts](testnet.md): Base Sepolia deployment and seed workflow, Foundry contracts, manifests, E2E reports, recovery, and safety rules.
- [Execution contract](execution.md): trust split, immutable preparation terms, simulation evidence, approval flow, partial-input limitation, and unsupported execution cases.
- [Development tooling](development.md): setup, generation, checks, build outputs, and local test output.
- [Protocol](protocol.md): ConnectRPC service, request and response meanings, compatibility rules, and interpretation of partial quote results.

## First tasks

| Goal | Start here |
| --- | --- |
| Run read-only quotes | [Terminal quick start](terminal.md#quick-start) |
| Configure or diagnose a chain | [Engine configuration](engine.md#configuration) |
| Prepare or execute on an enabled chain | [Terminal execution](terminal.md#configured-chain-execution), then [execution contract](execution.md) |
| Deploy and seed disposable test pools | [Testnet harness](testnet.md) |
| Run repository checks | [Development tooling](development.md#verification) |
| Integrate another client | [Protocol](protocol.md) |

## Output map

Most commands write normal output to stdout and diagnostics to stderr. Persistent outputs are local and ignored by Git.

| Producer | Output | Meaning |
| --- | --- | --- |
| Engine launcher | stdout and stderr only | Startup endpoint and one startup-time status per chain; failures on stderr |
| Terminal read commands | stdout; diagnostics on stderr | Human text by default, Protobuf JSON with `--json` |
| Terminal execution | JSONL on stdout; terms and prompts on stderr | Submitted hash is reported before receipt verification |
| Testnet harness | `.testnet/manifest.json` by default | Resume journal containing signed bytes, hashes, receipts, addresses, and pool settings |
| Harness `config` | `.testnet/runtime.toml` | Generated engine and terminal configuration; no RPC credential value |
| Live E2E runner | `.testnet/e2e-<timestamp>.jsonl` by default | Append-only scenario, quote, preparation, hash, and verification events |
| Harness preparation | `.testnet/PancakeBootstrap.json`, `.testnet/pancake/`, `contracts/out/`, `contracts/cache/` | Verified dependency checkout and build artifacts |
| Foundry broadcast tooling | `contracts/broadcast/` when produced by Foundry | Local transaction artifacts; harness recovery authority remains its manifest |
| Root build | `dist/epeius-engine` and generated bindings | Local executable and checked-in generated Go/TypeScript protocol code |

Do not commit `.env`, keystores, password files, `.testnet/`, `node_modules/`, or Foundry outputs. Never treat a pending or unknown send as permission to resend automatically.
