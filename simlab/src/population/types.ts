/** Scenario format (design §16). Checked-in files live in simlab/scenarios/. */
export interface CohortSpec {
  name: string;
  /**
   * reporter-brigade / reporter-diverse (M7, trust-and-reach §4): the two
   * report-cohort structural shapes referenced by design §12's "brigade vs
   * diversity-weighting" note. A brigade is a tight cluster by construction
   * (threat model A4) — reporter-brigade reuses the exact dense-internal-
   * follows generation sybil-ring already has. reporter-diverse is its
   * opposite: no follows among members (guarantees Jaccard(∅,∅)=0 → never
   * clusters, per standing.ts's convention), each member gets its own
   * distinct honest inbound followers (targetFollowers each) — "honest-like
   * inbound follows" per the M7 task brief.
   */
  kind: "honest" | "newcomer" | "sybil-ring" | "reporter-brigade" | "reporter-diverse";
  count: number;
  /** honest: target out-degree in the graph model. */
  meanFollows?: number;
  /**
   * newcomer: follows granted TO the newcomer by honest accounts at the day
   * horizon (trajectory only, no real edges).
   * reporter-diverse: real edges — distinct honest followers PER MEMBER.
   */
  targetFollowers?: number;
  /** newcomer/honest: mean cold initiations attempted per day (ceiling metric). */
  coldPerDay?: number;
  /** sybil-ring/reporter-brigade: honest accounts that follow into the cohort (bridge edges). */
  bridges?: number;
  /**
   * M7: this cohort's members report a target account (trust-and-reach §4).
   * `target` names another cohort; the target account resolves to that
   * cohort's first member (`<cohort>-0000`). `fraction` (default 1 = every
   * member reports) selects a deterministic prefix of the cohort's members
   * — no rng draw needed since member order is already seed-deterministic.
   */
  reports?: { target: string; fraction?: number };
}

export interface SimConstants {
  per_hop_decay: number;
  multi_path_sum_cap: number;
  feed_surface_threshold: number;
  cold_budget_open: number;
  budget_carryover_days: number;
  budget_growth_k: number;
}

export interface ScenarioSpec {
  name: string;
  description?: string;
  seed: number;
  graphModel: "random" | "small-world" | "preferential";
  cohorts: CohortSpec[];
  /** Horizon (days) for newcomer budget trajectories. Default 30. */
  days?: number;
  constants?: Partial<SimConstants>;
}

export interface Population {
  spec: ScenarioSpec;
  accounts: string[];
  cohortOf: Record<string, string>;
  kindOf: Record<string, CohortSpec["kind"]>;
  /** Follow graph in @runa/core GraphView shape. */
  follows: Record<string, string[]>;
  followerCount: Record<string, number>;
  /** M7: target account id -> reporter account ids, from cohorts' `reports` field. */
  reportsOf: Record<string, string[]>;
}
