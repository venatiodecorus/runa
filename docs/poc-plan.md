# Proof-of-Concept Plan

**Status:** v0.1 — ready to execute. Phases map to design §12 milestones. Work top-to-bottom; each phase is independently testable and demoable. Check boxes off in this file as tasks complete (that's its job — it is the shared work ledger).

## PoC scope & thesis

The PoC must demonstrate, end to end, in a real browser:

1. **Self-sovereign identity** — keypair-only signup, recovery kit, device certs, re-enrollment (M1).
2. **Subjective trust** — a feed ranked by published 2-hop math that the client recomputes and enforces locally (M2).
3. **Real E2E** — tier-2 DMs where a full server-DB dump provably contains no plaintext (M3).
4. *(stretch)* **Reach rationing** — cold-outreach token buckets (M4), since "reach is the rationed resource" is the core thesis.

Out of PoC scope (post-PoC roadmap = design §12 M5–M9): tier-3 epoch posts, attestation, standing/reports, invites/explore, transparency infrastructure. The PoC threat model note in [`threat-model.md`](threat-model.md) applies: don't demo it as spam-resistant.

**PoC exit demo script:** two fresh browser profiles → sign up A and B (recovery kits shown) → A posts publicly → B follows A, sees post ranked by client-verified trust → B clears site data, recovers from word list in <1 min, still has identity and follows → A DMs B; open the SQLite file and show ciphertext → (stretch) fresh account C burns its 5 cold tokens and hits the request tray.

---

## Phase 0 — Scaffolding

Goal: `make dev` runs both halves; `make test` and `make lint` pass on empty-ish code.

- [ ] `server/`: Go module `github.com/VenatioDecorus/runa/server`; `cmd/runad/main.go` serving `/api/v1/healthz`; `internal/store` with SQLite open + embedded-migration runner (migration 0001: empty baseline); config via flags/env (`RUNAD_ADDR` default `:8080`, `RUNAD_DB` default `./runa.db`).
- [ ] `web/`: Vite + React + TS strict scaffold; Vitest wired; dev-server proxy `/api` → `localhost:8080`; deps from [ADR-0004](decisions/adr-0004-crypto-libraries.md) installed.
- [ ] Root `Makefile`: `dev` (both, via two processes), `test`, `lint` (`go vet` + `golangci-lint` if available; `tsc --noEmit` + eslint), `vectors-test` placeholder.
- [ ] `docs/protocol/vectors/` directory with README stub explaining the shared-fixture contract.
- [ ] Update CLAUDE.md "Commands" section with the real, verified commands.

## Phase 1 — Identity & custody + public posts (M1)

Goal: signup → recovery kit → signed tier-1 posts → device loss is a non-event.

**Protocol/core (both languages, vector-driven — build first):**
- [ ] JCS canonicalization + vectors (incl. "no floats" rejection).
- [ ] Record sign/verify: `device-cert`, `device-revoke`, `profile`, `post`; cert-chain verification (device → root, revocation honored); vectors for valid + tampered + revoked cases.
- [ ] Recovery kit: seed ↔ BIP39 words ↔ key file; Argon2id passphrase blob; vectors.

**Server:**
- [ ] Migrations: `accounts`, `records` (content-addressed id, author, device, type, created_at, body JSON), `devices` (cert/revocation materialized).
- [ ] `POST /accounts`, `GET /accounts/{id}`, `POST /records` (verify-on-ingest), `GET /accounts/{id}/records`, challenge auth (`GET /auth/challenge` + signed-challenge token middleware), `POST /backup` + fetch.
- [ ] Integration tests: signup, post, tampered-record rejection, revoked-device rejection.

**Client:**
- [ ] `src/crypto/`: keygen (root seed → Ed25519; device Ed25519+X25519), IndexedDB key store (device keys + optional working root copy).
- [ ] Signup flow: generate → **recovery-kit screen (download + words, confirm) → browsing**. One screen, per design §2.3.
- [ ] Import/recovery flow: paste words or upload key file → new device cert → session live (~30 s target).
- [ ] Device management UI: list certs, revoke (root-gated), add-device via key import (QR handoff deferred).
- [ ] Compose + profile view + own-posts timeline, signatures verified client-side before render.

**Exit:** demo steps 1, and recovery leg of step 4, work in two browser profiles.

## Phase 2 — Graph, trust, feed (M2)

Goal: follows/mutes exist; feed ranked by published math; client re-verifies.

- [ ] Protocol/core: `follow`/`unfollow`/`mute`/`unmute` records + vectors; trust computation (hop cap 2, decay 0.35, path sum cap 2.0, mute pruning) implemented in **both** Go and TS against shared graph-fixture vectors — including the constants-agreement vector.
- [ ] Server: graph tables + visibility enforcement (outbound follows follower-visible w/ public opt-up; inbound count-only; mutes never served to others); `GET /accounts/{id}/follows`, `GET /graph/2hop`, `GET /feed` candidate ranking.
- [ ] Client: follow/mute UI; feed page that fetches candidates + 2-hop slice, recomputes `effective_trust`, re-ranks, buckets by threshold 0.3; dev-mode divergence badge when server order ≠ client order (design §3.3 audit made visible).
- [ ] Measure & note in this file: 2-hop fetch + client compute latency at toy scale (the §13 testing flag — start the habit).

**Exit:** demo step 2; muting a hop-1 account visibly zeroes its hop-2 contributions.

## Phase 3 — Tier-2 DMs (M3)

Goal: E2E DMs surviving multi-device; server dump shows ciphertext only.

- [ ] Protocol/core: envelope v1 (protocol §4) seal/open in TS; open (structure/signature verification only — servers can't decrypt) in Go; full envelope vector with private keys; conversation-binding anti-replay check.
- [ ] Server: `dm` record ingest (signature + cert chain on the *envelope*, ciphertext opaque), `GET /dm/inbox`, `GET /dm/with/{id}`; polling (SSE/websocket deferred).
- [ ] Client: conversation list + thread UI; encrypt to all certified, unrevoked devices of both participants; decrypt-verify-render (hard-fail on either); revoked-device exclusion test.
- [ ] Request-tray *placeholder*: DMs from accounts with no trust path land in a separate "Requests" tab (classification only — no budgets yet; becomes real in Phase 4).

**Exit:** demo step 5 including the SQLite-dump inspection.

## Phase 4 — Reach budgets (M4) — stretch

Goal: cold outreach costs tokens; conversations, once accepted, are free.

- [ ] Protocol/core: cold-classification (recipient-vantage, ≤2 hops above threshold) shared-vector-tested in both languages; reciprocal-engagement window rules.
- [ ] Server: token-bucket table (base 5/day open signup, carryover cap 2 days, growth `k·log(1+Σ inbound_trust)`), spend on cold DM/mention/reply-notification/follow-notification, `429`-style budget error with published-constant explanation.
- [ ] Client: request tray accept/decline; budget meter in compose; graceful budget-exhausted UX.
- [ ] Explicitly deferred within M4: signup PoW, behavioral friction hooks, standing multiplier (constant 1.0).

**Exit:** demo step 6.

---

## Working agreements for implementing agents

- Build order within every phase: **vectors → core libs → server → client**. Never implement a format the spec doesn't define — extend [`protocol.md`](protocol.md) in the same PR.
- Never violate the invariants list in [`architecture.md`](architecture.md); when a task seems to require it, stop and surface the conflict instead.
- Update this file's checkboxes and the "Measured" notes as you go; it is the coordination surface between sessions.
