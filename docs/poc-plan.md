# Proof-of-Concept Plan

**Status:** v0.1 — ready to execute. Phases map to design §12 milestones. Work top-to-bottom; each phase is independently testable and demoable. Check boxes off in this file as tasks complete (that's its job — it is the shared work ledger).

## PoC scope & thesis

The PoC must demonstrate, end to end, in a real browser:

1. **Self-sovereign identity** — keypair-only signup, recovery kit, device certs, re-enrollment (M1).
2. **Subjective trust** — a feed ranked by published 2-hop math that the client recomputes and enforces locally (M2).
3. **Real E2E** — tier-2 DMs where a full server-DB dump provably contains no plaintext (M3).
4. **Constant tuning with evidence** — simlab (design §16): tweak any published constant, watch reach metrics and charts change over a simulated population; scenario files checked in (Phase S).
5. *(stretch)* **Reach rationing** — cold-outreach token buckets (M4), since "reach is the rationed resource" is the core thesis. (simlab models budgets in Phase S regardless — tuning precedes enforcement.)

Cross-cutting from Phase 0 (design §15): the client is instance-agnostic (API base is config), the server self-describes via `/meta`, and nothing privileges the primary instance. The plain-language [explainers](explainers/) exist now and must track any algorithm/crypto change.

Out of PoC scope (post-PoC roadmap = design §12 M5–M9): tier-3 epoch posts, attestation, standing/reports, invites/explore, transparency infrastructure, the M9 operator guide/Docker image, federation (deferred by design). The PoC threat model note in [`threat-model.md`](threat-model.md) applies: don't demo it as spam-resistant.

**PoC exit demo script:** two fresh browser profiles → sign up A and B (recovery kits shown) → A posts publicly → B follows A, sees post ranked by client-verified trust → B clears site data, recovers from word list in <1 min, still has identity and follows → A DMs B; open the SQLite file and show ciphertext → open simlab, load the baseline 10k-account scenario, drag decay 0.35→0.5, watch the reach distribution and newcomer-ceiling metric move → (stretch) fresh account C burns its 5 cold tokens and hits the request tray.

---

## Phase 0 — Scaffolding

Goal: `make dev` runs both halves; `make test` and `make lint` pass on empty-ish code.

- [x] `server/`: Go module `github.com/VenatioDecorus/runa/server`; `cmd/runad/main.go` serving `/api/v1/healthz` (plus `/api/v1/meta`, pulled forward from Phase 1); `internal/store` with SQLite open + embedded-migration runner (migration 0001: empty baseline); config via flags/env (`RUNAD_ADDR` default `:8080`, `RUNAD_DB` default `./runa.db`).
- [x] TS workspaces (ADR-0006): root `package.json` with `packages/core` (framework-free, Vitest wired), `web` (Vite + React + TS strict, imports core, dev-server proxy `/api` → `localhost:8080`, **API base URL as config** — instance-agnostic from day one), `simlab` (Vite + TS scaffold importing core, empty shell is fine); deps from [ADR-0004](decisions/adr-0004-crypto-libraries.md) installed in `web`.
- [x] Root `Makefile`: `dev` (server+web), `simlab` (dev-serve the simulator), `test`, `lint` (`go vet`; `tsc --noEmit` across workspaces — eslint/golangci-lint deferred until there's code worth styling), `vectors-test` placeholder.
- [x] `docs/protocol/vectors/` directory with README stub explaining the shared-fixture contract.
- [x] Update CLAUDE.md "Commands" section with the real, verified commands.

## Phase 1 — Identity & custody + public posts (M1)

Goal: signup → recovery kit → signed tier-1 posts → device loss is a non-event.

**Protocol/core (both languages, vector-driven — build first):**
- [x] JCS canonicalization + vectors (incl. "no floats" rejection).
- [x] Record sign/verify: `device-cert`, `device-revoke`, `profile`, `post`; cert-chain verification (device → root, revocation honored); vectors for valid + tampered + revoked cases.
- [x] Recovery kit: seed ↔ BIP39 words ↔ key file; Argon2id passphrase blob; vectors (recovery-kit-01; Argon2id excluded from vectors by design — too slow for CI).

**Server:**
- [x] Migrations: `accounts`, `records` (content-addressed id, author, device, type, created_at, body JSON), `devices` (cert/revocation materialized) — plus `sessions` and `backups`.
- [x] `GET /meta` (instance name, software/protocol versions, running constants — design §15), `POST /accounts`, `GET /accounts/{id}`, `POST /records` (verify-on-ingest), `GET /accounts/{id}/records`, challenge auth (`GET /auth/challenge` + signed-challenge token middleware), `POST /backup` + fetch (fetch deliberately unauthenticated — caveat in protocol §6).
- [x] Integration tests: signup, post, tampered-record rejection, revoked-device rejection (+ pagination, backup roundtrip, challenge single-use; plus a scripted full-stack smoke driving the web client's own modules against runad).

**Client:**
- [x] `src/crypto/`: keygen (root seed → Ed25519; device Ed25519+X25519), IndexedDB key store (device keys + optional working root copy).
- [x] Signup flow: generate → **recovery-kit screen (download + words, confirm) → browsing**. One screen, per design §2.3 (optional passphrase-backup step included).
- [x] Import/recovery flow: paste words or upload key file (or account id + passphrase → server blob) → new device cert → session live (~30 s target).
- [x] Device management UI: list certs, revoke (root-gated), add-device via key import (QR handoff deferred).
- [x] Compose + profile view + own-posts timeline, signatures verified client-side before render (unverifiable records show a placeholder, never content).

**Exit:** the signup/recovery-kit and word-list-recovery legs of the demo work in two browser profiles.

## Phase 2 — Graph, trust, feed (M2)

Goal: follows/mutes exist; feed ranked by published math; client re-verifies.

- [x] *(TS half + vectors done; Go trust mirror in progress)* Protocol/core: `follow`/`unfollow`/`mute`/`unmute` records + vectors; trust computation (hop cap 2, decay 0.35, path sum cap 2.0, mute pruning) implemented in **both** `packages/core` (TS) and Go against shared graph-fixture vectors (trust-graph-01) — including the constants-agreement vector (Go ≡ core ≡ the table in `trust-and-reach.md`).
- [ ] Server: graph tables + visibility enforcement (outbound follows follower-visible w/ public opt-up; inbound count-only; mutes never served to others); `GET /accounts/{id}/follows`, `GET /graph/2hop`, `GET /feed` candidate ranking.
- [ ] Client: follow/mute UI; feed page that fetches candidates + 2-hop slice, recomputes `effective_trust` using the constants from the instance's `/meta`, re-ranks, buckets by threshold; dev-mode divergence badge when server order ≠ client order (design §3.3 audit made visible); deviation badge when instance constants ≠ reference defaults (design §15).
- [ ] Measure & note in this file: 2-hop fetch + client compute latency at toy scale (the §13 testing flag — start the habit).

**Exit:** the follow/trust-ranking leg of the demo; muting a hop-1 account visibly zeroes its hop-2 contributions.

## Phase S — Simulation lab (simlab, design §16)

Runs in parallel with Phases 3–4; depends only on Phase 0 scaffolding and Phase 2's core-math task. Budget and (flagged) standing math land in `packages/core` here, *before* the server implements them — core is the reference implementation, the Go server follows it.

- [x] `simlab/src/population/`: seeded deterministic PRNG (no `Math.random`); graph generators (random, small-world/clustered communities, preferential attachment); cohort models — genuine newcomers, well-connected accounts, Sybil rings (brigade cohorts land with the M7 standing model).
- [x] Scenario format (JSON: population spec + cohorts + constant overrides + seed); `scenarios/baseline-10k.json` and `scenarios/sybil-stress.json` checked in.
- [x] Metrics engine over `packages/core` math: per-account reach (number of viewers whose feed surfaces the account ≥ threshold), reach distribution by cohort, newcomer budget trajectory vs follower growth, **% of good-faith accounts ever hitting a budget ceiling** (design §13 target <1% — baseline-10k measures 0.01%), Sybil-ring effective reach vs honest cohort (confined: ring median ≈ ring size).
- [x] Budget math (`base + k·log(1+Σ inbound_trust)`, k=4 published) in `packages/core` with budgets-01 vectors (cold-classification + carryover mechanics land server-side in Phase 4; carryover simulated in simlab).
- [x] Interactive UI: constants panel (live sliders + ≠-reference badges), charts — reach CDF + per-cohort histograms, budget trajectory lines, stat tiles incl. ceiling-target status; re-run on change with visible seed.
- [x] Headless CLI (vite-node): run a scenario or a parameter sweep → JSON/CSV, for scripted tuning and CI regression on constants.
- [x] *(Sybil half)* Red-team scenarios checked in: `sybil-stress` (ring + bridges, confinement asserted in tests); brigade vs diversity-weighting deferred to M7 (needs the standing model).
- [x] Document in `simlab/README.md`: how to run, scenario format, how to cite a scenario in a constant-change PR.

**Exit:** the simlab leg of the demo — load `baseline-10k`, drag decay 0.35→0.5, reach distribution and newcomer-ceiling metrics update live; CLI sweep over `k` emits CSV.

## Phase 3 — Tier-2 DMs (M3)

Goal: E2E DMs surviving multi-device; server dump shows ciphertext only.

- [ ] Protocol/core: envelope v1 (protocol §4) seal/open in TS; open (structure/signature verification only — servers can't decrypt) in Go; full envelope vector with private keys; conversation-binding anti-replay check.
- [ ] Server: `dm` record ingest (signature + cert chain on the *envelope*, ciphertext opaque), `GET /dm/inbox`, `GET /dm/with/{id}`; polling (SSE/websocket deferred).
- [ ] Client: conversation list + thread UI; encrypt to all certified, unrevoked devices of both participants; decrypt-verify-render (hard-fail on either); revoked-device exclusion test.
- [ ] Request-tray *placeholder*: DMs from accounts with no trust path land in a separate "Requests" tab (classification only — no budgets yet; becomes real in Phase 4).

**Exit:** the DM leg of the demo including the SQLite-dump inspection.

## Phase 4 — Reach budgets (M4) — stretch

Goal: cold outreach costs tokens; conversations, once accepted, are free.

- [ ] Protocol/core: cold-classification (recipient-vantage, ≤2 hops above threshold) shared-vector-tested in both languages; reciprocal-engagement window rules.
- [ ] Server: token-bucket table (base 5/day open signup, carryover cap 2 days, growth `k·log(1+Σ inbound_trust)`), spend on cold DM/mention/reply-notification/follow-notification, `429`-style budget error with published-constant explanation.
- [ ] Client: request tray accept/decline; budget meter in compose; graceful budget-exhausted UX.
- [ ] Explicitly deferred within M4: signup PoW, behavioral friction hooks, standing multiplier (constant 1.0).

**Exit:** the budget leg of the demo (account C hits the request tray).

---

## Working agreements for implementing agents

- Build order within every phase: **vectors → core libs → server → client**. Never implement a format the spec doesn't define — extend [`protocol.md`](protocol.md) in the same PR.
- Never violate the invariants list in [`architecture.md`](architecture.md) — including "no primary-instance privilege"; when a task seems to require it, stop and surface the conflict instead.
- Any change to reach algorithms or crypto updates the matching [explainer](explainers/) in the same change; any change to a published constant cites a checked-in simlab scenario (once Phase S lands).
- Update this file's checkboxes and the "Measured" notes as you go; it is the coordination surface between sessions.
