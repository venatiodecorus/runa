# Proof-of-Concept Plan

**Status:** Phases 0–5 + S complete. **Phase 5 (M5, tier-3 scoped posts) landed 2026-08-22** — protocol §5 normative, both implementations vector-tested, exit criteria verified by a scripted client-vs-runad run (19/19). Next up: M6 (attestation) per design §12; remaining roadmap M7–M9 (standing/reports, invites/explore, transparency infrastructure) plus the §13 watch-items (real-browser latency at realistic graph sizes before settling §3.3). Groups (design §18) are unblocked now that the epoch recipient set is an abstract source. This file remains the shared work ledger.

## PoC scope & thesis

The PoC must demonstrate, end to end, in a real browser:

1. **Self-sovereign identity** — keypair-only signup, recovery kit, device certs, re-enrollment (M1).
2. **Subjective trust** — a feed ranked by published 2-hop math that the client recomputes and enforces locally (M2).
3. **Real E2E** — tier-2 DMs where a full server-DB dump provably contains no plaintext (M3).
4. **Constant tuning with evidence** — simlab (design §16): tweak any published constant, watch reach metrics and charts change over a simulated population; scenario files checked in (Phase S).
5. *(stretch)* **Reach rationing** — cold-outreach token buckets (M4), since "reach is the rationed resource" is the core thesis. (simlab models budgets in Phase S regardless — tuning precedes enforcement.)

Cross-cutting from Phase 0 (design §15): the client is instance-agnostic (API base is config), the server self-describes via `/meta`, and nothing privileges the primary instance. The plain-language [explainers](explainers/) exist now and must track any algorithm/crypto change.

Out of PoC scope (post-PoC roadmap = design §12 M5–M9): tier-3 epoch posts, attestation, standing/reports, invites/explore, transparency infrastructure, the M9 operator guide/Docker image, federation (deferred by design). **Groups** (design §18, added 2026-08-21) are a recorded post-M5 direction: private groups reuse M5's epoch machinery with an explicit roster (so M5 must spec the recipient set abstractly — see protocol §5), public groups are a crypto-free curation layer pairing naturally with M8. The PoC threat model note in [`threat-model.md`](threat-model.md) applies: don't demo it as spam-resistant.

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

- [x] Protocol/core: `follow`/`unfollow`/`mute`/`unmute` records + vectors; trust computation (hop cap 2, decay 0.35, path sum cap 2.0, mute pruning) implemented in **both** `packages/core` (TS) and Go against shared graph-fixture vectors (trust-graph-01) — including the constants-agreement vector (Go ≡ core ≡ the table in `trust-and-reach.md`).
- [x] Server: graph tables + visibility enforcement (outbound follows follower-visible w/ public opt-up via profile `follows_public`; inbound count-only; mutes never served to others — /records restricted to public types to close the leak); `GET /accounts/{id}/follows`, `GET /graph/2hop`, `GET /feed` candidate ranking with authors cert bundle.
- [x] Client: follow/mute UI; feed page that fetches candidates + 2-hop slice, recomputes `effective_trust` using the constants from the instance's `/meta`, re-ranks, buckets by threshold; divergence badge when server order ≠ client order (local order always shown — design §3.3); deviation badge when instance constants ≠ reference defaults (design §15).
- [x] Measure & note in this file: 2-hop fetch + client compute latency at toy scale (the §13 testing flag — start the habit). **Measured 2026-08-21** (scripted client vs local runad, 3 accounts): /graph/2hop fetch 0.6 ms, trustMap + re-rank 1.1 ms. simlab gives the compute-side at scale: full 10k-account trustMap sweep ≈ hundreds of ms total (see simlab stat tile). Real-browser numbers at realistic graph sizes still needed before calling §3.3.

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

