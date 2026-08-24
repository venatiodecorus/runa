# Trust & Reach Specification

**Status:** v0.1 — the math of design §§3–5 in one implementable place, plus the published constants table. All of this is public by design (design §1.8). The invariants in §5 below are versioned promises.

## 1. Subjective trust

For viewer `V` and author `A`, over the follow graph, mutes applied first:

- If `V` has muted `A`: `subjective_trust(V, A) = 0`, and `A` is pruned — `A`'s outbound follows carry nothing for `V`. No further distrust propagation (no guilt-by-association in v1).
- Direct follow (`V → A`): path weight `1.0`.
- Two-hop path (`V → M → A`, `M` not muted): path weight `decay = 0.35`.
- **Hop cap = 2** (structural, not tunable): beyond hop 2 there is no path. This keeps the computation client-feasible (needs only your follows' follow lists) and Sybil-bridge resistant.
- **Multiple paths sum**, capped at `2.0` (× direct-follow weight). One direct follow + many hop-2 paths ⇒ `min(1.0 + 0.35·k, 2.0)`.

Inputs are **deliberate acts only**: follows and mutes. Replies, reshares, likes, dwell — never inputs to trust (they may inform ranking *within* already-trusted content, and explore mode, only).

## 2. Effective trust & the feed

```
effective_trust(V, A) = subjective_trust(V, A) × standing(A)
```

- `standing ∈ [0, 1]`, global, default `1.0` (enforcement layer, §4 below — landed with M7).
- Feed buckets: `effective_trust ≥ 0.3` → ranks normally; `0 < et < 0.3` → exists, doesn't surface unprompted; no path → low-priority pull-only bucket. Explore mode (M8) is the sanctioned beyond-hop-2 discovery channel. **Direct-follow override (§5 invariant 3):** an author the viewer directly follows ranks normally regardless of the author's standing — a penalty never severs a chosen edge; both the server's candidate feed and the client's re-rank apply this. A mute is also a chosen edge and takes precedence: the override never applies to a muted author.
- **Computation locus (testing flag, design §3.3):** server proposes candidate ranking from the same published math; client recomputes from its entitled 2-hop slice and re-ranks before display. *Nothing renders as trusted unless the client's own computation agrees.* Divergence is detectable and should be surfaced in dev builds (log + UI badge) — that's the audit working.

## 3. Reach budgets (cold outreach) — M4

An initiation is **cold** iff the *recipient* has no trust path (≤2 hops, above threshold) to the sender — recipient's vantage, because budgets protect attention and attention belongs to receivers.

- **Costs one token** (and delivers muted/trayed): first DM to a stranger (request tray); mention of a stranger; reply-to-stranger (only the author-notification and default rank are gated — the reply exists in-thread regardless, and readers who trust the replier see it ranked normally); follow of a stranger.
- **Never metered:** public posting to your own feed; anything within your trust neighborhood; replying to anyone who engaged you first (engagement opens a reciprocal window — conversations, once started, are free).
- **Mechanics:** token bucket, daily refill, carryover cap ≈ 2 days.
  `budget = (base + k × log(1 + Σ inbound_trust)) × standing(sender)`
  where `Σ inbound_trust` sums followers' trust weights, each weighted by the follower's own standing. `k` chosen so ~10 real followers ≈ 3× base. **No age-based growth. No purchasable or PoW-purchasable expansion, ever.**

## 4. Standing & enforcement — M7

`standing(A) ∈ [0,1]` multiplies subjective trust and budgets (§§2–3). It is the **one server-computed, server-authoritative factor** — its inputs (reports) are private by design, so clients cannot recompute it. Clients clamp the served value to `[0,1]` (standing can only shrink reach, never amplify trust) and enforce the invariants of §5 from their own graph. Wire behavior: protocol §9.

```
standing(A) = (1 − p_auto(A)) × (1 − p_adj(A))
```

**Automated rung — `p_auto` (diversity-weighted report mass):**

- Reporter weight: `w(R) = (1 − p_adj(R)) × ln(1 + Σ inbound_trust(R))` — the same log-scaled inbound trust as the budget formula (§3), so weight is earned exactly the way reach is. The standing factor is deliberately the **adjudicated component only**, not full standing: if `p_auto` discounted reports, mass-reporting a target's likely defenders would silence their reports (report-the-reporters), and the definition would be recursive. Only human-confirmed abuse (a false-report burn, an uphold) reduces the weight of someone's future reports. The same grounding applies inside this formula's `Σ inbound_trust`: followers are weighted by their adjudicated component `1 − p_adj`, not full standing — every quantity in the mass computation grounds in stored adjudication state plus the graph, so standing is well-founded (no cycles) and computable in one pass. (The *budget* formula's Σ still weights followers by full standing, which is itself grounded the same way.)
- Reporters of the same target within the trailing `report_window_days` are **clustered**: reporters `R1, R2` are linked iff either follows the other, or the Jaccard overlap of their outbound follow sets ≥ `report_cluster_jaccard`; clusters are the connected components of that link graph.
- **Diversity over volume:** each cluster contributes only its *maximum* member weight — volume inside a cluster adds nothing. Mass `M = Σ over clusters of max w`. Five reporters from five unconnected regions contribute five full weights; five hundred from one tight cluster contribute one. A brigade is a tight cluster by definition (threat model A4).
- `p_auto = min(report_auto_cap, report_impact × M)`, over non-dismissed reports only. Reports age out of the window — that is the automated rung's decay (no permanent marks).

