/**
 * Ego-view model: the viewer-subjective trust picture, straight from
 * @runa/core (never a fork — ADR-0006). Trust is structurally hop-capped
 * at 2 (trust-and-reach §1), so the whole ego network is exactly the
 * viewer's 2-hop slice: ring 0 = viewer, ring 1 = direct follows (weight
 * 1.0), ring 2 = follows-of-follows (per_hop_decay per path). Everything
 * here is pure and deterministic — layout derives from graph distance and
 * stable sorts, no rng.
 */
import { dailyBudget, feedBucket, trustMap } from "@runa/core";
import type { Population, SimConstants } from "../population/types.js";

export type Bucket = "normal" | "below-threshold";

export interface EgoNode {
  id: string;
  ring: 0 | 1 | 2;
  /** Viewer's subjective trust in this account (0 for the viewer itself). */
  trust: number;
  bucket: Bucket | "self";
  /** Direct follow surfaced only by the never-sever rule (invariant 2). */
  directOverride: boolean;
  cohort: string;
  kind: string;
  followers: number;
}

/** A follow edge contributing to the viewer's trust computation. */
export interface EgoEdge {
  source: string;
  target: string;
  /** Trust contribution carried by this edge: 1.0 direct, per_hop_decay hop. */
  weight: number;
}

export interface EgoStats {
  direct: number;
  twoHop: number;
  noPath: number;
  normal: number;
  belowThreshold: number;
  followers: number;
  /** Viewer's daily cold-outreach budget at these constants. */
  budget: number;
}

export interface EgoModel {
  viewer: string;
  nodes: EgoNode[]; // viewer first, then ring 1, then ring 2 (stable order)
  edges: EgoEdge[];
  stats: EgoStats;
}

/** The requested viewer if it exists in this population, else the first account. */
export function resolveViewer(pop: Population, requested: string | null): string {
  if (requested && requested in pop.cohortOf) return requested;
  return pop.accounts[0]!;
}

export function buildEgoModel(pop: Population, viewer: string, constants: SimConstants): EgoModel {
  const graph = { follows: pop.follows };
  const trust = trustMap(viewer, graph, constants);
  const direct = new Set(pop.follows[viewer] ?? []);

  const node = (id: string, ring: 0 | 1 | 2): EgoNode => {
    const t = trust[id] ?? 0;
    const isDirect = direct.has(id);
    const bucket = ring === 0 ? "self" : (feedBucket(t, constants, isDirect) as Bucket);
    return {
      id,
      ring,
      trust: t,
      bucket,
      directOverride: isDirect && feedBucket(t, constants, false) !== "normal",
      cohort: pop.cohortOf[id] ?? "?",
      kind: pop.kindOf[id] ?? "?",
      followers: pop.followerCount[id] ?? 0,
    };
  };

  const ring1 = [...direct].sort(byCohortThenId(pop));
  const ring2 = Object.keys(trust)
    .filter((id) => !direct.has(id))
    .sort(byCohortThenId(pop));
  const nodes = [node(viewer, 0), ...ring1.map((id) => node(id, 1)), ...ring2.map((id) => node(id, 2))];

  const inModel = new Set(nodes.map((n) => n.id));
  const edges: EgoEdge[] = ring1.map((id) => ({ source: viewer, target: id, weight: 1.0 }));
  for (const f of ring1) {
    for (const g of pop.follows[f] ?? []) {
      if (g === viewer || !inModel.has(g)) continue;
      edges.push({ source: f, target: g, weight: constants.per_hop_decay });
    }
  }

  const normal = nodes.filter((n) => n.bucket === "normal").length;
  return {
    viewer,
    nodes,
    edges,
    stats: {
      direct: ring1.length,
      twoHop: ring2.length,
      noPath: pop.accounts.length - 1 - ring1.length - ring2.length,
      normal,
      belowThreshold: nodes.length - 1 - normal,
      followers: pop.followerCount[viewer] ?? 0,
      // Σ inbound_trust reduces to follower count at standing 1.0 (§3).
      budget: dailyBudget(constants.cold_budget_open, pop.followerCount[viewer] ?? 0, constants.budget_growth_k),
    },
  };
}

const byCohortThenId = (pop: Population) => (a: string, b: string) => {
  const ca = pop.cohortOf[a] ?? "";
  const cb = pop.cohortOf[b] ?? "";
  return ca < cb ? -1 : ca > cb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

export interface NodePosition {
  x: number;
  y: number;
}

const R1 = 1;
const R2 = 2.2;

/**
 * Deterministic concentric-ring layout. Ring 1 spreads evenly (grouped by
 * cohort, then id). Ring 2 orders by the circular mean of its ring-1
 * parents' angles (barycentric — keeps 2-hop nodes near the follows that
 * reach them), then spreads evenly in that order to avoid overlap.
 */
export function radialLayout(model: EgoModel): Record<string, NodePosition> {
  const pos: Record<string, NodePosition> = { [model.viewer]: { x: 0, y: 0 } };

  const ring1 = model.nodes.filter((n) => n.ring === 1);
  const angle1: Record<string, number> = {};
  ring1.forEach((n, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / ring1.length;
    angle1[n.id] = a;
    pos[n.id] = { x: R1 * Math.cos(a), y: R1 * Math.sin(a) };
  });

  const parents: Record<string, number[]> = {};
  for (const e of model.edges) {
    if (e.source in angle1) (parents[e.target] ??= []).push(angle1[e.source]!);
  }
  const ring2 = model.nodes
    .filter((n) => n.ring === 2)
    .map((n) => ({ id: n.id, desired: circularMean(parents[n.id] ?? [0]) }))
    .sort((a, b) => a.desired - b.desired || (a.id < b.id ? -1 : 1));
  const start = ring2[0]?.desired ?? 0;
  ring2.forEach((n, i) => {
    const a = start + (2 * Math.PI * i) / ring2.length;
    pos[n.id] = { x: R2 * Math.cos(a), y: R2 * Math.sin(a) };
  });
  return pos;
}

function circularMean(angles: number[]): number {
  let sin = 0;
  let cos = 0;
  for (const a of angles) {
    sin += Math.sin(a);
    cos += Math.cos(a);
  }
  return Math.atan2(sin, cos);
}
