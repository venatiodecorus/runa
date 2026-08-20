# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Runa** — a privacy-respecting social network where reach (not posting) is the rationed resource, trust is computed subjectively from each viewer's position in the follow graph, and private content is protected by client-side cryptography. The server is a dumb, honest-but-curious mailbox.

**Current state: pre-code.** Docs and plans are complete; no server/ or web/ code exists yet. Implementation work starts at `docs/poc-plan.md` **Phase 0** and proceeds top-to-bottom, checking off tasks in that file as you go — it is the shared work ledger between sessions.

## Reading order for a new session

1. `docs/poc-plan.md` — what to do next (checkboxes = current state).
2. `docs/architecture.md` — system shape, repo layout, and the **non-negotiable invariants** list.
3. `docs/protocol.md` — wire formats; consult before writing any record/envelope/API code.
4. `design-doc.md` — the normative design; cite it, don't re-derive it. `docs/threat-model.md` and `docs/trust-and-reach.md` fill in security and math detail.

## Commands

No build exists yet. Phase 0 of `docs/poc-plan.md` creates a root `Makefile` with `dev` / `test` / `lint` targets covering both halves (Go: `go test ./...`, `go vet`; web: Vitest, `tsc --noEmit`). **When Phase 0 lands, replace this section with the real, verified commands** — including how to run a single Go test (`go test ./internal/... -run TestName`) and a single Vitest file.

## Architecture (big picture)

Two components, one trust boundary:

- `server/` — Go (stdlib `net/http`, SQLite via `modernc.org/sqlite`). Stores signed records and ciphertext, verifies signatures/cert-chains on ingest (hygiene, not authority), serves graph slices, computes *candidate* feed rankings.
- `web/` — TypeScript + React + Vite. Holds all keys (IndexedDB, treated as disposable), does all signing/encryption/decryption, **recomputes trust locally and re-ranks** — nothing renders as trusted unless the client's own math agrees.

Two things are deliberately implemented twice (Go and TS): record canonicalization/verification and the trust computation. That duplication is the audit mechanism — do not "deduplicate" it. Shared JSON test vectors in `docs/protocol/vectors/` keep both sides honest; the build order inside every phase is **vectors → core libs → server → client**.

Key formats: identity = Ed25519 root key (account ID = base64url of the pubkey) signing per-device certs; all stored data = JCS-canonical-JSON records with detached Ed25519 signatures, versioned (`v`/`alg`) from day one; tier-2 DMs = stateless hybrid X25519+HKDF+XChaCha20-Poly1305 envelopes per recipient *device*. Published constants live in exactly `server/internal/trust/constants.go`, `web/src/trust/constants.ts`, and the table in `docs/trust-and-reach.md` — a shared vector asserts they agree.

## Hard rules

- **Invariants in `docs/architecture.md` §"Non-negotiable invariants" override convenience.** If a task seems to require violating one (e.g., server touching a decryption key, trust from behavioral signals, purchasable reach), stop and surface the conflict instead of implementing.
- The four living docs (`threat-model.md`, `protocol.md`, `trust-and-reach.md`, `governance.md`) change via reviewed PRs like code. Never implement a wire format the spec doesn't define — extend `docs/protocol.md` in the same change, with vectors. No floating-point fields in signed records (ADR-0005).
- Client crypto uses the `@noble`/`@scure` family only (ADR-0004); server crypto uses Go stdlib + `golang.org/x/crypto`. Don't introduce other crypto dependencies without an ADR.
