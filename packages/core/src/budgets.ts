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
import { effectiveTrust, subjectiveTrust, type GraphView, type TrustConstants } from "./trust.js";

export function dailyBudget(
  base: number,
  inboundTrust: number,
  k: number = CONSTANTS.budget_growth_k,
  standing = 1.0,
): number {
  if (standing < 0 || standing > 1) throw new Error("standing out of range [0,1]");
  return (base + k * Math.log(1 + Math.max(0, inboundTrust))) * standing;
}

/**
 * Cold-initiation classification (trust-and-reach §3): an initiation is cold
 * iff the RECIPIENT has no trust path to the sender at or above the surface
 * threshold — recipient's vantage, because budgets protect attention and
 * attention belongs to receivers. `graph` is the recipient's view;
 * `senderStanding` is 1.0 pre-M7.
 */
export function isColdInitiation(
  recipient: string,
  sender: string,
  graph: GraphView,
  constants: TrustConstants = CONSTANTS,
  senderStanding = 1.0,
): boolean {
  const trust = effectiveTrust(subjectiveTrust(recipient, sender, graph), senderStanding);
  return trust < constants.feed_surface_threshold;
}

/**
 * Daily token-bucket refill (trust-and-reach §3): add today's budget, cap the
 * carryover at carryoverDays × the daily budget.
 */
export function refillBucket(tokens: number, budget: number, carryoverDays: number = CONSTANTS.budget_carryover_days): number {
  return Math.min(Math.max(0, tokens) + budget, budget * carryoverDays);
}
