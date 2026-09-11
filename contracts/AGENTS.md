# Contract review rules

## Code Review Rules

- Preserve exact full-spend balance-delta accounting, actual hop output as the next input, entry-dust isolation, temporary allowance cleanup, one aggregate minimum, and atomic rollback across allocations.
- Keep the executor fixed and caller-directed: typed immutable Uniswap SwapRouter02 and Pancake V3-only routers, one or two positive allocations, distinct venues when two, and one or two continuous acyclic hops. Expansion requires an explicit contract version and design.
- Preserve current boundaries: configured fee 0 is valid when a pool exists, deadline equality passes, and contract minimum 0 is an explicit waiver. Assume admitted standard ERC-20 behavior only; do not claim native ETH, Permit2, taxed, rebasing, callback-token, arbitrary-call, or router-provenance support.
