# Proof-of-Concept Plan

**Status:** Phases 0–5 + S complete; **Phase 6 (M6, attestation) landed 2026-08-24** — protocol §8 normative, both implementations vector-tested (attest-01, safety-number-01), exit criteria verified by a scripted client-vs-runad run (23/23; browser walkthrough pending owner). **Phase 7 (M7, standing/reports) landed 2026-08-24** — protocol §9 normative, both implementations vector-tested (report-01, standing-01), simlab red-teamed the constants before enforcement (brigade-stress, diverse-reports), exit criteria verified by a scripted client-vs-runad run (32/32, `npm run m7-exit -w web`; browser walkthrough pending owner). Remaining roadmap M8–M9 (invites/explore, transparency infrastructure) plus the §13 watch-items (real-browser latency at realistic graph sizes before settling §3.3). Groups (design §18) are unblocked now that the epoch recipient set is an abstract source. This file remains the shared work ledger.

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

- [x] `simlab/src/population/`: seeded deterministic PRNG (no `Math.random`); graph generators (random, small-world/clustered communities, preferential attachment); cohort models — genuine newcomers, well-connected accounts, Sybil rings (brigade/diverse reporter cohorts landed with M7).
- [x] Scenario format (JSON: population spec + cohorts + constant overrides + seed); `scenarios/baseline-10k.json` and `scenarios/sybil-stress.json` checked in.
- [x] Metrics engine over `packages/core` math: per-account reach (number of viewers whose feed surfaces the account ≥ threshold), reach distribution by cohort, newcomer budget trajectory vs follower growth, **% of good-faith accounts ever hitting a budget ceiling** (design §13 target <1% — baseline-10k measures 0.01%), Sybil-ring effective reach vs honest cohort (confined: ring median ≈ ring size).
- [x] Budget math (`base + k·log(1+Σ inbound_trust)`, k=4 published) in `packages/core` with budgets-01 vectors (cold-classification + carryover mechanics land server-side in Phase 4; carryover simulated in simlab).
- [x] Interactive UI: constants panel (live sliders + ≠-reference badges), charts — reach CDF + per-cohort histograms, budget trajectory lines, stat tiles incl. ceiling-target status; re-run on change with visible seed.
- [x] Headless CLI (vite-node): run a scenario or a parameter sweep → JSON/CSV, for scripted tuning and CI regression on constants.
- [x] *(Sybil half)* Red-team scenarios checked in: `sybil-stress` (ring + bridges, confinement asserted in tests); brigade vs diversity-weighting landed with M7 (`brigade-stress`, `diverse-reports`).
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
- [x] Client: request tray Accept & reply / Dismiss (browser-local, restorable; decline-with-report landed with M7); budget meter in the DM composer (server value audited against core math); graceful budget-exhausted UX preserving drafts, on DMs and follows.
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
- [x] Device snapshots (added 2026-08-24): the seeder also writes `testKeys/device-snapshots/<handle>.json` (gitignored; root + device private seeds + cert). Uploading one under Recover → "Key file" makes the browser *be* the persona's original seeded device, so pre-existing DMs decrypt — word-list recovery enrolls a fresh device, which by design cannot read ciphertext addressed to the original (design §7.2: recovery restores identity, not history; an opt-in encrypted history vault is a recorded post-PoC idea, not scheduled). Dev/test-only, client-local — not a protocol format.

## Owner addition — review fixes: handles, identicons, DM search, replies (added 2026-08-24)

Usability findings from the owner's walkthrough of the PoC. None changes trust math or crypto; replies reuse the `reply_to` field protocol §3 has carried since Phase 1.

- [x] Feed shows the poster's verified display name alongside the short account id (`/feed` authors bundle inlines the latest `profile` record; client verifies it against the same cert chain before rendering — imageboard mode still renders ids only).
- [x] Identicons: deterministic 5×5 glyph from `sha256(account id)` (the GitHub/Gravatar-style "identicon"), no dependency, shown next to every account mention (feed, thread, messages, profile, nav). Allowed in imageboard mode — it renders the id, it is not profile metadata (protocol §6 wording clarified).
- [x] Messages: the "new message" input is a fuzzy search over accounts you follow ∪ existing conversations (display name or id; `web/src/dm/search.ts`, unit-tested); a pasted 43-char id still opens a new thread directly.
- [x] Profile lookup reuses the same fuzzy search (added 2026-08-24): search accounts you follow by display name or id, pick to view; a pasted id still opens any profile (search UI extracted to `web/src/ui/AccountSearch.tsx`, shared with Messages).
- [x] Replies (server): `reply_to` indexed at ingest (migration 0007; must be a well-formed record id and, if known here, a `post`); `GET /records/{id}` and `GET /records/{id}/replies` (protocol §6); `reply_count` on feed items.
- [x] Replies (client): inline "Reply" composer on tier-1 feed cards; a post/thread page (`View replies`) that verifies the root + every reply and buckets replies with the viewer's own trust math — inside-web, own, and parent-author replies in thread order, the rest collapsed behind a count (design §5.1: a reply exists in-thread regardless; trust gates rank, not existence). Replies to scoped posts deferred (no spec'd audience carry-over).
- Deferred from this batch: reply notifications + their cold metering (needs notifications, M4 note stands), replying to scoped posts, thread nesting deeper than one level (replies-to-replies exist as records — `reply_to` any post — but the page shows one level).

