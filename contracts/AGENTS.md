# Contract review rules

## Code Review Rules

- Preserve exact full-spend balance-delta accounting, actual hop output as the next input, entry-dust isolation, temporary allowance cleanup, one aggregate minimum, and atomic rollback across allocations.
- Keep fixed typed immutable Uniswap SwapRouter02 and Pancake V3-only router identities and the current one-or-two allocation and hop limits. Expansion requires an explicit contract version and design; protocol-kind matching alone is not enough.
- Assume reviewed standard ERC-20 behavior only. Token admission belongs to application TOML, not a Solidity allowlist. Native ETH, Permit2, transfer-tax, rebasing, callback-dependent, and arbitrary-call support remain out of scope.