- [x] Protocol/core: envelope v1 (protocol §4) seal/open in TS (packages/core); structural/signature verification in Go (no decryption); envelope-v1-01 vector with private keys; conversation-binding anti-replay check.
- [x] Server: `dm` record ingest (signature + cert chain on the *envelope*, ciphertext opaque, pinned alg), `GET /dm/inbox`, `GET /dm/with/{id}`; polling (SSE/websocket deferred).
- [x] Client: conversation list + thread UI; encrypt to all certified, unrevoked devices of both participants; verify-then-decrypt-render (hard-fail placeholders, benign 'sent before this device enrolled' case distinguished); revoked-device exclusion test.
- [x] Request-tray *placeholder*: DMs from accounts with no trust path land in a separate "Requests" section (classification only; server flag = no trust path AND never replied; becomes real in Phase 4).

**Exit:** the DM leg of the demo including the SQLite-dump inspection. **Verified 2026-08-21** via scripted client-vs-runad run: stranger DM → request tray, decrypt on recipient device, reply clears request flag, `grep` of the server DB finds no plaintext.

## Phase 4 — Reach budgets (M4) — stretch

Goal: cold outreach costs tokens; conversations, once accepted, are free.

- [x] Protocol/core: cold-classification (recipient-vantage, ≤2 hops above threshold) shared-vector-tested in both languages (cold-01); reciprocal-engagement window = recipient previously DM'd the sender (storage-backed predicate, server-side).
- [x] Server: token-bucket table (base 5/day open signup, carryover cap 2 days, growth `k·log(1+Σ inbound_trust)`), spend on cold DM and cold follow (mentions/reply-notifications deferred until notifications exist — the reply record itself is never blocked, throttle-don't-silence), `429 budget_exhausted` with published-constant explanation, atomic spend, lazy daily refill with injected clock.
- [x] Client: request tray Accept & reply / Dismiss (browser-local, restorable; decline-with-report deferred to M7); budget meter in the DM composer (server value audited against core math); graceful budget-exhausted UX preserving drafts, on DMs and follows.
- [x] Explicitly deferred within M4 (unchanged): signup PoW, behavioral friction hooks, standing multiplier (constant 1.0).

**Exit:** the budget leg of the demo (account C hits the request tray). **Verified 2026-08-21** via scripted run: fresh account = 5 tokens, five cold DMs delivered to strangers' request trays, sixth rejected 429 with the published-constants message; /budget tracks the burn.

## Owner addition — imageboard mode (design §17, added 2026-08-21)

Per-instance mode disabling profile customization: no display names, bios, or account metadata — accounts render as their ids; judge users by their content. Configurable per instance, disclosed via `/meta`.

- [x] Server: `-imageboard` flag / `RUNAD_IMAGEBOARD` env; `imageboard_mode` in `/meta`; reject `profile` records with `403 profile_disabled` when on.
- [x] Client: when the instance's `/meta` says imageboard mode, hide profile editing and never render profile records — short account ids everywhere (the client stays instance-agnostic: both modes supported).
- [x] Tests both sides; protocol §6 updated (done in the same change as this entry).

## Owner addition — dev seeding (added 2026-08-21)

Repeatable manual-testing fixtures without hand-driving browser sessions. The seeder acts as N real clients through the web client's own crypto/API modules (never touches the DB), so it doubles as a standing full-stack exercise of signup → auth → posts → follows → DMs, including a cold DM landing in the request tray.

- [x] `web/scripts/seed.ts` + `seed-fixture.json` (8-persona cast: 1-hop/2-hop trust structure from alice's vantage, a newcomer, and a stranger who spends a cold token); root seeds derived deterministically from handles, so account ids are stable across reseeds; recovery word lists written to `testKeys/seed-personas.json` (gitignored) for entering any persona via the browser Recover flow.
- [x] `make seed` (needs the dev server running; `SEED_API_BASE` overridable) and `make reset` (delete the SQLite files; stop server first, restart after). Fresh-DB only — reruns exit 1 with the reset recipe on the first `account_exists` 409.

---

## Phase 5 — Tier-3 scoped posts (M5)

Goal: "My follows" / "My web" scoped posts via epoch keys (protocol §5, now normative); snapshot semantics; lazy client-driven rotation; server dump shows ciphertext only. The epoch recipient set is an abstract source (graph scope now, group roster later — design §18 constraint honored in the wire format).

**Protocol/core (vectors first):**
- [x] `packages/core`: epoch seal/open (`epoch`, `epoch-key`, `scoped-post` records; wrap info `"runa/v1/epoch-wrap:"+epoch_id`; AAD = header minus `ciphertext`/`sig`); scope enumeration (`follows` = hop-1 set minus mutes — design §7.1: mute is a membership-removal event; `web` = trustMap ≥ threshold) over the existing GraphView; rotation predicate (member-set diff ∨ age > `epoch_max_age_days`), `nowIso` injected.
- [x] Vectors: `epoch-v1-01` (full private keys; valid epoch + key + post; tamper cases: ciphertext flip, cross-epoch wrap replay, transplanted AAD, bad sig) and `scope-01` (graph fixture → concrete member sets for both scopes, incl. muted-but-followed exclusion); consumed by TS tests (Go consumes `epoch-v1-01` for structural/signature verification — no decryption server-side).

**Server:**
- [x] Ingest `epoch` / `epoch-key` / `scoped-post` via `POST /records`: reserved-scope rejection, `unknown_epoch`, pinned alg (`unsupported_alg`, same code as tier-2), `not_epoch_author` / `not_epoch_member` authorization (protocol §6); epoch/member materialization tables (migration 0006).
- [x] `GET /epochs/keys` (viewer's key grants + inlined epoch records, paginated); member-only scoped-post delivery in `/feed` and `/accounts/{id}/records` (silent omission for non-members — unauthenticated listing returns empty, never a revealing 401/403; tier-3 types excluded from public listings).
- [x] Integration tests: membership enforcement, non-member silent omission, late-wrap acceptance rules, snapshot-across-epochs, key-possession-without-trust gets no feed placement (§5.6), ciphertext-only-in-DB grep check (WAL checkpointed first).

**Client:**
- [x] Compose: audience selector (Public / My follows / My web); epoch manager in `web/src/crypto/epochs.ts` — create/rotate per §5.5 (recompute set before every scoped post), key storage over the existing kv store (disposable like device keys — recovery restores identity, not history); drafts preserved on failure.
- [x] Feed + own timeline: fetch `/epochs/keys` (grants signature-verified, inlined epoch records content-address-checked), verify-then-decrypt-render scoped posts (hard-fail placeholders; "no key for this epoch" is a distinguished benign state); scope badge on scoped posts.
- [x] Re-enrollment late-wrap: author's client re-wraps the current epoch key to newly-certified own devices (§5.3, delta only — already-covered devices are not re-wrapped).

**Exit:** two browser profiles: A posts to "My follows"; follower B sees and decrypts it in their feed with a scope badge; stranger C never receives the record (API-level check); B unfollowed → next post in a fresh epoch, B's client shows nothing new; server SQLite dump greps clean of plaintext; A re-enrolls a device and can still read their own scoped history going forward. **Verified 2026-08-22** via scripted client-vs-runad run (web client's own modules, fresh DB): 19/19 assertions — member decrypt, stranger silent omission, rotation with `prev` linkage on unfollow, snapshot semantics (B still reads pre-removal history), late-wrap to a re-enrolled device, DB grep finds ciphertext records but zero plaintext. The run surfaced and fixed one client bug: `listRecords()` wasn't attaching the bearer token, so the member-gated `type=scoped-post` listing silently omitted even the owner's own scoped history.

## Working agreements for implementing agents

- Build order within every phase: **vectors → core libs → server → client**. Never implement a format the spec doesn't define — extend [`protocol.md`](protocol.md) in the same PR.
- Never violate the invariants list in [`architecture.md`](architecture.md) — including "no primary-instance privilege"; when a task seems to require it, stop and surface the conflict instead.
- Any change to reach algorithms or crypto updates the matching [explainer](explainers/) in the same change; any change to a published constant cites a checked-in simlab scenario (once Phase S lands).
- Update this file's checkboxes and the "Measured" notes as you go; it is the coordination surface between sessions.
- Conserve the owner's plan usage: hand self-contained work to subagents on an explicitly chosen non-Fable model (haiku for mechanical work, sonnet for most search/code tasks, opus for hard substeps), and give each subagent the file paths, doc references, and constraints it needs — see "Subagents & model selection" in CLAUDE.md.
