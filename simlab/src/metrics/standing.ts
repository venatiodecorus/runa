/**
 * Standing & reports metrics over the REAL @runa/core math (trust-and-reach
 * §4). simlab never forks or reimplements this — reporterWeight,
 * clusterReporters, reportMass, autoPenalty, standingFrom, and decayPenalty
 * all come straight from packages/core/src/standing.ts; this module only
 * wires the simulated population's graph into that math.
 *
 * `p_adj` (a report's or a reporter's adjudicated component) defaults to 0
 * everywhere in simlab scenarios — there is no simulated adjudication
 * history — but every computation below is written against the formula
 * (1 - p_adj), not hardcoded to "count", so a scenario that *does* pass
 * p_adj values gets the correct grounded result.
 */
import {
  CONSTANTS,
  autoPenalty,
  clusterReporters,
  decayPenalty,
  reportMass,
  reporterWeight,
  standingFrom,
} from "@runa/core";
import type { Population } from "../population/types.js";

export interface StandingConstants {
  report_impact: number;
  report_auto_cap: number;
  report_cluster_jaccard: number;
  standing_half_life_days: number;
}

export function resolveStandingConstants(overrides?: Partial<StandingConstants>): StandingConstants {
  return {
    report_impact: CONSTANTS.report_impact,
    report_auto_cap: CONSTANTS.report_auto_cap,
    report_cluster_jaccard: CONSTANTS.report_cluster_jaccard,
    standing_half_life_days: CONSTANTS.standing_half_life_days,
    ...overrides,
  };
}

export interface StandingResult {
  target: string;
  reporters: string[];
  clusters: string[][];
  weights: Record<string, number>;
  mass: number;
  pAuto: number;
  pAdj: number;
  standing: number;
}

/** Invert `follows` into a followers-of index — pure graph plumbing, no core math. */
function invertFollows(follows: Record<string, readonly string[]>): Record<string, string[]> {
  const followersOf: Record<string, string[]> = {};
  for (const [follower, targets] of Object.entries(follows)) {
    for (const t of targets) (followersOf[t] ??= []).push(follower);
  }
  return followersOf;
}

/**
 * inbound_trust(R) (trust-and-reach §4/§3): Σ over R's followers of the
 * follower's adjudicated component (1 - p_adj). All p_adj default to 0 in
 * simlab (no adjudication simulated), so this reduces to a follower count in
 * the default case — but it's written against the formula, not the count,
 * so a scenario supplying `pAdjOf` gets the grounded result.
 */
export function inboundTrust(
  account: string,
  followersOf: Record<string, readonly string[]>,
  pAdjOf: Record<string, number> = {},
): number {
  const followers = followersOf[account] ?? [];
  let sum = 0;
  for (const f of followers) sum += 1 - Math.min(1, Math.max(0, pAdjOf[f] ?? 0));
  return sum;
}

/**
 * Full standing computation for one target account (trust-and-reach §4):
 * reporter weights from each reporter's own inbound trust, clusters over
 * the population's follow graph, diversity-weighted mass, p_auto, and
 * standing combining p_auto with the target's own p_adj (default 0 — no
 * human adjudication simulated unless `opts.pAdjOf` supplies one).
 */
export function computeStanding(
  pop: Population,
  target: string,
  reporters: readonly string[],
  opts: { pAdjOf?: Record<string, number>; constants?: Partial<StandingConstants> } = {},
): StandingResult {
  const constants = resolveStandingConstants(opts.constants);
  const pAdjOf = opts.pAdjOf ?? {};
  const followersOf = invertFollows(pop.follows);

  const weights: Record<string, number> = {};
  for (const r of reporters) {
    weights[r] = reporterWeight(pAdjOf[r] ?? 0, inboundTrust(r, followersOf, pAdjOf));
  }

  const clusters = clusterReporters(reporters, pop.follows, constants.report_cluster_jaccard);
  const mass = reportMass(clusters, weights);
  const pAuto = autoPenalty(mass, constants.report_impact, constants.report_auto_cap);
  const pAdjTarget = pAdjOf[target] ?? 0;
  const standing = standingFrom(pAuto, pAdjTarget);

  return { target, reporters: [...reporters], clusters, weights, mass, pAuto, pAdj: pAdjTarget, standing };
}

/** Standing for every target that has reports in this population (`pop.reportsOf`). */
export function computeAllStanding(
  pop: Population,
  opts: { pAdjOf?: Record<string, number>; constants?: Partial<StandingConstants> } = {},
): Record<string, StandingResult> {
  const out: Record<string, StandingResult> = {};
  for (const [target, reporters] of Object.entries(pop.reportsOf)) {
    out[target] = computeStanding(pop, target, reporters, opts);
  }
  return out;
}

export interface DecayPoint {
  day: number;
  pAdj: number;
  standing: number;
}

/**
 * Standing recovery trajectory after a human-rung adjudication (trust-and-
 * reach §4): p_adj(t) = p0 · 2^(-Δt/half-life), decaying toward 0 with no
 * permanent marks (§5 invariant 2). `pAuto` is held fixed across the
 * trajectory (default 0) — reports aging out of the report_window_days is a
 * separate automated-rung effect this helper isolates from, so it can show
 * the human-rung decay in isolation.
 */
export function decayTrajectory(
  p0: number,
  days: number,
  opts: { halfLifeDays?: number; pAuto?: number } = {},
): DecayPoint[] {
  const halfLife = opts.halfLifeDays ?? CONSTANTS.standing_half_life_days;
  const pAuto = opts.pAuto ?? 0;
  const out: DecayPoint[] = [];
  for (let day = 0; day <= days; day++) {
    const pAdj = decayPenalty(p0, day, halfLife);
    out.push({ day, pAdj, standing: standingFrom(pAuto, pAdj) });
  }
  return out;
}
