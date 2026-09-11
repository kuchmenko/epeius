# Terminal review rules

## Code Review Rules

- Bind consent to the exact locally admitted chain, sender, recipient, route or ordered allocations, amounts, minimum, deadline, target, spender, value, and calldata. Check response status first and reject any post-review term change before submission.
- Keep ERC-20 approval separate. After a canonical approval receipt, require a fresh quote, preparation, and swap consent. Automatic selection may use the fresh recommendation; a manual route stays pinned; explicit allocations never refresh automatically.
- Make exactly one wallet handoff. Any error after handoff is failed or unknown, never a cancellation and never a reason to resend. Verified success requires the original hash, a canonical nonzero receipt block hash, exact input transfer delta, minimum output, and no protected residue. Keep private-key bytes outside JavaScript.
