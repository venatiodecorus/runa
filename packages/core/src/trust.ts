/**
 * Subjective trust computation (docs/trust-and-reach.md §§1–2). This is the
 * published math every client re-runs before rendering anything as trusted;
 * the Go server mirrors it for candidate ranking, and simlab exercises this
 * exact implementation. Shared vectors (trust-graph-01) keep all three honest.
 *
 * The viewer's own content is outside trust: trust(viewer, viewer) is not
 * defined by the spec — callers always show the viewer their own records.
 */
import { CONSTANTS } from "./constants.js";

/**
 * The viewer's entitled 2-hop slice: their own follows, plus the follow list
 * of each account they follow (GET /graph/2hop), plus their private mutes.
 */
export interface GraphView {
  follows: Record<string, readonly string[]>;
  mutes?: readonly string[];
}

export interface TrustConstants {
  per_hop_decay: number;
  multi_path_sum_cap: number;
  feed_surface_threshold: number;
}

/**
 * subjective_trust(viewer, author): direct follow = 1.0; each two-hop path
 * = decay; paths sum, capped at multi_path_sum_cap. Mutes are a hard zero
 * that also prunes propagation through the muted account. Hop cap 2 is
 * structural: anything further has no path.
 */
export function subjectiveTrust(
  viewer: string,
  author: string,
  graph: GraphView,
  constants: TrustConstants = CONSTANTS,
): number {
  if (author === viewer) throw new Error("self-trust is not defined; treat own content as always visible");
  const muted = new Set(graph.mutes ?? []);
  if (muted.has(author)) return 0;
  // Follow lists are sets by construction; dedupe defensively so a repeated
  // edge can never double-count into trust.
  const viewerFollows = new Set(graph.follows[viewer] ?? []);
  let weight = 0;
  for (const mid of viewerFollows) {
    if (muted.has(mid)) continue; // hard zero prunes the muted account's outbound edges
    if (mid === author) {
      weight += 1.0;
      continue;
    }
    if (new Set(graph.follows[mid] ?? []).has(author)) weight += constants.per_hop_decay;
  }
  return Math.min(weight, constants.multi_path_sum_cap);
}

/** Trust for every account reachable within the hop cap, from one pass. */
export function trustMap(
  viewer: string,
  graph: GraphView,
  constants: TrustConstants = CONSTANTS,
): Record<string, number> {
  const muted = new Set(graph.mutes ?? []);
  const out: Record<string, number> = {};
  for (const mid of new Set(graph.follows[viewer] ?? [])) {
    if (muted.has(mid)) continue;
    out[mid] = (out[mid] ?? 0) + 1.0;
    for (const far of new Set(graph.follows[mid] ?? [])) {
      if (far === viewer || muted.has(far)) continue;
      out[far] = (out[far] ?? 0) + constants.per_hop_decay;
    }
  }
  for (const k of Object.keys(out)) {
    out[k] = Math.min(out[k]!, constants.multi_path_sum_cap);
  }
  return out;
}

/** effective_trust = subjective_trust × standing (standing ∈ [0,1], default 1). */
export function effectiveTrust(subjective: number, standing = 1.0): number {
  if (standing < 0 || standing > 1) throw new Error("standing out of range [0,1]");
  return subjective * standing;
}

/**
 * Feed buckets (trust-and-reach §2): ≥ threshold ranks normally; a positive
 * sub-threshold score exists but doesn't surface unprompted; no path at all
 * is pull-only. `directFollow` (protocol §9.3, trust-and-reach §5 invariant
 * 3): an author the viewer directly follows ranks normally regardless of
 * effective trust — a standing penalty never severs a chosen edge.
 */
export type FeedBucket = "normal" | "below-threshold" | "no-path";

export function feedBucket(
  effective: number,
  constants: TrustConstants = CONSTANTS,
  directFollow = false,
): FeedBucket {
  if (directFollow) return "normal";
  if (effective >= constants.feed_surface_threshold) return "normal";
  if (effective > 0) return "below-threshold";
  return "no-path";
}
