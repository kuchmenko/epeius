# Epeius contributor guidance

## Code Review Rules

- Preserve the trust split: the engine builds and simulates unsigned, independently checkable transactions but never owns keys, consent, signing, submission, or receipt verification. The terminal owns those decisions.
- Keep `proto/epeius/quote/v1/quote.proto` and canonical ABIs authoritative. Never hand-edit generated bindings. Treat integer values, field presence, statuses, route identity, and calldata as exact cross-language contracts, with expected vectors derived independently from production encoders.
- Report only reachable regressions introduced by the diff. Leave formatting, lint, generated drift, and established deterministic checks to CI. Treat the default branch as current product truth, and never claim that mocked, local-EVM, fork, dated live, or production evidence proves another layer.
- After addressing a review finding, reply with the relevant commit and verification evidence, then resolve its conversation. Minimize AI reviewer comments that only report review state, progress, completion, limits, or review summaries; keep the actual findings and resolution replies visible.

## Provider and protocol changes

- Keep deployment and network data in strict TOML configuration instead of hardcoding chain IDs or contract addresses in provider code. Verify configured contracts by bytecode, ABI behavior, and required on-chain links. If an exact allowlist is a deliberate security policy, name it, document why it exists, and keep one source of truth.
- Register providers explicitly at compile time. Each provider owns its configuration parsing and validation, quoting, execution preparation, and deployment checks. Common dispatch must select the registered provider and return a clear unsupported-provider error; it must not grow provider-name conditionals for every addition.
- Keep provider-specific configuration in a strict provider-owned options block rather than adding each provider's fields to the common deployment schema. Reject unknown, missing, inapplicable, and explicitly empty fields consistently in every language that reads the configuration.
- Use canonical ABIs and established encoding libraries for addresses, integers, tuples, and packed paths. Do not hand-roll encoding when the library supports the required Solidity type. Where manual encoding is unavoidable, use named protocol constants and explain the byte layout with a link to the authoritative contract or specification.
- Name protocol limits, selectors, special addresses, and other domain values. Explain non-obvious rules and their reason next to the enforcing code, with authoritative links where available. Test fixtures may use synthetic values, but values with protocol meaning must have role-based names.
- Expose provider capabilities explicitly. Do not require providers to implement allocation re-quoting, direct execution, or other behavior they do not support.
- Add a reusable provider guide covering the protocol overview, comparison with related supported providers, official references, configuration, authoritative contracts and ABIs, quote and preparation behavior, account-dependent behavior, limitations, and exact local verification commands. Distinguish upstream protocol facts from Epeius policy. Keep dated fork, simulation, testnet, and production results as separate evidence that links back to the guide.
- Test both sides of protocol boundaries and each supported direction. Include field presence versus explicit emptiness, exact multi-hop token pairs and sequential amounts, complete ABI tuples, deployment bytecode and linkage failures, pinned block identity, and independently derived calldata vectors where those behaviors apply.
