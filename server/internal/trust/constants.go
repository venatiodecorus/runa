// Package trust holds the server-side mirror of the published trust & reach
// math. The reference constants below MUST agree with
// packages/core/src/constants.ts and the table in docs/trust-and-reach.md —
// a shared protocol vector asserts this.
package trust

// Published constants (docs/trust-and-reach.md §6). These are the reference
// defaults; the values an instance actually runs are published via /api/v1/meta.
const (
	HopCap               = 2
	PerHopDecay          = 0.35
	MultiPathSumCap      = 2.0
	FeedSurfaceThreshold = 0.3
	StandingHalfLifeDays = 30
	ColdBudgetOpen       = 5
	ColdBudgetInvite     = 15
	BudgetCarryoverDays  = 2
	BudgetGrowthK        = 4
	EpochMaxAgeDays      = 30
)

// Constants returns the published constants as a map, in the shape served by
// GET /api/v1/meta and asserted by the constants protocol vector.
func Constants() map[string]any {
	return map[string]any{
		"hop_cap":                 HopCap,
		"per_hop_decay":           PerHopDecay,
		"multi_path_sum_cap":      MultiPathSumCap,
		"feed_surface_threshold":  FeedSurfaceThreshold,
		"standing_half_life_days": StandingHalfLifeDays,
		"cold_budget_open":        ColdBudgetOpen,
		"cold_budget_invite":      ColdBudgetInvite,
		"budget_carryover_days":   BudgetCarryoverDays,
		"budget_growth_k":         BudgetGrowthK,
		"epoch_max_age_days":      EpochMaxAgeDays,
	}
}
