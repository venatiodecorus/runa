import { describe, expect, it } from "vitest";
import { Rng } from "../src/rng.js";
import { generatePopulation } from "../src/population/generate.js";
import { runScenario } from "../src/run.js";
import type { ScenarioSpec } from "../src/population/types.js";

const tiny: ScenarioSpec = {
  name: "tiny",
  seed: 42,
  graphModel: "small-world",
  days: 10,
  cohorts: [
    { name: "core", kind: "honest", count: 200, meanFollows: 10, coldPerDay: 0.2 },
    { name: "new", kind: "newcomer", count: 20, targetFollowers: 8, coldPerDay: 1 },
    { name: "ring", kind: "sybil-ring", count: 30, bridges: 2 },
  ],
};

describe("determinism", () => {
  it("same seed → identical run; different seed → different population", () => {
    const a = runScenario(tiny);
    const b = runScenario(tiny);
    expect(a.reach.byCohort).toEqual(b.reach.byCohort);
    expect(a.ceiling).toEqual(b.ceiling);
    const c = generatePopulation({ ...tiny, seed: 43 });
    expect(c.follows).not.toEqual(generatePopulation(tiny).follows);
  });

  it("Rng is stable across calls", () => {
    const r1 = new Rng(7);
    const r2 = new Rng(7);
    expect([r1.next(), r1.int(100), r1.poisson(2)]).toEqual([r2.next(), r2.int(100), r2.poisson(2)]);
  });
});

describe("population shapes", () => {
  const pop = generatePopulation(tiny);

  it("builds all cohorts with unique ids and no self-follows", () => {
    expect(pop.accounts.length).toBe(250);
    expect(new Set(pop.accounts).size).toBe(250);
    for (const a of pop.accounts) expect(pop.follows[a]).not.toContain(a);
  });

  it("newcomers start with ~2 outbound follows into the honest graph", () => {
    const nc = pop.accounts.filter((a) => pop.kindOf[a] === "newcomer");
    for (const a of nc) {
      expect(pop.follows[a]!.length).toBeGreaterThan(0);
      expect(pop.follows[a]!.length).toBeLessThanOrEqual(2);
      for (const t of pop.follows[a]!) expect(pop.kindOf[t]).toBe("honest");
    }
  });

  it("sybil ring is internally dense with exactly the configured bridges", () => {
    const ring = pop.accounts.filter((a) => pop.kindOf[a] === "sybil-ring");
    for (const a of ring) expect(pop.follows[a]!.length).toBeGreaterThanOrEqual(20);
    let bridges = 0;
    for (const a of pop.accounts) {
      if (pop.kindOf[a] === "sybil-ring") continue;
      bridges += pop.follows[a]!.filter((t) => pop.kindOf[t] === "sybil-ring").length;
    }
    expect(bridges).toBe(2);
  });
});

describe("metrics sanity (the design's own claims, in miniature)", () => {
  const result = runScenario(tiny);

  it("honest reach far exceeds sybil reach into the honest graph", () => {
    // Ring members reach each other (dense internal follows), so ring reach
    // ≈ ring size; each bridge leaks only the bridge account's immediate
    // neighborhood (one damped path). Confinement claims: the typical ring
    // member reaches nothing beyond the ring, and even the best-reaching
    // ring member stays below the honest cohort's p90.
    const core = result.reach.byCohort["core"]!;
    const ring = result.reach.byCohort["ring"]!;
    expect(core.mean).toBeGreaterThan(0);
    expect(ring.median).toBeLessThanOrEqual(31);
    expect(ring.max).toBeLessThan(core.p90);
  });

  it("good-faith ceiling-hit rate stays under the design target", () => {
    expect(result.ceiling.hitRate).toBeLessThan(0.01);
  });

  it("newcomer budget grows with followers", () => {
    const traj = result.newcomerTrajectories["new"]!;
    expect(traj[0]!.budget).toBeCloseTo(result.constants.cold_budget_open, 6);
    expect(traj.at(-1)!.budget).toBeGreaterThan(traj[0]!.budget * 2);
  });

  it("raising decay raises neighborhood reach monotonically", () => {
    const low = runScenario(tiny, { per_hop_decay: 0.2 });
    const high = runScenario(tiny, { per_hop_decay: 0.5 });
    expect(high.reach.byCohort["core"]!.mean).toBeGreaterThanOrEqual(low.reach.byCohort["core"]!.mean);
  });
});
