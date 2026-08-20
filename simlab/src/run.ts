import { generatePopulation } from "./population/generate.js";
import type { Population, ScenarioSpec, SimConstants } from "./population/types.js";
import { ceilingHitRate, newcomerTrajectory, type CeilingResult, type TrajectoryPoint } from "./metrics/budgets.js";
import { computeReach, resolveConstants, type ReachResult } from "./metrics/reach.js";

export interface RunResult {
  scenario: string;
  seed: number;
  constants: SimConstants;
  accounts: number;
  reach: ReachResult;
  ceiling: CeilingResult;
  newcomerTrajectories: Record<string, TrajectoryPoint[]>; // per newcomer cohort
  population: Population;
}

/** One full deterministic run: population → reach → budget metrics. */
export function runScenario(spec: ScenarioSpec, constantOverrides?: Partial<SimConstants>): RunResult {
  const constants = resolveConstants({ ...spec.constants, ...constantOverrides });
  const days = spec.days ?? 30;
  const population = generatePopulation(spec);
  const reach = computeReach(population, constants);
  const ceiling = ceilingHitRate(population, constants, days, spec.seed);
  const newcomerTrajectories: Record<string, TrajectoryPoint[]> = {};
  for (const c of spec.cohorts) {
    if (c.kind === "newcomer") {
      newcomerTrajectories[c.name] = newcomerTrajectory(c.targetFollowers ?? 0, days, constants);
    }
  }
  return {
    scenario: spec.name,
    seed: spec.seed,
    constants,
    accounts: population.accounts.length,
    reach,
    ceiling,
    newcomerTrajectories,
    population,
  };
}

/** Compact, JSON-safe summary (drops per-account maps and the population). */
export function summarize(r: RunResult) {
  return {
    scenario: r.scenario,
    seed: r.seed,
    constants: r.constants,
    accounts: r.accounts,
    ceiling: { hit_rate: r.ceiling.hitRate, good_faith: r.ceiling.goodFaithCount, hits: r.ceiling.hitCount },
    reach_by_cohort: Object.fromEntries(
      Object.entries(r.reach.byCohort).map(([name, s]) => [
        name,
        { count: s.count, mean: round2(s.mean), median: s.median, p90: s.p90, max: s.max },
      ]),
    ),
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
