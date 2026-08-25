/**
 * Whole-population layout: ForceAtlas2 (Jacomy et al. 2014 — the Gephi
 * spatialization) run to a FIXED iteration count from SEEDED initial
 * positions, so the same scenario always lays out identically (simlab
 * determinism rule: no Math.random, no Date.now). Layout depends only on
 * topology, never on constants, so it's cached per scenario.
 */
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { Population } from "../population/types.js";
import { Rng } from "../rng.js";
import type { NodePosition } from "./ego.js";

/** Uncached compute — exported for determinism tests. */
export function computeOverviewPositions(pop: Population): Record<string, NodePosition> {
  const rng = new Rng(pop.spec.seed ^ 0x6e657477); // "netw"
  const graph = new Graph({ type: "directed", allowSelfLoops: false });
  for (const id of pop.accounts) {
    graph.addNode(id, { x: rng.next() * 2 - 1, y: rng.next() * 2 - 1 });
  }
  for (const [follower, followees] of Object.entries(pop.follows)) {
    for (const f of followees) graph.mergeEdge(follower, f);
  }
  const iterations = pop.accounts.length > 4000 ? 50 : 200;
  forceAtlas2.assign(graph, { iterations, settings: forceAtlas2.inferSettings(graph) });
  const pos: Record<string, NodePosition> = {};
  graph.forEachNode((id, attrs) => {
    pos[id] = { x: attrs.x as number, y: attrs.y as number };
  });
  return pos;
}

const cache = new Map<string, Record<string, NodePosition>>();

export function overviewPositions(pop: Population): Record<string, NodePosition> {
  const key = `${pop.spec.name}#${pop.spec.seed}#${pop.accounts.length}`;
  let pos = cache.get(key);
  if (!pos) {
    pos = computeOverviewPositions(pop);
    cache.set(key, pos);
  }
  return pos;
}
