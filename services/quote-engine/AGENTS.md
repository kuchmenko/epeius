# Quote engine review rules

## Code Review Rules

- Preserve exact quote semantics: positive uint256 integer math, deterministic candidate and tie order, gross best-among-returned meaning, one canonical EIP-1898 block, exact sequential-hop inputs, and distinct handling for search-budget expiry versus parent cancellation.
- Build each preparation once from a complete stored route or exact allocations. Recheck may refresh evidence but never requote, rebuild, scale, or alter consent-bound terms. Distinguish protocol kind, deployment ID, and executor venue; validate exact membership and all allocations before network calls.
- Isolate deployment failures and expose only fixed safe errors. Missing pools are normal no-route results, while healthy routes may survive provider failure. Do not require a global limiter, retry, cache, optimizer, generic plugin system, or latency target without a measured current contract.