**Human rung — `p_adj` (adjudication, protocol §9.4):** when `p_auto` hits its cap, automation is exhausted and a review-queue entry opens. Operator decisions: *dismiss* (reports adjudicated false — excluded from mass forever, and each reporter's own `p_adj` is raised by `false_report_burn`: reports carry consequences in both directions), *uphold* (`p_adj = max(current, report_uphold_penalty)`), *freeze* (cold-outreach tokens zeroed until `now + freeze_days`), or *none*. `p_adj` decays with the standing half-life: `p_adj(t) = p₀ · 2^(−Δt / standing_half_life_days)`. Account action — the final ladder rung — is human territory outside the PoC surface (governance.md).

**Enforcement points:** candidate and client ranking (`effective_trust`, §2 — with the §5.3 direct-follow override: chosen edges survive), the budget multiplier (§3), cold-initiation classification, and the freeze. The behavioral-friction rung (metadata-only signals: rate, fan-out breadth, timing regularity, signup clustering) remains a pre-standing pressure valve; its numeric trigger points are the one disclosed-as-unpublished layer. Users are told *that* they are limited (`GET /standing`), never the reporters, counts, or thresholds.

**Encrypted-content reports** carry the reporter's forwarded plaintext with a *structural* recipiency proof (the envelope names its recipients) — no key material ever reaches the server (protocol §9.2; architecture invariant 3).

## 5. Invariants (versioned promises)

1. Throttle, don't silence: penalties shrink reach to strangers; they never sever chosen edges and never delete content.
2. Standing decays; there are no permanent marks.
3. Penalties never override edges a user chose (follow/trust survives the author's standing collapse).
4. No purchasable reach, no PoW-mintable reach.
5. Trust comes only from deliberate user acts.
6. All of the math on this page is published; changes are announced protocol changes.

## 6. Constants (published; initial values, tune in testing)

| Constant | Initial | Notes |
|---|---|---|
| Hop cap | 2 | structural, not tunable |
| Per-hop decay | 0.35 | user-overridable locally |
| Multi-path sum cap | 2.0 | × direct-follow weight |
| Feed surface threshold | 0.3 | effective trust |
| Standing decay half-life | 30 days | toward 1.0; applies to `p_adj` |
| Report window | 30 days | reports count toward `p_auto` while younger |
| Report impact | 0.05 | `p_auto` per unit of diversity-weighted mass |
| Report auto cap | 0.6 | max `p_auto`; hitting it opens the review queue |
| Report cluster Jaccard | 0.3 | outbound-follow overlap that links two reporters |
| False-report burn | 0.2 | added to a dismissed report's reporter `p_adj` |
| Uphold penalty | 0.6 | `p_adj` floor set by an *uphold* decision |
| Freeze length | 7 days | cold-outreach freeze per *freeze* decision |
| Cold budget: open / personal-invite | 5 / 15 per day | token bucket |
| Budget carryover cap | ~2 days | |
| Budget growth constant `k` | 4 | 10 followers: 5 → 14.6 ≈ 3× base |
| Epoch max age | 30 days | + rotate on membership change |
| KDF (passphrase backup) | Argon2id, m=64 MiB, t=3, p=1 | see protocol §7 |
| Shamir (social recovery) | K-of-N, user-chosen | suggested default 3-of-5 |

Constants live in exactly two source files — one Go (`server/internal/trust/constants.go`), one TypeScript (`packages/core/src/constants.ts`, shared by client and simlab) — plus this table; a shared test vector asserts all three agree.

**Tuning:** the values above are *reference defaults*, tuned via **simlab** (design §16) — a constant change without a cited, checked-in simlab scenario is rejected in review. **Instances:** each instance publishes the constants it actually runs via `GET /api/v1/meta`; clients compute with the instance's values and visibly badge deviations from this table. The §5 invariants are not constants — they are code, identical on every non-forked instance.
