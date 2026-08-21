# Design Doc: Privacy-Respecting Social Network with Reputation-Limited Reach

**Status:** Handoff brief for implementation. All open questions resolved; testing flags noted in §13.
**Audience:** Implementing agent (Claude Code) and future contributors.
**Core thesis:** Posting is free; *reach* is the rationed resource. Spam is treated as an economics problem, defeated by trust-graph position that attackers cannot buy or mint. Content privacy is enforced by client-side cryptography, not server policy.

---

## 1. Design principles (normative)

1. **Reach is earned, never bought.** No mechanism may allow purchasing or computing (PoW) additional reach. Proof-of-work gates *suspicion and signup*, never expands capability.
2. **Trust is subjective.** There is no global positive reputation score. All trust is computed from a specific viewer's vantage point over the follow graph.
3. **The server is a dumb, honest-but-curious mailbox for private content.** It stores signed ciphertext for tiers 2–3 and never holds a decryption key for them.
4. **Throttle, don't silence (hard invariant).** Penalties shrink reach *to strangers*. They never sever channels with users who already chose to follow/trust the penalized account, and never delete content.
5. **Users retain complete control of keys.** Root keys are generated client-side, exportable at any moment (file, QR, word list, OpenPGP-compatible format). The server sees the root key only as user-initiated, client-side-encrypted backup blobs.
6. **Verification is never a capability gate.** Encryption works to unverified keys (TOFU). Attestation upgrades displayed confidence and arms key-change alarms; strictness is opt-in per user.
7. **Auditable from every seat, surveyable from none.** Every user can recompute why their own feed ranks as it does. Global graph scraping is not supported by default.
8. **Transparency is load-bearing.** All algorithms and signal types are public (Kerckhoffs applied to social systems). The only unpublished values are a small set of operational friction thresholds, and that boundary is itself disclosed.
9. **Trust comes only from deliberate user acts** (follow, mute). Behavioral signals (replies, reshares) may inform ranking within already-trusted content and explore mode, never trust itself.

## 2. Identity & keys

### 2.1 Account = keypair
- Identity is a cryptographic keypair. No email, phone, or PAT. (PATs rejected: bearer secrets, nothing to sign with or encrypt to.)
- All content is signed. Server tampering with content is detectable; withholding is not (see threat model).

### 2.2 Key hierarchy
- **Identity root key**: generated client-side at signup. Signs exactly one thing: device-key certificates and revocations. Referenced by follows, attestations, standing, invite provenance. Never used for content.
- **Device keys**: one per device/browser-profile, self-generated, certified by root. Do all operational work: sign posts, hold prekeys, receive epoch keys. Tier-2/3 content keys are wrapped per recipient *device*, with device lists read from signed device certificates.
- Adding a device: root signs new cert (bootstrapped by QR scan from an existing session, or by importing/unwrapping the root). Losing a device: root revokes cert; non-event.
- Advanced path: bring-your-own GPG key as root; hardware token custody; skip-all-nudges flag.

### 2.3 Web-first custody (all clients are web clients)
- Browser storage is treated as **disposable**. Device keys live in IndexedDB and are *expected* to die (cache clears). Device lifetime of weeks-to-months is normal; re-enrollment must be a ~30-second flow.
- **Root is exported at birth**: signup flow is generate → present recovery kit (downloadable key file + BIP39-style word list, one screen) → confirm → browsing. The browser holds only a working copy of the root, if that.
- Optional convenience tier: root key encrypted client-side under a **WebAuthn PRF**-derived key; ciphertext stored server-side; any browser + passkey unwraps locally. Passkeys are *device/session authenticators only* — never the identity root (they're vendor-synced and can't be sharded). Verify current PRF browser coverage at implementation time.

