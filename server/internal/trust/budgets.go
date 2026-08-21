package trust

import "math"

// EffectiveTrust is effective_trust = subjective_trust × standing, standing
// ∈ [0,1] (docs/trust-and-reach.md §1; 1.0 pre-M7). Mirrors
// packages/core/src/trust.ts effectiveTrust, including the out-of-range
// rejection (the TS reference throws).
func EffectiveTrust(subjective, standing float64) float64 {
	if standing < 0 || standing > 1 {
		panic("standing out of range [0,1]")
	}
	return subjective * standing
}

// IsColdInitiation classifies an initiation (docs/trust-and-reach.md §3): it
// is cold iff the recipient's effective trust in the sender is below
// FeedSurfaceThreshold — the RECIPIENT's vantage, because budgets protect
// attention and attention belongs to receivers. graph must therefore be
// built from the recipient's follows and mutes; senderStanding is 1.0
// pre-M7. Mirrors packages/core/src/budgets.ts isColdInitiation; the shared
// cold-01 vector keeps the two implementations honest. (The reciprocal
// DM window is a separate, storage-backed predicate applied by callers.)
func IsColdInitiation(recipient, sender string, graph GraphView, p Params, senderStanding float64) bool {
	return EffectiveTrust(SubjectiveTrust(recipient, sender, graph, p), senderStanding) < FeedSurfaceThreshold
}

// RefillBucket applies one elapsed day's refill to a token bucket
// (docs/trust-and-reach.md §3): add the daily budget, cap the carryover at
// carryoverDays × the daily budget. Mirrors packages/core/src/budgets.ts
// refillBucket. Negative balances (impossible by construction) clamp to 0
// before refilling, exactly as the TS reference.
func RefillBucket(tokens, budget, carryoverDays float64) float64 {
	return math.Min(math.Max(0, tokens)+budget, budget*carryoverDays)
}
