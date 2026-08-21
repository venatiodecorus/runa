/**
 * Reach metrics over the REAL trust math from @runa/core (never a fork —
 * that's simlab's whole evidentiary value, ADR-0006).
 *
 * reach(author) = number of viewers whose feed surfaces the author normally,
 * i.e. feedBucket(effective_trust) === "normal". Standing is 1.0 everywhere
 * until the M7 standing model exists.
 */
import { CONSTANTS, feedBucket, trustMap } from "@runa/core";
import type { Population, SimConstants } from "../population/types.js";

export interface CohortStats {
  count: number;
  mean: number;
  median: number;
  p90: number;
  max: number;
  values: number[]; // sorted ascending — histogram/CDF input
}

export interface ReachResult {
  perAccount: Record<string, number>;
  byCohort: Record<string, CohortStats>;
  elapsedMs?: number;
}

export function resolveConstants(overrides?: Partial<SimConstants>): SimConstants {
  return {
    per_hop_decay: CONSTANTS.per_hop_decay,
    multi_path_sum_cap: CONSTANTS.multi_path_sum_cap,
    feed_surface_threshold: CONSTANTS.feed_surface_threshold,
    cold_budget_open: CONSTANTS.cold_budget_open,
    budget_carryover_days: CONSTANTS.budget_carryover_days,
    budget_growth_k: CONSTANTS.budget_growth_k,
    ...overrides,
  };
}

export function computeReach(pop: Population, constants: SimConstants): ReachResult {
  const perAccount: Record<string, number> = {};
  for (const a of pop.accounts) perAccount[a] = 0;

  const graph = { follows: pop.follows };
  for (const viewer of pop.accounts) {
    const map = trustMap(viewer, graph, constants);
    for (const [author, subjective] of Object.entries(map)) {
      // standing 1.0 → effective === subjective
      if (feedBucket(subjective, constants) === "normal") perAccount[author]!++;
    }
  }

  const byCohort: Record<string, CohortStats> = {};
  for (const cohort of pop.spec.cohorts) {
    const values = pop.accounts
      .filter((a) => pop.cohortOf[a] === cohort.name)
      .map((a) => perAccount[a]!)
      .sort((x, y) => x - y);
    byCohort[cohort.name] = stats(values);
  }
  return { perAccount, byCohort };
}

function stats(sorted: number[]): CohortStats {
  const n = sorted.length;
  if (n === 0) return { count: 0, mean: 0, median: 0, p90: 0, max: 0, values: [] };
  const sum = sorted.reduce((s, v) => s + v, 0);
  const at = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))]!;
  return { count: n, mean: sum / n, median: at(0.5), p90: at(0.9), max: sorted[n - 1]!, values: sorted };
}
