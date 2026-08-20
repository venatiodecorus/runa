/**
 * Published reference constants (docs/trust-and-reach.md §6).
 * MUST agree with server/internal/trust/constants.go and the spec table —
 * asserted by the constants protocol vector. Instances publish the values
 * they actually run via GET /api/v1/meta; clients compute with those and
 * badge deviations from these reference defaults (design §15).
 */
export const CONSTANTS = {
  hop_cap: 2,
  per_hop_decay: 0.35,
  multi_path_sum_cap: 2.0,
  feed_surface_threshold: 0.3,
  standing_half_life_days: 30,
  cold_budget_open: 5,
  cold_budget_invite: 15,
  budget_carryover_days: 2,
  epoch_max_age_days: 30,
} as const;

export type Constants = { [K in keyof typeof CONSTANTS]: number };