### 2.4 Recovery (user-controlled, progressively attached)
Recovery posture is a **living setting**, not a signup fork. Options, all attachable/inspectable/revocable later:
1. **Passphrase backup**: root encrypted client-side (Argon2id KDF), blob stored server-side. Default suggestion for most users. Server is a brute-force target for high-value accounts — say so.
2. **Social recovery**: Shamir N-shard split of root, distributed to chosen contacts over the tier-2 channel, K-of-N reconstructs. Requires periodic shard-holder health checks ("2 of 5 recovery contacts inactive 90 days — re-shard?"). Cannot be a signup step (new users have no contacts).
3. **No recovery**: explicit, consequences stated at selection.
- **Backup nudges** are milestone-triggered (first follower, first attestation, first tier-3 post), one dismissible screen each, stakes stated plainly. Reminders, not the first line of defense (that's the signup export).
- **History vault** (past epoch keys/content keys wrapped under the same passphrase or shard set) is a *separate* opt-in, default off — bigger honeypot, forward-secrecy purists will refuse it.
- **Failed recovery**: new root = new account cryptographically. Social layer softens it: old verifiers re-attest the new key out-of-band; contacts can sign old→new link statements; follows migrate only by each follower's consent. Standing and invite provenance do NOT transfer (impersonation vector). This imperfection is deliberate — it's what makes "key changed without re-attestation" a meaningful alarm.

## 3. Trust model

### 3.1 Subjective trust computation
- `trust(viewer, author)` computed over the follow graph from the viewer's vantage:
  - Hop 1 (direct follow): weight 1.0.
  - Hop 2: weight `decay` per hop, **default decay = 0.35** (published constant).
  - **Hop cap = 2.** Beyond hop 2 = "no path". (Comprehensibility, Sybil-bridge resistance, and client computability: hop 2 needs only your follows' follow lists.)
- **Multiple paths sum** (with per-hop damping), capped at **2.0× direct-follow weight**. Summing makes independent vouches count and localizes Sybil rings (one bridge = one damped path each); the cap keeps neighborhood popularity from drowning explicit choices.
- **Mute/distrust edges: hard zero that prunes propagation.** A muted account contributes nothing and its outbound follows carry nothing for the muting viewer. No distrust propagation beyond that in v1 (no guilt-by-association).
- Signals into trust: **follows and mutes only.**

### 3.2 Effective trust
```
effective_trust(viewer, author) = subjective_trust(viewer, author) × standing(author)
```
`standing` ∈ [0,1], global, default 1.0. See §4.

### 3.3 Computation locus — TESTING FLAG
- Ideal: pure client-side. Pragmatic middle to ship first: **server proposes candidate ranking; client re-scores locally before display.**
- **Invariant: nothing renders as trusted unless the client's own computation agrees.** Divergence is detectable because the algorithm is published.
- Measure during testing whether pure client-side is fast enough in real browsers (2-hop graph fetch latency, cold start); let data pick the default. This is a flagged watch-item.

### 3.4 Feed & explore
- Default feed: followed accounts + trust-boosted neighborhood content. Content with `effective_trust ≥ 0.3` (published constant) ranks normally; below threshold it exists but doesn't surface unprompted; no path → low-priority bucket, pull not push.
- **Explore mode**: deliberate sampling beyond hop 2, server-ranked by trust-weighted engagement from accounts *near the viewer*, clearly labeled as outside your web. This is the sanctioned discovery channel and the filter-bubble mitigation; invest in it.
- Per-post audience scopes (tier-3 compose): **"My follows"** (hop 1) and **"My web"** (hop 2 above threshold). Named scopes, not sliders. Custom saved lists deferred.

## 4. Standing & enforcement (global penalty layer)

- `standing(account)` ∈ [0,1], default 1.0, multiplies subjective trust and reach budgets. **Decays back toward 1.0** absent new signals (published half-life constant; suggest 30 days initially). No permanent marks.
- Rationale for a global layer here (and only here): Sybils can manufacture global *positive* signals but cannot easily stop real users from filing *negative* ones. Standing is enforcement, not reputation.

### 4.1 Reports
- Report weight = reporter's own standing × reporter's graph-trust from… the *aggregate* honest graph is not computable per-viewer, so implement as: reporter standing × log-scaled inbound trust of the reporter (same quantity used for reach budgets, §5).
- **Diversity over volume**: measure graph correlation among reporters of the same target; discount correlated clusters (a brigade is a tight cluster by definition). Five reports from five unconnected regions ≫ five hundred from one cluster.
- **Reports carry consequences**: adjudicated-false or statistically-evident-false reports burn the reporter's standing.
- Reports on encrypted content: report includes the reporter's decrypted plaintext + envelope proof that the reporter was a legitimate recipient (they hold the key; forwarding-for-review is a recipient capability, not a server one). Server never gains a decryption capability from this.

### 4.2 Behavioral friction (automated, metadata-only)
- Inputs the server legitimately sees: posting rate, cold-outreach fan-out breadth, timing regularity, account age, signup clustering/fingerprints. **No content signals for tiers 2–3 by construction** — state this in the threat model as a behavioral-not-content-aware limitation.
- Anomalies trigger **friction first**: tightened cold-outreach bucket, per-send proof-of-work, slow-mode. Friction is cheap to apply, cheap to lift; false positives cost minutes, not reputation.
- **Graduated ladder**: friction → reach reduction (standing dent) → cold-outreach freeze → account action. The last rung is **human-reviewed, always**. Automation may only move accounts along the early rungs.
- Transparency compromise: users are told *that* they're limited ("cold outreach limited due to reports"), not the precise trigger thresholds. This is the one disclosed-as-unpublished layer (§1.8).

## 5. Reach budgets (cold outreach)

### 5.1 Definition
- An initiation is **cold** iff the *recipient* has no trust path (≤2 hops, above threshold) to the sender. Recipient's vantage, because budgets protect attention and attention belongs to receivers.
- Cold (costs one token, generates muted/trayed delivery): first DM to a stranger (→ request tray); mention/tag of a stranger; reply to a stranger's post (reply exists in-thread regardless — only the author-notification and default rank are gated; readers who trust the replier see it ranked normally); follow of a stranger (follows notify).
- **Never metered**: public posting to your own feed; anything within your trust neighborhood; **replying to anyone who engaged you first** (engagement opens a reciprocal window — conversations, once started, are free; only initiations are metered).

### 5.2 Mechanics
- Token bucket, daily refill, carryover cap ≈ 2 days.
- Base budgets (published constants, tune in testing): **open signup: 5/day. Personal-invite joiners: 15/day.** Broadcast-invite joiners: base 5.
- Growth: `budget = base + k × log(1 + Σ inbound_trust)` where inbound trust sums trust-weights of followers, each weighted by their own standing. Generous early (first ~10 real followers ≈ 3× budget), flat late. **No age-based growth** (spammers age accounts for free; they can't manufacture inbound honest trust).
- Standing multiplies the budget (friction ladder plugs in here).
- **No purchasable/PoW-purchasable expansion.** Ever. (§1.1)
- Cold DM flow: request tray, quiet notification, decline-with-report feeds standing; acceptance upgrades to unmetered conversation.

### 5.3 Honest Sybil arithmetic (for the threat model)
Open signup means total cold-outreach volume scales linearly with account creation. Defenses: signup PoW prices bulk creation; signup/behavior clustering is loud in legitimate metadata; within request trays, zero-trust senders rank below some-trust senders; report-driven standing collapse zeroes budgets fast. The budget doesn't make mass spam impossible — it makes it expensive per unit of attention actually reached, while genuine newcomers never feel the ceiling.

## 6. Onboarding & invites

- **Open signup**: generate keys → recovery kit screen → browsing. No email/phone/approval. Sandbox = base reach budget + empty graph. Full posting rights from minute one.
- **Invite links, type chosen by the inviter at generation:**
  - **Broadcast link** (postable publicly): on join, auto-creates *new-user-follows-inviter* (seeds their feed; zero risk, zero trust granted). Base budget.
  - **Personal link** (handed to someone you know): additionally pre-authorizes *inviter-follows-new-user* — the trust-bearing edge — and optionally carries an **attest-on-join** flag: inviter sees the joining key's fingerprint ("this is the link you gave Dana — attest?"), one tap. A personal link handed over an existing channel is already an out-of-band exchange, so it can bootstrap account + first trust edge + first attestation in one act. Budget 15/day.
- **Invite provenance**: signed who-invited-whom edges, **private-to-the-system** — inputs to standing (pattern: "this account's invitees are disproportionately reported" → upstream friction), surfaced to humans only at the human-review rung. Never published (would deanonymize social clusters at signup).
- Inviter accountability needs no caps at v1: spam invited into your neighborhood is weighted by *your* trust, seen and reported *near you*, and your standing eats diversity-weighted consequences. The graph prices it correctly.

## 7. Messaging & encryption

Server = signed-ciphertext mailbox for tiers 2–3. All decryption client-side.

### 7.1 Tiers
1. **Public**: signed plaintext.
2. **One-to-one**: v1 = **stateless hybrid encryption** to the recipient's current device keys, per message. Chosen over double ratchet for v1 because browser storage loss (routine) breaks ratchet sessions; robustness over per-message forward secrecy. Envelope format carries algorithm/version fields from day one; double ratchet (X3DH + prekeys) is a versioned, per-conversation, opportunistic upgrade path.
3. **Web-scoped**: sender's client enumerates the concrete recipient set locally (scope = "My follows" or "My web") and encrypts via **epoch keys**: random symmetric web key per epoch, distributed once to each recipient device over the tier-2 channel; posts reference epoch key ID. Membership change (esp. removal/mute) → new epoch, removed users receive nothing new. Epoch rotation cadence is the primary forward-secrecy dial (suggest: rotate on membership change + max age 30 days).

### 7.2 Snapshot semantics (confirmed)
A tier-3 post is readable by the recipient set computed at post time, frozen into the envelope/epoch distribution. New follows don't unlock history; removal doesn't un-share the past; recovery restores identity, not history (absent surviving devices or opt-in vault). User-facing sentence: *"Private posts are shared with your web as it exists when you post. Trust you grant later starts from now — like a conversation someone joins midway."*

### 7.3 Verification & attestation
- **Follows = interest + trust delegation. Never key attestation.** (GPG's bundling error; the signals corrupt each other.)
- **Attestation = separate explicit edge** ("I verified key X belongs to entity Y"), created only by deliberate out-of-band acts:
  - QR fingerprint scan in person (mutual).
  - Safety-number comparison over a user-chosen external channel.
  - Domain/profile proofs (signed statement at a user-controlled location — `/.well-known/`, gist, DNS TXT — fetched and checked by the *client*, never vouched by the server). Keybase model; the only mechanism that scales to strangers.
- Attestations are signed statements, published, propagated like graph edges, **public by design** (verifiability claims are useless if hidden; note in threat model that attesting is a public act).
- **TOFU everywhere**: encryption to unverified keys just works; attestation changes displayed confidence only. The one loud moment: **key change without re-attestation by previous verifiers** → real warning before next tier-2 send, click-through-able, never a wall.
- Opt-in strictness toggles (default off): "require verified keys for tier-2 sends"; "warn before including unverified new followers in epoch distribution."
- Network's role: **registry and router of attestations, never an oracle of identity.** Server can withhold attestations (→ threat model) but cannot forge (signed).

## 8. Graph visibility (Option B)

- **Outbound follow lists: visible to your followers by default** (the floor hop-2 computation requires), with per-account **opt-up to public**. No opt-down below follower-visible (would break the trust math for your followers).
- **Inbound (follower) lists: count-only to others**, full list always visible to the account itself. Never unilaterally publishable — your follower list is other people's outbound choices.
- **Mutes/distrust: always private** (user-to-user), no toggle. Publishing negative edges creates harassment maps.
- **Attestations: public** (§7.3). **Invite provenance: system-private** (§6). **Epoch membership: never user-visible** beyond what key possession implies.
- The server sees the full plaintext graph regardless (feeds, budgets, epochs require it) — conceded in the threat model. OQ8 governs user-to-user visibility only.
- Doc framing: *"Auditable from every seat, surveyable from none."* Every user can verify their own vantage (the only place trust exists); global scraping is deliberately unsupported.

## 9. Transparency & documentation set

Verifiability chain: published protocol → open-source reference client → independent third-party clients as the audit mechanism. A motivated user can pull the graph data they're entitled to see and recompute their own feed ranking.

Four documents, living in-repo, versioned, changed via the same review process as code (spec change = protocol change, not a wiki edit):
1. **Threat model** — see §10; the foundation everything cites.
2. **Protocol spec** — envelope formats, key hierarchy, epoch mechanics, attestation record format, versioning rules. Bar: a third party can build an independent client from it.
3. **Trust & reach spec** — all math in §§3–5, constants table, and the invariants stated as versioned promises (throttle-not-silence; standing decays; penalties never override chosen edges; no purchasable reach; trust from deliberate acts only).
4. **Governance/ops** — where human judgment lives (final enforcement rung), how thresholds change, how algorithm changes are announced. Makes "legible and bounded" real.

Disclosure boundary, stated openly: all algorithms and signal types public; a small set of operational friction thresholds unpublished (the only reading-gameable layer).

Beyond the four specs, an **explainer tier** (docs/explainers/): plain-language documents describing how reach works and how the cryptography works, aimed at users and journalists, not implementers. The specs are the truth; the explainers are the honesty. They change in the same PR as any algorithm or crypto change (§15).

## 10. Threat model (summary for the standalone doc)

**Server (honest-but-curious):** sees full graph, all metadata (timing, sizes, device lists, epoch distribution fan-out), all public content. Cannot read tier-2/3 content. Cannot forge content or attestations (signatures). This is 95% of the realistic threat and 100% of the mass-surveillance one.

**Server (active/malicious or compelled):**
- Can deny service, selectively drop/withhold messages and attestations, serve manipulated *orderings*. Signed content makes tampering detectable, not censorship.
- Can substitute keys at first contact → mitigated by TOFU (attack must hit *first* exchange), key-change alarms, attestation web; any later attestation/safety-number check exposes it retroactively.
- **Web code delivery (the big honest caveat):** the client is re-delivered JS on every load; a server willing to serve targeted malicious code to a specific user can defeat E2E for that user. Mitigations: reproducible builds + published hashes; PWA service-worker version pinning (makes silent per-user swaps harder); client as static assets on mirrorable infra (IPFS/Pages mirrors — decouples code-server from API-server); optional verifier browser extension checking bundle hash against a public log. Threat-model sentence: *E2E protects against a passive server always, and an active-but-code-honest server; targeted malicious code delivery defeats it, mitigated by build transparency and mirrors.*

**Sybil attacker:** unlimited free keypairs. Cannot acquire inbound honest-graph trust; rings carry weight only internally; budgets scale with earned trust; provenance and clustering light up bulk patterns. See §5.3 arithmetic.

**Brigade (real accounts, coordinated):** report-weighting by diversity localizes damage; reporter standing burn prices participation; trust-weighting means the brigade's mutes/reports shape *their own* neighborhoods most.

**Recipient betrayal:** any tier-3 recipient can leak plaintext (screenshot problem — unsolvable, state it). Report-forwarding is the legitimate form.

**Stated non-goals (v1):** metadata privacy from the server (no sealed sender); hiding the graph from the server; anonymity. The network protects content and rations attention; it does not hide who talks to whom from its own operator.

## 11. Constants table (all published; initial values, tune in testing)

| Constant | Initial | Notes |
|---|---|---|
| Hop cap | 2 | structural, not tunable |
| Per-hop decay | 0.35 | user-overridable locally |
| Multi-path sum cap | 2.0 | × direct-follow weight |
| Feed surface threshold | 0.3 | effective trust |
| Standing decay half-life | 30 days | toward 1.0 |
| Cold budget: open / personal-invite | 5 / 15 per day | token bucket |
| Budget carryover cap | ~2 days | |
| Budget growth | k·log(1+Σ inbound_trust) | pick k so ~10 followers ≈ 3× base |
| Epoch max age | 30 days | + rotate on membership change |
| KDF | Argon2id | passphrase backup |
| Shamir | K-of-N, user-chosen | suggest default 3-of-5 |

## 12. Suggested build order

1. **M1 — Identity & custody**: keygen, root/device hierarchy, device certs/revocation, recovery-kit export, signup flow, signed public posts (tier 1). PRF-passkey unwrap if time allows.
2. **M2 — Graph & feed**: follows, mutes, follower-visible list plumbing, 2-hop trust computation (server-proposes/client-verifies architecture from day one), basic feed + thresholds.
3. **M3 — Tier-2 DMs**: hybrid encryption envelopes (versioned format), device-key wrapping, request tray, reciprocal-engagement exemption.
4. **M4 — Reach budgets & friction**: token buckets, inbound-trust growth, cold-classification, signup PoW, behavioral friction hooks.
5. **M5 — Tier-3 scoped posts**: epoch key generation/distribution over tier-2, scopes, snapshot semantics, rotation.
6. **M6 — Attestation**: record format, QR flow, safety numbers, domain proofs (client-side fetch), key-change alarms, confidence UI.
7. **M7 — Standing & reports**: report flow (incl. recipient plaintext-forwarding proof), diversity weighting, decay, graduated ladder, human-review queue.
8. **M8 — Invites & explore**: both link types, attest-on-join, provenance recording, explore mode ranking.
9. **M9 — Transparency**: the four docs, reproducible builds, mirrors, constants published.

Rationale: each milestone is independently testable; crypto layers build bottom-up (tier-2 is the distribution rail for tier-3); enforcement lands after there's behavior to enforce on; invites land late because open signup works without them.

**Parallel workstream — simlab (§16):** starts as soon as the trust math exists as shared code (M2) and needs no server. Budget (M4), standing, and report-diversity (M7) dynamics are simulated in simlab *before* their server implementations land — tuning and red-teaming precede enforcement.

## 13. Testing flags & watch items

- **Trust computation locus** (§3.3): server-assisted vs pure client-side — measure browser latency on real 2-hop fetches; invariant holds either way.
- Reach-budget constants: verify genuine newcomers never hit the ceiling (target: <1% of good-faith accounts ever see a budget error).
- Epoch distribution cost at large web sizes (2k followers × 3 devices each) — measure before optimizing.
- WebAuthn PRF coverage across target browsers at implementation time.
- Diversity-weighting math for reports: needs concrete graph-distance metric; prototype and red-team with simulated brigades.
- Explore mode quality — the designated filter-bubble mitigation; treat as a product priority, not an afterthought.
- All constants-tuning flags above route through simlab (§16): a constant change without a cited simlab scenario is an unreviewable constant change.

## 14. Known tradeoffs (state in docs, don't hide)

Filter bubbles by construction (mitigated only by explore mode); full metadata + graph visible to server; epoch granularity as forward-secrecy dial; residual structural advantage for well-connected accounts (softened, not eliminated); v1 tier-2 lacks per-message forward secrecy (upgrade path specified); centralized server can censor even though it can't read or forge; web code delivery is the E2E soft spot; attestation is a public act; failed recovery is a new account on purpose.

## 15. Openness & self-hosted instances

Radical openness is a product feature, not just a licensing posture. Concretely:

- **Everything needed to run and audit the network is public**: source for server and client, the protocol/trust specs, the constants, and plain-language explainers of how reach and the cryptography work (§9 explainer tier).
- **Deployment model**: the project operates a **primary instance**; the identical software is designed for anyone to stand up their own instance. **No primary-instance privilege in code** — the primary is the reference deployment, nothing more. Anything the primary can do, any operator can do.
- **Instance = one server plus its users' graph.** v1 instances are independent networks: identity keypairs are instance-independent (the same root key can be used on any instance — identity is yours, not the operator's), but graph, content, standing, and budgets live per instance. **Federation between instances is an explicit v1 non-goal**, deferred, not foreclosed: the recorded implications (cross-instance trust paths, mailbox routing, attestation propagation, per-instance standing) must be revisited before any design choice would foreclose them cheaply.
- **Instances self-describe**: a public meta endpoint publishes the instance's software/protocol version and its running constants. Clients compute trust with the instance-published constants and **surface deviations from the reference defaults** ("this instance runs decay 0.5, reference is 0.35"). The transparency invariant (§1.8) is a per-instance protocol expectation, not a courtesy of the primary.
- **Operator trust is a user choice**: each instance's operator is exactly the honest-but-curious/active server of the threat model for that instance's users. Self-hosting distributes operator power; it does not eliminate it.

## 16. Simulation & tuning lab (simlab)

An in-repo tool to model how tuning the published constants changes reach across a simulated population, with visuals. Requirements:

- **Runs the real math.** simlab imports the same shared trust/budget code the shipping client uses (single core package). The simulator is an argument about the actual system; a forked reimplementation would be worthless as evidence.
- **Synthetic populations**: configurable size; several follow-graph generators (random, small-world/clustered communities, preferential attachment); cohorts with distinct behavior (genuine newcomers, well-connected accounts, Sybil rings, coordinated brigades); seeded RNG so every run is reproducible.
- **Tunable inputs**: every published constant (§11) adjustable live — decay, sum cap, surface threshold, budget base/`k`/carryover, standing half-life, epoch cadence where relevant.
- **Outputs (visual + numeric)**: reach distribution across the population (for each account, how many viewers' feeds surface it above threshold) as histogram/CDF; newcomer budget trajectories against follower growth; the §13 target metric (% of good-faith accounts ever hitting a budget ceiling, target <1%); Sybil-ring effective reach vs honest-cohort reach; brigade impact on standing once the standing model exists.
- **Two modes**: an interactive browser UI (sliders + charts) and a headless CLI for scripted parameter sweeps emitting JSON/CSV. **Scenario files are checked into the repo** — tuning debates cite reproducible scenarios, and §13's flags are resolved by scenario, not vibes.
- **Role in governance**: proposed constant changes must cite the simlab scenarios that motivated them (§9 review process).

## 17. Web client

Additional details for how a user should experience the network.

- **Imageboard mode**: disable profile customization. No profile pictures, bios, or any account metadata. In the spirit of the hacker ethos, judge users by their content. Possibly the default operating mode, but configurable per instance.
