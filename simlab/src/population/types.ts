/** Scenario format (design §16). Checked-in files live in simlab/scenarios/. */
export interface CohortSpec {
  name: string;
  kind: "honest" | "newcomer" | "sybil-ring";
  count: number;
  /** honest: target out-degree in the graph model. */
  meanFollows?: number;
  /** newcomer: follows granted TO the newcomer by honest accounts at the day horizon. */
  targetFollowers?: number;
  /** newcomer/honest: mean cold initiations attempted per day (ceiling metric). */
  coldPerDay?: number;
  /** sybil-ring: honest accounts that follow into the ring (bridge edges). */
  bridges?: number;
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
}
