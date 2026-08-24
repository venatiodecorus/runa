import { Rng } from "../rng.js";
import type { CohortSpec, Population, ScenarioSpec } from "./types.js";

/**
 * Builds a deterministic population from a scenario. Honest cohorts are wired
 * by the chosen graph model over the union of honest accounts; newcomers
 * arrive with a couple of outbound follows and (at day 0) no followers;
 * sybil rings are dense internally with a configurable number of honest
 * bridge edges — the structure the trust math is supposed to contain.
 */
export function generatePopulation(spec: ScenarioSpec): Population {
  const rng = new Rng(spec.seed);
  const accounts: string[] = [];
  const cohortOf: Record<string, string> = {};
  const kindOf: Record<string, CohortSpec["kind"]> = {};
  const follows: Record<string, string[]> = {};
  const edge = (from: string, to: string) => {
    if (from === to) return;
    const list = (follows[from] ??= []);
    if (!list.includes(to)) list.push(to);
  };

  for (const cohort of spec.cohorts) {
    for (let i = 0; i < cohort.count; i++) {
      const id = `${cohort.name}-${String(i).padStart(4, "0")}`;
      accounts.push(id);
      cohortOf[id] = cohort.name;
      kindOf[id] = cohort.kind;
      follows[id] = [];
    }
  }

  const honest = accounts.filter((a) => kindOf[a] === "honest");

  // --- honest wiring per graph model ---------------------------------------
  const degreeOf = (a: string) => spec.cohorts.find((c) => c.name === cohortOf[a])!.meanFollows ?? 15;
  switch (spec.graphModel) {
    case "random": {
      for (const a of honest) {
        for (const idx of rng.distinct(degreeOf(a), honest.length, honest.indexOf(a))) {
          edge(a, honest[idx]!);
        }
      }
      break;
    }
    case "small-world": {
      // Watts–Strogatz-style: ring lattice, each node follows k nearest
      // (k/2 per side), each edge rewired to a random node with p = 0.1.
      const n = honest.length;
      for (let i = 0; i < n; i++) {
        const k = degreeOf(honest[i]!);
        for (let d = 1; d <= Math.max(1, Math.floor(k / 2)); d++) {
          for (const j of [(i + d) % n, (i - d + n) % n]) {
            const target = rng.chance(0.1) ? honest[rng.int(n)]! : honest[j]!;
            edge(honest[i]!, target);
          }
        }
      }
      break;
    }
    case "preferential": {
      // Barabási–Albert-style: later nodes follow targets weighted by
      // current in-degree + 1 — produces the well-connected-minority shape.
      const inDeg: number[] = honest.map(() => 0);
      for (let i = 1; i < honest.length; i++) {
        const m = Math.min(degreeOf(honest[i]!), i);
        for (let e = 0; e < m; e++) {
          let total = 0;
          for (let j = 0; j < i; j++) total += inDeg[j]! + 1;
          let r = rng.next() * total;
          let target = 0;
          for (let j = 0; j < i; j++) {
            r -= inDeg[j]! + 1;
            if (r <= 0) {
              target = j;
              break;
            }
          }
          edge(honest[i]!, honest[target]!);
          inDeg[target]!++;
        }
      }
      break;
    }
  }

  // --- newcomers: a couple of outbound follows into the honest graph -------
  for (const a of accounts) {
    if (kindOf[a] !== "newcomer" || honest.length === 0) continue;
    for (const idx of rng.distinct(2, honest.length)) edge(a, honest[idx]!);
  }

  // --- sybil rings & reporter-brigades: dense internal follows + bridge
  // edges. A brigade is structurally identical to a sybil ring — "a tight
  // cluster by definition" (trust-and-reach §4) — so it reuses this exact
  // generation, just tagged with a different kind for metrics/ceiling logic.
  for (const cohort of spec.cohorts) {
    if (cohort.kind !== "sybil-ring" && cohort.kind !== "reporter-brigade") continue;
    const ring = accounts.filter((a) => cohortOf[a] === cohort.name);
    const internal = Math.min(ring.length - 1, 20);
    for (const a of ring) {
      for (const idx of rng.distinct(internal, ring.length, ring.indexOf(a))) {
        edge(a, ring[idx]!);
      }
    }
    for (let b = 0; b < (cohort.bridges ?? 0) && honest.length > 0; b++) {
      edge(rng.pick(honest), rng.pick(ring));
    }
  }

  // --- reporter-diverse: the opposite structural shape — no follows among
  // members at all (guarantees they can never link/cluster: direct-follow
  // is false and Jaccard(∅,∅)=0 by standing.ts's convention), each member
  // gets its own distinct set of honest inbound followers ("honest-like
  // inbound follows" — same shape a genuine account earns, not a synthetic
  // count) so reporter weight is grounded in real graph structure.
  for (const cohort of spec.cohorts) {
    if (cohort.kind !== "reporter-diverse") continue;
    const members = accounts.filter((a) => cohortOf[a] === cohort.name);
    const followersEach = cohort.targetFollowers ?? 10;
    for (const member of members) {
      if (honest.length === 0) break;
      for (const idx of rng.distinct(followersEach, honest.length)) {
        edge(honest[idx]!, member);
      }
    }
  }

  const followerCount: Record<string, number> = {};
  for (const a of accounts) followerCount[a] = 0;
  for (const a of accounts) {
    for (const t of follows[a]!) followerCount[t] = (followerCount[t] ?? 0) + 1;
  }

  // --- reporting cohorts: resolve `reports.target` to the target cohort's
  // first member, and select a deterministic prefix of `fraction` (default
  // all) of the reporting cohort's members. No rng draw: member order is
  // already seed-deterministic (built in cohort/index order above).
  const reportsOf: Record<string, string[]> = {};
  for (const cohort of spec.cohorts) {
    if (!cohort.reports) continue;
    const targetAccount = `${cohort.reports.target}-0000`;
    const members = accounts.filter((a) => cohortOf[a] === cohort.name);
    const fraction = cohort.reports.fraction ?? 1;
    const n = Math.max(0, Math.min(members.length, Math.round(members.length * fraction)));
    const reporters = members.slice(0, n);
    (reportsOf[targetAccount] ??= []).push(...reporters);
  }

  return { spec, accounts, cohortOf, kindOf, follows, followerCount, reportsOf };
}
