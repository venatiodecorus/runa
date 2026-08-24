import { describe, expect, it } from "vitest";
import { CONSTANTS } from "@runa/core";
import { generatePopulation } from "../src/population/generate.js";
import { computeAllStanding, computeStanding, decayTrajectory } from "../src/metrics/standing.js";
import brigadeStress from "../scenarios/brigade-stress.json";
import diverseReports from "../scenarios/diverse-reports.json";
import type { ScenarioSpec } from "../src/population/types.js";

const brigade = brigadeStress as ScenarioSpec;
const diverse = diverseReports as ScenarioSpec;

describe("determinism", () => {
  it("same seed → identical standing outcomes", () => {
    const a = computeAllStanding(generatePopulation(brigade));
    const b = computeAllStanding(generatePopulation(brigade));
    expect(a).toEqual(b);
  });

  it("different seed → different population, generally different standing", () => {
    const a = computeAllStanding(generatePopulation(brigade));
    const c = computeAllStanding(generatePopulation({ ...brigade, seed: brigade.seed + 1 }));
    expect(a["target-0000"]!.mass).not.toBe(c["target-0000"]!.mass);
  });
});

describe("brigade-stress: a 200-strong tight cluster barely dents standing", () => {
  const pop = generatePopulation(brigade);
  const result = computeAllStanding(pop)["target-0000"]!;

  it("collapses to a single reporter cluster (dense internal follows)", () => {
    expect(result.reporters.length).toBe(200);
    expect(result.clusters.length).toBeLessThanOrEqual(3);
    // The overwhelming majority of the brigade lands in one component.
    const largest = Math.max(...result.clusters.map((c) => c.length));
    expect(largest).toBeGreaterThan(190);
  });

  it("mass ≈ one member's weight, not 200 summed weights", () => {
    // Measured 2026-08-24: mass ≈ 3.53. A single member's weight
    // (ln(1 + in-degree)) is well under 4 even for the densest node, so
    // mass must be far below what 200 independent reporters would produce
    // (diverse-reports gets to 12.4 with only 5).
    expect(result.mass).toBeGreaterThan(1);
    expect(result.mass).toBeLessThan(5);
  });

  it("p_auto stays far under the cap and target standing stays high", () => {
    expect(result.pAuto).toBeLessThan(0.3);
    // Measured standing ≈ 0.824; assert with margin below that.
    expect(result.standing).toBeGreaterThan(0.75);
  });
});

describe("diverse-reports: 5 unconnected reporters hit the automation cap", () => {
  const pop = generatePopulation(diverse);
  const result = computeAllStanding(pop)["target-0000"]!;

  it("never links — 5 singleton clusters", () => {
    expect(result.reporters.length).toBe(5);
    expect(result.clusters.length).toBe(5);
    for (const cluster of result.clusters) expect(cluster.length).toBe(1);
  });

  it("mass ≈ 12 (5 × ln(12)) and p_auto is capped exactly at report_auto_cap", () => {
    expect(result.mass).toBeGreaterThan(12);
    expect(result.mass).toBeLessThan(13);
    expect(result.pAuto).toBe(CONSTANTS.report_auto_cap);
  });

  it("standing collapses to (1 - cap)", () => {
    expect(result.standing).toBeCloseTo(1 - CONSTANTS.report_auto_cap, 6);
  });
});

describe("the design claim in miniature: diversity beats volume", () => {
  it("5 diverse reporters produce more mass than 200 brigaded reporters", () => {
    const brigadeResult = computeAllStanding(generatePopulation(brigade))["target-0000"]!;
    const diverseResult = computeAllStanding(generatePopulation(diverse))["target-0000"]!;
    expect(diverseResult.reporters.length).toBeLessThan(brigadeResult.reporters.length);
    expect(diverseResult.mass).toBeGreaterThan(brigadeResult.mass);
    expect(diverseResult.standing).toBeLessThan(brigadeResult.standing);
  });
});

describe("decay: standing recovers monotonically, no permanent marks", () => {
  it("an uphold penalty (0.6) halves to 0.3 after one half-life (30 days)", () => {
    const traj = decayTrajectory(CONSTANTS.report_uphold_penalty, 60);
    expect(traj[0]!.pAdj).toBeCloseTo(0.6, 6);
    expect(traj[30]!.pAdj).toBeCloseTo(0.3, 6);
    expect(traj[60]!.pAdj).toBeCloseTo(0.15, 6);
  });

  it("standing recovers monotonically toward 1 as p_adj decays", () => {
    const traj = decayTrajectory(CONSTANTS.report_uphold_penalty, 90);
    for (let i = 1; i < traj.length; i++) {
      expect(traj[i]!.standing).toBeGreaterThanOrEqual(traj[i - 1]!.standing);
    }
    expect(traj[0]!.standing).toBeCloseTo(1 - CONSTANTS.report_uphold_penalty, 6);
    expect(traj.at(-1)!.standing).toBeGreaterThan(0.9);
  });

  it("clock skew (negative elapsed) never applies to this helper — day 0 is p0 exactly", () => {
    const traj = decayTrajectory(0.4, 0);
    expect(traj).toHaveLength(1);
    expect(traj[0]!.pAdj).toBeCloseTo(0.4, 6);
  });
});

describe("computeStanding directly (no population-level reportsOf lookup)", () => {
  it("agrees with computeAllStanding for the same target/reporters", () => {
    const pop = generatePopulation(diverse);
    const viaAll = computeAllStanding(pop)["target-0000"]!;
    const direct = computeStanding(pop, "target-0000", pop.reportsOf["target-0000"]!);
    expect(direct).toEqual(viaAll);
  });
});
