# Runa

A privacy-respecting social network where **posting is free and *reach* is the rationed resource**. Spam is treated as an economics problem, defeated by trust-graph position that attackers cannot buy or mint. Content privacy is enforced by client-side cryptography, not server policy.

**Status:** pre-code. Design is complete; documentation and PoC plan are in place; implementation starts at [`docs/poc-plan.md`](docs/poc-plan.md) Phase 0.

## Core ideas

- **Identity is a keypair.** No email, no phone. Root key generated client-side, exported at birth (key file + word list); disposable per-device keys do the daily work. Losing a device is a non-event.
- **Trust is subjective.** No global reputation score — each viewer's feed is ranked by *their* position in the follow graph (2 hops, published math), recomputed and enforced client-side.
- **The server is a dumb, honest-but-curious mailbox.** It stores signed records and ciphertext; it never holds a decryption key for private content and cannot forge anything.
- **Throttle, don't silence.** Penalties shrink reach to strangers; they never sever chosen connections or delete content. Reach can be earned, never bought.
- **Transparent by construction.** All algorithms and constants are published; every user can recompute why their own feed ranks as it does.

## Documentation map

| Document | What it is |
|---|---|
| [`design-doc.md`](design-doc.md) | The normative design (handoff brief) — start here for *why* |
| [`docs/architecture.md`](docs/architecture.md) | System shape, tech stack, repo layout, invariants |
| [`docs/poc-plan.md`](docs/poc-plan.md) | Phased implementation plan with task checklists — start here for *what's next* |
| [`docs/threat-model.md`](docs/threat-model.md) | Adversaries, mitigations, honest limitations |
| [`docs/protocol.md`](docs/protocol.md) | Wire formats: keys, signed records, envelopes, API |
| [`docs/trust-and-reach.md`](docs/trust-and-reach.md) | The trust/budget math + published constants table |
| [`docs/governance.md`](docs/governance.md) | Where human judgment lives; how algorithms change |
| [`docs/decisions/`](docs/decisions/) | ADRs for stack and format choices |

## Stack

Go backend (stdlib HTTP, SQLite) · TypeScript/React/Vite web client · `@noble` crypto · JCS-canonical-JSON signed records. Rationale in the ADRs.

The four documents under `docs/` marked as living specs are versioned and changed through the same review process as code — a spec change is a protocol change, not a wiki edit.
