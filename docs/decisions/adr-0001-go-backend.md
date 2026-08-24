# ADR-0001: Go for the backend

**Status:** accepted · 2026-08-20

## Context

The server is deliberately dumb (design §1.3): a signed-record store, ciphertext mailbox, graph store, and candidate ranker. It needs strong concurrency for fan-out, a good standard crypto library (Ed25519 verification on every ingest), easy single-binary deployment, and long-term maintainability by agents and contributors. Project owner has a stated preference for Go, open to alternatives with sufficient reason.

## Decision

Go (≥1.23), standard library `net/http` with 1.22+ pattern routing — no web framework. Alternatives considered: **Rust** (best-in-class crypto ecosystem, but slower iteration for a PoC and the server holds no secrets worth Rust's guarantees — the client is the security perimeter); **TypeScript/Node** (would unify languages with the client and allow sharing the record/trust code instead of duplicating it — but the duplication is *by design* as the audit mechanism, which removes the main argument). Nothing outweighs the preference; Go is also simply a good fit for this shape of server.

## Consequences

- Record verification and trust math are implemented twice (Go + TS) — intended; shared JSON test vectors keep them in lockstep (protocol §10).
- `crypto/ed25519`, `golang.org/x/crypto` (curve25519, chacha20poly1305, hkdf) cover every server-side primitive with no cgo.
- Single static binary + SQLite file = trivial PoC deployment.
