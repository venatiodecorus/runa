/**
 * Standing math (docs/trust-and-reach.md §4): the one server-computed,
 * server-authoritative enforcement factor. Pure functions only — no record
 * shapes, no signing, no floats-in-signed-records concern (this is math, not
 * a wire record). Clients never recompute standing itself (its inputs,
 * reports, are private by design); this module exists so the Go server and
 * the simlab share exactly the reference implementation the vectors pin down.
 */
import { CONSTANTS } from "./constants.js";

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * p_adj(t) = p0 · 2^(-Δt / half-life) (trust-and-reach §4): the human rung
 * decays toward 0 with the standing half-life. p0 is clamped into [0,1]
 * first; a negative elapsedDays (clock skew, same-instant adjudication) is
 * treated as 0 elapsed.
 */
export function decayPenalty(
  p0: number,
  elapsedDays: number,
  halfLifeDays: number = CONSTANTS.standing_half_life_days,
): number {
  const p = clamp01(p0);
  const dt = Math.max(0, elapsedDays);
  return p * 2 ** (-dt / halfLifeDays);
}

/**
 * Reporter weight w(R) = (1 - p_adj(R)) × ln(1 + inbound_trust(R))
 * (trust-and-reach §4) — natural log, same scale as the budget formula
 * (budgets.ts). Deliberately the reporter's *adjudicated* component only
 * (not full standing including p_auto): discounting by p_auto would let
 * mass-reporting a target's likely defenders silence their reports
 * (report-the-reporters), and the definition would be recursive. Only a
 * human-confirmed false-report burn or uphold ever reduces a reporter's
 * future report weight.
 */
export function reporterWeight(adjPenalty: number, inboundTrust: number): number {
  return (1 - clamp01(adjPenalty)) * Math.log(1 + Math.max(0, inboundTrust));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  // Jaccard(∅,∅) = 0 by convention here, never 1: two accounts with empty
  // outbound follow sets share no evidence of coordination and must NOT be
  // linked just because both sets are empty.
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Connected components of the reporter link graph (trust-and-reach §4):
 * reporters R1, R2 are linked iff either follows the other, or the Jaccard
 * overlap of their outbound follow sets >= jaccardThreshold. Deterministic
 * output: components sorted by their lexicographically-smallest member,
 * members sorted within each component. `reporters` is deduped defensively.
 */
export function clusterReporters(
  reporters: readonly string[],
  follows: Record<string, readonly string[]>,
  jaccardThreshold: number = CONSTANTS.report_cluster_jaccard,
): string[][] {
  const nodes = Array.from(new Set(reporters));
  const followSets = new Map<string, Set<string>>();
  for (const r of nodes) followSets.set(r, new Set(follows[r] ?? []));

  // Union-find over the deduped reporter list.
  const parent = new Map<string, string>();
  for (const r of nodes) parent.set(r, r);
  function find(x: string): string {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const aFollowsB = followSets.get(a)!.has(b);
      const bFollowsA = followSets.get(b)!.has(a);
      const linked =
        aFollowsB || bFollowsA || jaccard(followSets.get(a)!, followSets.get(b)!) >= jaccardThreshold;
      if (linked) union(a, b);
    }
  }

  const groups = new Map<string, string[]>();
  for (const r of nodes) {
    const root = find(r);
    const group = groups.get(root);
    if (group) group.push(r);
    else groups.set(root, [r]);
  }

  const components = Array.from(groups.values()).map((members) => [...members].sort());
  components.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return components;
}

/**
 * Diversity-weighted report mass (trust-and-reach §4): each cluster
 * contributes only its maximum member weight — volume inside a cluster adds
 * nothing. Missing weight (a reporter absent from `weights`) counts as 0.
 */
export function reportMass(
  clusters: readonly (readonly string[])[],
  weights: Record<string, number>,
): number {
  let mass = 0;
  for (const cluster of clusters) {
    let max = 0;
    for (const member of cluster) {
      const w = weights[member] ?? 0;
      if (w > max) max = w;
    }
    mass += max;
  }
  return mass;
}

/** p_auto = min(cap, impact × max(0, mass)) (trust-and-reach §4). */
export function autoPenalty(
  mass: number,
  impact: number = CONSTANTS.report_impact,
  cap: number = CONSTANTS.report_auto_cap,
): number {
  return Math.min(cap, impact * Math.max(0, mass));
}

/** standing = (1 - p_auto) × (1 - p_adj) (protocol §9.3), each clamped to [0,1]. */
export function standingFrom(pAuto: number, pAdj: number): number {
  return (1 - clamp01(pAuto)) * (1 - clamp01(pAdj));
}
