/**
 * Cold-outreach budget model (trust-and-reach §3). The formula lives here
 * until the M4 server work promotes it (and budget_growth_k) into
 * @runa/core + Go behind shared vectors; the shapes match the spec exactly:
 *
 *   budget = (base + k × log(1 + Σ inbound_trust)) × standing
 *
 * Inbound trust of an account sums its followers' direct-follow weight (1.0)
 * × each follower's standing — with standing fixed at 1.0 pre-M7, that is
 * the follower count.
 */
import { Rng } from "../rng.js";
import type { Population, SimConstants } from "../population/types.js";

export function dailyBudget(base: number, inboundTrust: number, k: number, standing = 1.0): number {
  return (base + k * Math.log(1 + inboundTrust)) * standing;
}

export interface TrajectoryPoint {
  day: number;
  followers: number;
  budget: number;
}

/** A newcomer's budget as followers accrue linearly toward the cohort target. */
export function newcomerTrajectory(
  targetFollowers: number,
  days: number,
  constants: SimConstants,
): TrajectoryPoint[] {
  const out: TrajectoryPoint[] = [];
  for (let day = 0; day <= days; day++) {
    const followers = Math.round((targetFollowers * day) / days);
    out.push({
      day,
      followers,
      budget: dailyBudget(constants.cold_budget_open, followers, constants.budget_growth_k),
    });
  }
  return out;
}

export interface CeilingResult {
  /** Fraction of good-faith accounts that ever exhausted their bucket. Target < 0.01 (design §13). */
  hitRate: number;
  goodFaithCount: number;
  hitCount: number;
}

/**
 * Token-bucket simulation over the horizon: attempts ~ Poisson(coldPerDay);
 * refill daily; carryover capped at budget_carryover_days × daily budget.
 * Good-faith = honest + newcomer cohorts (sybils are supposed to hit it).
 */
export function ceilingHitRate(pop: Population, constants: SimConstants, days: number, seed: number): CeilingResult {
  const rng = new Rng(seed ^ 0x5ca1ab1e);
  let goodFaithCount = 0;
  let hitCount = 0;
  for (const account of pop.accounts) {
    const kind = pop.kindOf[account]!;
    if (kind === "sybil-ring") continue;
    const cohort = pop.spec.cohorts.find((c) => c.name === pop.cohortOf[account])!;
    const coldPerDay = cohort.coldPerDay ?? 0;
    goodFaithCount++;
    if (coldPerDay === 0) continue;

    let hit = false;
    let tokens = 0;
    for (let day = 0; day <= days; day++) {
      const followers =
        kind === "newcomer"
          ? Math.round(((cohort.targetFollowers ?? 0) * day) / days)
          : pop.followerCount[account]!;
      const budget = dailyBudget(constants.cold_budget_open, followers, constants.budget_growth_k);
      tokens = Math.min(tokens + budget, budget * constants.budget_carryover_days);
      let attempts = rng.poisson(coldPerDay);
      while (attempts-- > 0) {
        if (tokens < 1) {
          hit = true;
          break;
        }
        tokens -= 1;
      }
      if (hit) break;
    }
    if (hit) hitCount++;
  }
  return { hitRate: goodFaithCount === 0 ? 0 : hitCount / goodFaithCount, goodFaithCount, hitCount };
}
