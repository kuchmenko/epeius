# Epeius contributor guidance

## Code Review Rules

- Treat the default branch as product truth. Draft pull requests and plans describe non-current work unless their changes have merged.
- Keep `proto/epeius/quote/v1/quote.proto` authoritative. Never hand-edit generated Go or TypeScript bindings, reserve removed fields and names, regenerate both languages, and run the generated-file drift check.
- Preserve the trust split: the engine builds and simulates unsigned transactions; the terminal independently validates exact terms and owns consent, signer integration, one submission handoff, and receipt checks. The engine must never sign, submit, or hold keys.
- Treat integer values, field presence, statuses, and ABI bytes as cross-language contracts. Derive expected vectors independently from production encoders. Use the canonical checks in `docs/development.md`; do not add duplicate check suites under new names.
