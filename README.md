# Runa

A privacy-respecting social network where **posting is free and *reach* is the rationed resource**. Spam is treated as an economics problem, defeated by trust-graph position that attackers cannot buy or mint. Content privacy is enforced by client-side cryptography, not server policy.

**Status:** PoC implementation in progress. Identity & custody (M1), the trust-ranked feed (M2), E2E DMs (M3), and the simulation lab are working end to end; reach budgets (M4) are landing. [`docs/poc-plan.md`](docs/poc-plan.md) is the live ledger — its checkboxes are the source of truth.

## Quick start (dev)

```sh
npm install       # once, repo root (npm workspaces)
make dev          # API server :8080 + web client (Vite) — two browser profiles = two users
make simlab       # the constants-tuning simulator
make test         # Go + Vitest suites, including cross-implementation protocol vectors
```

## Core ideas

- **Identity is a keypair.** No email, no phone. Root key generated client-side, exported at birth (key file + word list); disposable per-device keys do the daily work. Losing a device is a non-event.
- **Trust is subjective.** No global reputation score — each viewer's feed is ranked by *their* position in the follow graph (2 hops, published math), recomputed and enforced client-side.
- **The server is a dumb, honest-but-curious mailbox.** It stores signed records and ciphertext; it never holds a decryption key for private content and cannot forge anything.
- **Throttle, don't silence.** Penalties shrink reach to strangers; they never sever chosen connections or delete content. Reach can be earned, never bought.
- **Transparent by construction.** All algorithms and constants are published — as specs, and as [plain-language explainers](docs/explainers/) of how reach and the crypto work; every user can recompute why their own feed ranks as it does. Constants are tuned in the open via **simlab**, an in-repo simulator that runs the client's actual trust/budget code over synthetic populations, with interactive charts.
- **Self-hostable.** The project runs a primary instance, but anyone can stand up their own from the same source — no primary-instance privilege in code. Identity keypairs are yours, not the operator's. See [`docs/self-hosting.md`](docs/self-hosting.md).

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
| [`docs/explainers/`](docs/explainers/) | Plain-language: [how reach works](docs/explainers/how-reach-works.md) · [how the crypto works](docs/explainers/how-crypto-works.md) |
| [`docs/self-hosting.md`](docs/self-hosting.md) | Instance model: primary + self-hosted, no code privilege |
| [`docs/decisions/`](docs/decisions/) | ADRs for stack and format choices |

## Stack

Go backend (stdlib HTTP, SQLite) · TypeScript/React/Vite web client · shared TS core package (trust/budget math, also powering the simlab simulator) · `@noble` crypto · JCS-canonical-JSON signed records. Rationale in the ADRs.

The four documents under `docs/` marked as living specs are versioned and changed through the same review process as code — a spec change is a protocol change, not a wiki edit.
