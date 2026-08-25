import { describe, expect, it } from "vitest";
import { feedBucket, trustMap } from "@runa/core";
import { generatePopulation } from "../src/population/generate.js";
import type { ScenarioSpec } from "../src/population/types.js";
import { resolveConstants } from "../src/metrics/reach.js";
import { buildEgoModel, radialLayout, resolveViewer } from "../src/viz/ego.js";
import { computeOverviewPositions } from "../src/viz/overview.js";

const SPEC: ScenarioSpec = {
  name: "viz-test",
  seed: 5,
  graphModel: "random",
  cohorts: [
    { name: "core", kind: "honest", count: 60, meanFollows: 6 },
    { name: "ring", kind: "sybil-ring", count: 10, bridges: 2 },
  ],
};

const constants = resolveConstants();

describe("ego model", () => {
  const pop = generatePopulation(SPEC);
  const viewer = pop.accounts[0]!;
  const model = buildEgoModel(pop, viewer, constants);

  it("mirrors @runa/core trustMap exactly (never a fork)", () => {
    const expected = trustMap(viewer, { follows: pop.follows }, constants);
    for (const n of model.nodes) {
      if (n.ring === 0) continue;
      expect(n.trust).toBe(expected[n.id]);
      expect(n.bucket).toBe(feedBucket(n.trust, constants, n.ring === 1));
    }
    // every reachable account appears, nothing else
    const ids = model.nodes.filter((n) => n.ring > 0).map((n) => n.id);
    expect(new Set(ids)).toEqual(new Set(Object.keys(expected)));
  });

  it("assigns rings by graph distance", () => {
    const direct = new Set(pop.follows[viewer]);
    for (const n of model.nodes) {
      if (n.ring === 1) expect(direct.has(n.id)).toBe(true);
      if (n.ring === 2) expect(direct.has(n.id)).toBe(false);
    }
    expect(model.stats.direct + model.stats.twoHop + model.stats.noPath).toBe(pop.accounts.length - 1);
  });

  it("is deterministic", () => {
    expect(buildEgoModel(pop, viewer, constants)).toEqual(model);
  });
});

describe("radial layout", () => {
  const pop = generatePopulation(SPEC);
  const viewer = pop.accounts[0]!;
  const model = buildEgoModel(pop, viewer, constants);
  const pos = radialLayout(model);

  it("is deterministic, viewer-centered, concentric", () => {
    expect(radialLayout(model)).toEqual(pos);
    expect(pos[viewer]).toEqual({ x: 0, y: 0 });
    for (const n of model.nodes) {
      const p = pos[n.id]!;
      const r = Math.hypot(p.x, p.y);
      if (n.ring === 1) expect(r).toBeCloseTo(1, 6);
      if (n.ring === 2) expect(r).toBeCloseTo(2.2, 6);
    }
  });
});

describe("overview layout", () => {
  it("is seed-deterministic", () => {
    const a = computeOverviewPositions(generatePopulation(SPEC));
    const b = computeOverviewPositions(generatePopulation(SPEC));
    expect(b).toEqual(a);
    const c = computeOverviewPositions(generatePopulation({ ...SPEC, seed: 6 }));
    expect(c).not.toEqual(a);
  });
});

describe("resolveViewer", () => {
  it("falls back to the first account when the requested one is gone", () => {
    const pop = generatePopulation(SPEC);
    expect(resolveViewer(pop, null)).toBe(pop.accounts[0]);
    expect(resolveViewer(pop, "nope-9999")).toBe(pop.accounts[0]);
    expect(resolveViewer(pop, pop.accounts[3]!)).toBe(pop.accounts[3]);
  });
});
