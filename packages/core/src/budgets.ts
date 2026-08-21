/**
 * Cold-outreach budget formula (docs/trust-and-reach.md §3):
 *
 *   budget = (base + k × log(1 + Σ inbound_trust)) × standing
 *
 * Σ inbound_trust sums followers' direct-follow weight (1.0) × each
 * follower's standing — with all standings at 1.0 (pre-M7) that is the
 * follower count. k = 4 makes ~10 real followers ≈ 3× the open-signup base
 * (5 → 14.6). Reference implementation: the Go server mirrors this behind
 * the budgets-01 vectors when M4 lands; simlab exercises this exact code.
 */
import { CONSTANTS } from "./constants.js";

export function dailyBudget(
  base: number,
  inboundTrust: number,
  k: number = CONSTANTS.budget_growth_k,
  standing = 1.0,
): number {
  if (standing < 0 || standing > 1) throw new Error("standing out of range [0,1]");
  return (base + k * Math.log(1 + Math.max(0, inboundTrust))) * standing;
}
