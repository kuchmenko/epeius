# Quote engine review rules

## Code Review Rules

- Preserve exact quote semantics: positive uint256 integer math, deterministic candidate and tie order, gross best-among-returned meaning, one canonical EIP-1898 block, exact sequential-hop inputs, and distinct handling for search-budget expiry versus parent cancellation.
- Build each preparation once from a complete stored route or exact allocations. Recheck only persisted terms. Distinguish protocol kind, deployment ID, executor venue, target, and spender. Validate all allocations before quote RPC calls, and never hold store locks across network calls.
- Keep common search, ranking, storage, and recheck flow free of concrete DEX mechanics as protocol-specific code is extracted. Concrete implementations own candidate generation, quoting, verification, calldata, and simulation obligations. Do not add a generic provider or plugin framework, and never expose raw upstream errors.
