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

- `standing ∈ [0, 1]`, global, default `1.0` (enforcement layer, §4 below; constant `1.0` in the PoC).
- Feed buckets: `effective_trust ≥ 0.3` → ranks normally; `0 < et < 0.3` → exists, doesn't surface unprompted; no path → low-priority pull-only bucket. Explore mode (M8) is the sanctioned beyond-hop-2 discovery channel.
- **Computation locus (testing flag, design §3.3):** server proposes candidate ranking from the same published math; client recomputes from its entitled 2-hop slice and re-ranks before display. *Nothing renders as trusted unless the client's own computation agrees.* Divergence is detectable and should be surfaced in dev builds (log + UI badge) — that's the audit working.

## 3. Reach budgets (cold outreach) — M4

An initiation is **cold** iff the *recipient* has no trust path (≤2 hops, above threshold) to the sender — recipient's vantage, because budgets protect attention and attention belongs to receivers.

- **Costs one token** (and delivers muted/trayed): first DM to a stranger (request tray); mention of a stranger; reply-to-stranger (only the author-notification and default rank are gated — the reply exists in-thread regardless, and readers who trust the replier see it ranked normally); follow of a stranger.
- **Never metered:** public posting to your own feed; anything within your trust neighborhood; replying to anyone who engaged you first (engagement opens a reciprocal window — conversations, once started, are free).
- **Mechanics:** token bucket, daily refill, carryover cap ≈ 2 days.
  `budget = (base + k × log(1 + Σ inbound_trust)) × standing(sender)`
  where `Σ inbound_trust` sums followers' trust weights, each weighted by the follower's own standing. `k` chosen so ~10 real followers ≈ 3× base. **No age-based growth. No purchasable or PoW-purchasable expansion, ever.**

## 4. Standing & enforcement — M7

`standing` multiplies subjective trust and budgets; decays toward `1.0` with a 30-day half-life (no permanent marks). Moved by: diversity-weighted reports (reporter weight = reporter standing × log-scaled inbound trust; graph-correlated reporter clusters discounted; false reports burn the reporter), and the behavioral-friction ladder (metadata-only signals: rate, fan-out breadth, timing regularity, signup clustering). Graduated ladder: friction → reach reduction → cold-outreach freeze → account action, with the last rung always human-reviewed. Users are told *that* they are limited, not the precise thresholds (the one disclosed-as-unpublished layer).

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
| Standing decay half-life | 30 days | toward 1.0 |
| Cold budget: open / personal-invite | 5 / 15 per day | token bucket |
| Budget carryover cap | ~2 days | |
| Budget growth constant `k` | pick so 10 followers ≈ 3× base | |
| Epoch max age | 30 days | + rotate on membership change |
| KDF (passphrase backup) | Argon2id, m=64 MiB, t=3, p=1 | see protocol §7 |
| Shamir (social recovery) | K-of-N, user-chosen | suggested default 3-of-5 |

Constants live in exactly two source files — one Go (`server/internal/trust/constants.go`), one TypeScript (`packages/core/src/constants.ts`, shared by client and simlab) — plus this table; a shared test vector asserts all three agree.

**Tuning:** the values above are *reference defaults*, tuned via **simlab** (design §16) — a constant change without a cited, checked-in simlab scenario is rejected in review. **Instances:** each instance publishes the constants it actually runs via `GET /api/v1/meta`; clients compute with the instance's values and visibly badge deviations from this table. The §5 invariants are not constants — they are code, identical on every non-forked instance.
