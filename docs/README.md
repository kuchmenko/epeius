# Epeius documentation

Epeius is an open-source EVM quote engine and trading terminal for researching deterministic multi-venue routing and verifiable execution. Use this page as the index for current components and operator workflows.

## Components

- [Engine](engine.md): Go quote server, chain configuration, startup checks, route search, and engine logs.
- [Terminal](terminal.md): CLI commands, token and amount input, human and JSON output, transaction preparation, and receipt verification.
- [Testnet harness and contracts](testnet.md): Base Sepolia deployment and seed workflow, Foundry contracts, manifests, E2E reports, recovery, and safety rules.
- [Execution contract](execution.md): trust split, immutable preparation terms, simulation evidence, approval flow, partial-input limitation, and unsupported execution cases.
- [Uniswap V4 provider](providers/uniswap-v4.md): configuration, deployment admission, Permit2 flow, quote behavior, limits, and validation.
- [Aerodrome Slipstream provider](providers/aerodrome-slipstream.md): protocol differences, configuration, startup admission, quote and preparation behavior, and limits.
- [Balancer V2 provider](providers/balancer-v2.md): Vault and pool-ID configuration, quote and preparation behavior, startup checks, and limits.
- [Development tooling](development.md): setup, generation, checks, build outputs, and local test output.
- [Protocol](protocol.md): ConnectRPC service, request and response meanings, compatibility rules, and interpretation of partial quote results.
- [AI reviewer benchmark](reviewer-benchmark.md): automatic review trigger contract, canary procedure, and evaluation metrics.

## First tasks

| Goal | Start here |
| --- | --- |
| Run read-only quotes | [Terminal quick start](terminal.md#quick-start) |
| Configure or diagnose a chain | [Engine configuration](engine.md#configuration) |
| Configure Uniswap V4 | [Uniswap V4 provider guide](providers/uniswap-v4.md#configuration) |
| Configure Aerodrome Slipstream | [Slipstream provider guide](providers/aerodrome-slipstream.md#configuration) |
| Prepare or execute on an enabled chain | [Terminal execution](terminal.md#configured-chain-execution), then [execution contract](execution.md) |
| Deploy and seed disposable test pools | [Testnet harness](testnet.md) |
| Run repository checks | [Development tooling](development.md#verification) |
| Evaluate AI reviewers | [AI reviewer benchmark](reviewer-benchmark.md) |
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
| Root build | `dist/epeius-engine` and generated bindings | Ignored local executable and generated Go/TypeScript protocol/ABI code; canonical inputs and Go module manifests stay tracked |

Do not commit `.env`, keystores, password files, `.testnet/`, `node_modules/`, or Foundry outputs. Never treat a pending or unknown send as permission to resend automatically.
