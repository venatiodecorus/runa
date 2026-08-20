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

  // --- sybil rings: dense internal follows + bridge edges ------------------
  for (const cohort of spec.cohorts) {
    if (cohort.kind !== "sybil-ring") continue;
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

  const followerCount: Record<string, number> = {};
  for (const a of accounts) followerCount[a] = 0;
  for (const a of accounts) {
    for (const t of follows[a]!) followerCount[t] = (followerCount[t] ?? 0) + 1;
  }

  return { spec, accounts, cohortOf, kindOf, follows, followerCount };
}
