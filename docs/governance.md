# Governance & Operations

**Status:** v0.1 stub — design §9 doc 4. Deliberately thin until there is a running network; the structure below is what M9 fills in. Kept in-repo from day one so "spec change = reviewed change" applies to governance itself.

## Where human judgment lives

- The final rung of the enforcement ladder (account action) is **always human-reviewed**. Automation may only move accounts along the early rungs (friction, reach reduction, cold-outreach freeze). Invite provenance is surfaced to humans only at this rung, never published.
- Adjudicating contested reports (which feeds reporter-standing consequences in both directions).

## How thresholds and algorithms change

- All published constants (see [`trust-and-reach.md`](trust-and-reach.md) §6) change only via reviewed PRs to this repo, announced before deploy.
- The unpublished operational friction thresholds are the *only* closed layer; that boundary is itself disclosed. Changes to *which* signals exist are public (spec change); only the numeric trigger points are private.
- Algorithm changes (trust math, ranking, budget formula) are protocol changes: spec PR + announcement + client-observable (clients re-verify, so a silent server-side change diverges visibly).

## Documentation-change process

The four living documents ([`threat-model.md`](threat-model.md), [`protocol.md`](protocol.md), [`trust-and-reach.md`](trust-and-reach.md), this file) are versioned and changed via the same review process as code. A spec change without accompanying test vectors (where applicable) is rejected in review.

## Open items (fill during M7–M9)

- Reviewer roles and accountability for the human-review queue.
- Appeal path for account actions.
- Announcement channel and lead time for constant/algorithm changes.
- Third-party client policy (the audit mechanism of design §9 — API stability promises).
