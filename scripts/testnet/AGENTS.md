# Testnet harness review rules

## Code Review Rules

- Keep every write behind explicit `--broadcast` plus admitted chain, signer, and configuration checks. Validate every pool plan and deployment link before estimation, signing, or submission, and never expose RPC credentials or private keys.
- Keep expected quote and execution values independent from production encoders and rankers. Route tests use asymmetric exact values and cover stable ties, incomplete search, and missing-pool versus provider-failure behavior when relevant.
- Keep evidence claims scoped. Public Base Sepolia pools mutate and cannot prove deterministic winners; mocks and authentic local-EVM fixtures prove different claims. Local-fork, mainnet, production, future-state, profitability, and audit evidence remain absent.
