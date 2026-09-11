# Testnet harness review rules

## Code Review Rules

- Keep every write behind explicit `--broadcast` plus configured chain, signer, contract-link, balance, and gas checks. Validate complete pool plans before estimation, signing, or submission, and never expose RPC credentials or private keys.
- Preserve resumable one-signer journal behavior: record exact signed bytes and hashes, verify canonical nonzero receipt block hashes, and never replace or resend a transaction with different bytes after an unknown result.
- Keep evidence claims scoped. Mocked and local authentic-EVM fixtures prove deterministic behavior; public Base Sepolia runs prove dated integration only because pool state mutates. Do not claim local-fork, mainnet, production, future-state, profitability, or audit evidence.