## Owner addition — follow notifications (PLANNED, added 2026-08-25)

Owner request: surface "someone followed you" with follow-back / ignore actions, mirroring the DM request tray. **Not implemented** — scoping found it is not the low-effort client patch it looks like, for two reasons recorded here so a later session can pick it up:

1. **Needs a new server surface plus a visibility sign-off.** No endpoint exposes inbound-follow *identities* to anyone, including the subject — `/graph/2hop` and `/accounts/{id}/follows` are outbound-only, `/accounts/{id}` returns `follower_count` only, and `store.Followers` is consumed solely by standing math. Protocol §6's rule is "inbound lists are count-only **to others**", so an authed subject-sees-own-followers endpoint is arguably within its letter — but the notification also discloses the *follower's* outbound edge to its subject, which today is only follower-visible (a private account's follow of you is currently invisible to you beyond the count). That is a design §8 visibility-contract change: explicit sign-off per the architecture.md invariants preamble, protocol §6 extended in the same PR (working agreement).
2. **This would be the first notification in the app.** No notification/badge/tray rail exists; reply notifications (+ their cold metering, M4 note), mention notifications, and attestation notifications (§8.1) are all explicitly deferred "until notifications exist". Whatever lands here defines that primitive — build the rail shape generally (server-computed candidates, client polls/filters/verifies, seen/dismissed state client-local), not follow-specific plumbing.

Proposed shape (mirror the DM-request pattern: server-computed, polled, local-only dismiss, no new record type):

- [ ] Design sign-off: a `follow` discloses itself to its subject (recommended: yes — a follow is a deliberate act *directed at* the subject, and cold follows are already metered as outreach to them; count-only stays the rule for third parties). Protocol §6 updated in the same change.
- [ ] Server: authed viewer-only inbound-follows endpoint (e.g. `GET /followers` → the signed `follow` records + author bundles, `before`-paginated like §6 listings; unfollow supersession honored) + integration tests (subject-only visibility, supersession, count-only unchanged for others).
- [ ] Client: notification tray polling like Messages (10s); rows show identicon + verified name; actions **Follow back** (reuse Profile's `GraphActions` path — `buildGraphRecord("follow")` + `postRecord`, incl. the existing `budget_exhausted` handling) and **Dismiss** (local kv flag à la `dm.request.dismissed:*` — server never learns, fresh device starts clean by design). Each follow record re-verified (sig + cert chain) client-side before rendering.
- [ ] Nav badge with unseen count; "seen" watermark in local kv.
- [ ] Once the rail exists, schedule the waiting riders: reply/mention notifications + cold metering (M4 note), attestation notifications (§8.1).

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

## Phase 6 — Attestation (M6)

Goal: verification as a separate explicit public edge (design §7.3 — never bundled with follows); safety numbers; key-change alarms; confidence UI; domain proofs checked client-side. TOFU throughout: nothing here gates any capability (architecture invariant 6). Protocol §8 is the normative spec (added in this phase's change).

**Protocol/core (vectors first):**
- [x] `packages/core`: `attestation` / `attestation-revoke` / `domain-claim` record support (sign/verify via the generic record path; type-specific validation: `subject_root_pub == subject`, known `method`, no self-attestation, hostname shape); pairwise safety-number derivation (§8.2); active-attestation reduction (latest-wins per author/subject, as follow/unfollow).
- [x] Vectors: `attest-01` (valid attestation + revoke; failure cases: `subject_root_pub` mismatch, unknown method, self-attestation, tampered sig) and `safety-number-01` (fixed id pairs → 60-digit numbers, symmetry case); consumed by both TS and Go suites.

**Server:**
- [x] Ingest via `POST /records`: `attestation` (subject exists → `400 unknown_account`; `subject_root_pub`/method/self-attestation checks → `400 invalid_record`), `attestation-revoke`, `domain-claim` (hostname shape); materialization table (migration 0008) with latest-wins active state; never metered.
- [x] `GET /accounts/{id}/attestations` (unauthenticated — public by design) with attester cert-bundle inlining + pagination; `domain-claim` served in public record listings.
- [x] Integration tests: ingest validity matrix, revoke supersession, endpoint shape, attestation-not-metered check.

**Client:**
- [x] Verify flow on the profile page: fingerprint + pairwise safety number displayed (§8.2), "I compared these numbers" → sign + publish `attestation` (method `safety-number`); withdraw (`attestation-revoke`). QR scan/render deferred (same protocol, presentation only).
- [x] Confidence UI: "verified by you" badge wherever accounts render (AccountLabel); "attested by N you trust" on the profile — each attestation signature+chain verified client-side and filtered by the viewer's own trust map (server list = candidate, never authority).
- [x] Key continuity: local per-contact device-set pins; pre-send warning banner in the DM composer when a contact gained devices since last pin (louder if previously attested), click-through re-pins — never a wall (§8.3); attesting re-pins.
- [x] Domain proofs (§8.4): add/remove a `domain-claim` + downloadable `/.well-known/runa.json`; viewing client fetches + verifies locally (CORS caveat surfaced in UI), verified domain badge; "attest via domain proof" publishes method `domain-proof`.
- [x] Explainer: `docs/explainers/how-crypto-works.md` gains a plain-language attestation/safety-number section (same change — working agreement).
- Deferred within M6: QR camera flow (presentation of the same fingerprint), strictness toggles ("require verified keys for tier-2", "warn before unverified in epoch distribution" — §8.3 records the defaults), attestation notifications (no notification rail yet; unmetered until then, §8.1).

**Exit:** two browser profiles: A and B open each other's profiles, see the *same* 60-digit safety number, both confirm → each publishes an attestation; B's client shows A as "verified by you" (and A's attestation of B is visible to a third account C as "attested by 1"); A enrolls a new device → B's DM composer shows the key-change notice before the next send, click-through clears it; B revokes → badge gone; a `domain-claim` with a served well-known file renders the domain verified in C's client (local fixture). **Verified 2026-08-24** via scripted client-vs-runad run (web client's own modules, fresh DB): 23/23 assertions — safety-number symmetry/format, unmetered public attestation, unauthenticated endpoint + client-side re-verification (sig + cert chain, server list as candidate only), full ingest rejection matrix (self/mismatch/unknown-method/unknown-subject), revoke supersession incl. the equal-timestamp tie-break, new-device pin detection + re-pin + first-contact TOFU, and domain-claim listing + well-known verification incl. author/host-mismatch neutral failures. Real-browser two-profile walkthrough (badges, composer banner, QR-less verify screens) left for the owner's next manual pass.

## Phase 7 — Standing & reports (M7)

Goal: the global enforcement layer per design §4 — `report` records (incl. envelope-proven plaintext forwarding for encrypted content), diversity-weighted report mass, standing with decay, the graduated ladder's automated rungs plus the human review queue. Protocol §9 and trust-and-reach §4 are the normative spec (added in this phase's change). Invariants under stress here: server never gains a decryption key from report flows (structural recipiency proof, no key material on the wire); penalties throttle strangers and never sever chosen edges (direct-follow override); standing decays, no permanent marks; users told *that* they're limited, never thresholds. Per design §12, the standing/diversity dynamics are simulated in simlab **before** server enforcement lands.

**Protocol/core (vectors first):**
- [x] `packages/core`: `report` record support (type-specific validation: known reason, no self-report, comment ≤ 1000 chars; recipiency is server-contextual, not record-shape); `standing.ts` — penalty decay (`p·2^(−Δt/half-life)`), reporter weight (`(1−p_adj) × ln(1+Σ inbound_trust)` — adjudicated component only, anti-report-the-reporters), reporter clustering (follow-link ∨ Jaccard ≥ threshold → connected components), diversity-weighted mass (per-cluster max), `p_auto` (impact × mass, capped), combined standing `(1−p_auto)(1−p_adj)`; constants additions (trust-and-reach §6 table).
- [x] Vectors: `report-01` (valid report with/without `record`; unknown reason, self-report, over-long comment, tampered sig) and `standing-01` (decay cases, reporter weights, cluster partition + mass over a graph fixture, combined standing); constants vector picks up the new entries; consumed by both TS and Go suites.

**Simlab (before server enforcement — design §12):**
- [x] Brigade cohort kind (tight cluster mass-reporting a target) + independent-reporters cohort; `metrics/standing.ts` importing the core math (never forked).
- [x] Checked-in scenarios cited by the new constants: `brigade-stress` (500-strong cluster moves standing ≪ cap) and `diverse-reports` (a handful of unconnected reporters reach the cap → review queue); decay-recovery asserted in tests.

**Server:**
- [x] Migration 0009: reports table (+ dismissed flag), standing table (`p_adj`, `p_adj_updated_at`, `frozen_until`), review-queue table.
- [x] `internal/trust/standing.go` mirroring core (vector-tested); report ingest via `POST /records` (§9.1 rules: unknown_account/invalid_record/unknown_record/not_recipient matrix; dm recipiency `to == reporter`; scoped-post recipiency via epoch membership; never metered; never served in any user listing).
- [x] Standing enforcement: candidate feed / record / replies carry `standing` and use `effective_trust` with the direct-follow override; budget formula × standing (incl. standing-weighted inbound trust); freeze → `429 cold_outreach_frozen`; `GET /standing` (told-that-not-why).
- [x] Review queue: auto-open at `p_auto` cap; `GET /admin/review` + `POST /admin/review/{account}` (dismiss burns reporters / uphold / freeze / none) behind `-admin-token` / `RUNAD_ADMIN_TOKEN` (404 when unset).
- [x] Integration tests: ingest matrix, mass/clustering vs vectors, queue lifecycle, dismiss-burn, uphold decay, freeze behavior, standing-in-responses, direct-follow override, chosen-edges-survive.

**Client:**
- [x] Report flow: report action on profiles and posts (reason picker + optional comment); decline-with-report in the DM request tray (decrypt → explicit consent screen for plaintext forwarding → report + dismiss); report on scoped posts with the same consent screen.
- [x] Standing surfaces: "your reach is currently limited" banner from `GET /standing` (reasons only, no thresholds); rank.ts threads server `standing` (clamped to [0,1]) into effective trust with the client-side direct-follow override — chosen edges survive locally.
- [x] Explainer: `docs/explainers/how-reach-works.md` gains a plain-language standing/reports section (same change — working agreement); threat-model PoC note updated (standing/reports no longer missing).

**Exit:** scripted client-vs-runad run: B reports A's public post (reason spam) → A's standing dips by one reporter's worth; five unconnected accounts report A → `p_auto` caps, review queue opens, A's cold outreach shrinks but A's posts still surface for their direct followers; a 20-account tight cluster reports C → C's standing barely moves (diversity weighting); operator dismisses the brigade's reports → each brigade member's own standing burns; operator freezes A → A's cold DM returns `cold_outreach_frozen`, warm paths unaffected; B declines-with-report an encrypted DM request → server verifies recipiency structurally, report (with forwarded plaintext) visible only in the admin queue; A's `GET /standing` says limited-due-to-reports with no counts or thresholds; 30 days simulated → penalties halve (decay). **Verified 2026-08-24** via scripted client-vs-runad run (`web/scripts/m7-exit.ts`, checked in — fresh runad + temp DB, ~160 accounts, all records through the web client's own modules, every numeric expectation recomputed from `@runa/core` over the actual graph): 32/32 assertions — single-report dent to 1e-6, five-diverse-reporters cap + auto-opened queue, 20-account cluster contributing only its max weight (no queue entry), direct-follow override with teeth (post-uphold standing 0.16: direct follower still normal-buckets via client rankFeed, hop-2 viewer doesn't), budget ×standing, dismiss→burn (reporters to 0.8, reasons `["adjudication"]`), freeze (`cold_outreach_frozen` on cold DM, warm reply + public post + reporting unaffected), encrypted-report recipiency (recipient accepted incl. plaintext, third party `403 not_recipient`), report invisibility (404 by id, absent from listings, plaintext only in the admin queue), report-at-zero-tokens unmetered, admin auth (401 wrong token, 404 token-less instance). Notes: the exit line's "dismiss the brigade's reports" is structurally unreachable as worded (a brigade never caps → never opens an entry — that's the diversity design working); burn verified on the diverse group, same code path. Live 30-day decay can't be wall-clocked; covered by the frozen-clock `TestAdminUpholdDecays` integration test plus core decay math in the script. Real-browser pass (report dialogs, consent screen, limited banner) left for the owner's next manual walkthrough.

## Working agreements for implementing agents

- Build order within every phase: **vectors → core libs → server → client**. Never implement a format the spec doesn't define — extend [`protocol.md`](protocol.md) in the same PR.
- Never violate the invariants list in [`architecture.md`](architecture.md) — including "no primary-instance privilege"; when a task seems to require it, stop and surface the conflict instead.
- Any change to reach algorithms or crypto updates the matching [explainer](explainers/) in the same change; any change to a published constant cites a checked-in simlab scenario (once Phase S lands).
- Update this file's checkboxes and the "Measured" notes as you go; it is the coordination surface between sessions.
- Conserve the owner's plan usage: hand self-contained work to subagents on an explicitly chosen non-Fable model (haiku for mechanical work, sonnet for most search/code tasks, opus for hard substeps), and give each subagent the file paths, doc references, and constraints it needs — see "Subagents & model selection" in CLAUDE.md.
