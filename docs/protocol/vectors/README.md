# Protocol test vectors

Shared JSON fixtures consumed by **both** the Go (`server/`) and TypeScript (`web/`) test suites. They are the mechanism that keeps the two deliberately-duplicated implementations (record verification, trust math — see `docs/architecture.md`) in lockstep, and part of what makes the protocol third-party-implementable.

Contract:

- Each file is self-contained: all inputs (including private keys — these are test keys, never real ones), the expected canonical bytes / signature / ciphertext / trust scores, and `"valid": true|false` cases with a `reason`.
- A change to `docs/protocol.md` or `docs/trust-and-reach.md` formats/constants without a matching vector change is rejected in review.
- Naming: `<area>-<nn>.json`, e.g. `jcs-01.json`, `records-01.json`, `envelope-v1-01.json`, `trust-graph-01.json`, `recovery-kit-01.json`, `constants-01.json`, `attest-01.json`, `safety-number-01.json`.

Created per milestone (see `docs/poc-plan.md`); currently empty by design.
