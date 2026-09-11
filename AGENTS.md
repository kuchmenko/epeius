# Epeius contributor guidance

## Code Review Rules

- Preserve the trust split: the engine builds and simulates unsigned, independently checkable transactions but never owns keys, consent, signing, submission, or receipt verification. The terminal owns those decisions.
- Keep `proto/epeius/quote/v1/quote.proto` and canonical ABIs authoritative. Never hand-edit generated bindings. Treat integer values, field presence, statuses, route identity, and calldata as exact cross-language contracts, with expected vectors derived independently from production encoders.
- Report only reachable regressions introduced by the diff. Leave formatting, lint, generated drift, and established deterministic checks to CI. Treat the default branch as current product truth, and never claim that mocked, local-EVM, fork, dated live, or production evidence proves another layer.
