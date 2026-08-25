/**
 * simlab interactive UI (design §16): pick a scenario, drag published
 * constants, watch reach and budget metrics recompute against the REAL
 * @runa/core math. Deviations from reference defaults are badged — same
 * rule the client applies to instances (design §15).
 */
import baseline from "../../scenarios/baseline-10k.json";
import sybilStress from "../../scenarios/sybil-stress.json";
import brigadeStress from "../../scenarios/brigade-stress.json";
import diverseReports from "../../scenarios/diverse-reports.json";
import type { ScenarioSpec, SimConstants } from "../population/types.js";
import { resolveConstants } from "../metrics/reach.js";
import { computeAllStanding, type StandingResult } from "../metrics/standing.js";
import { runScenario, type RunResult } from "../run.js";
import { attachLineTooltips, esc, fmt, histogram, legend, lineChart, type Series } from "./charts.js";
import { buildNetworkView, type NetworkState, type NetworkView } from "./network.js";
import { INK, SURFACE } from "./theme.js";

const SCENARIOS: ScenarioSpec[] = [
  baseline as ScenarioSpec,
  sybilStress as ScenarioSpec,
  brigadeStress as ScenarioSpec,
  diverseReports as ScenarioSpec,
];
const REFERENCE = resolveConstants();

interface SliderSpec {
  key: keyof SimConstants;
  label: string;
  min: number;
  max: number;
  step: number;
}
const SLIDERS: SliderSpec[] = [
  { key: "per_hop_decay", label: "Per-hop decay", min: 0, max: 1, step: 0.05 },
  { key: "multi_path_sum_cap", label: "Multi-path sum cap", min: 1, max: 4, step: 0.25 },
  { key: "feed_surface_threshold", label: "Feed surface threshold", min: 0, max: 1, step: 0.05 },
  { key: "cold_budget_open", label: "Cold budget (open signup)", min: 1, max: 20, step: 1 },
  { key: "budget_growth_k", label: "Budget growth k", min: 0, max: 10, step: 0.5 },
  { key: "budget_carryover_days", label: "Budget carryover (days)", min: 1, max: 5, step: 1 },
];

const state = {
  scenario: SCENARIOS[0]!,
  overrides: {} as Partial<SimConstants>,
  result: null as RunResult | null,
  computing: false,
  pending: 0,
  net: { viewer: null, overviewOn: false, colorMode: "cohort" } as NetworkState,
};

export function mount(root: HTMLElement): void {
  root.style.background = SURFACE;
  recompute(root);
}

function recompute(root: HTMLElement): void {
  state.computing = true;
  render(root);
  const ticket = ++state.pending;
  setTimeout(() => {
    if (ticket !== state.pending) return; // superseded by a newer edit
    const t0 = performance.now();
    const result = runScenario(state.scenario, state.overrides);
    result.reach.elapsedMs = performance.now() - t0;
    state.result = result;
    state.computing = false;
    render(root);
  }, 30);
}

function render(root: HTMLElement): void {
  const r = state.result;
  const cohorts = state.scenario.cohorts.map((c) => c.name);
  const net: NetworkView | null =
    r && !state.computing
      ? buildNetworkView(r, REFERENCE, Object.keys(state.overrides).length > 0, state.net)
      : null;

  root.innerHTML = `
  <main style="font-family:system-ui;max-width:960px;margin:1.5rem auto;padding:0 1rem;color:${INK.primary}">
    <h1 style="margin:0 0 .25rem">Runa simlab</h1>
    <p style="color:${INK.secondary};margin:0 0 1rem">Every number below comes from the same <code>@runa/core</code> trust/budget code the client ships. Seed ${state.scenario.seed} — identical inputs give identical results.</p>

    <section style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;margin-bottom:1rem">
      <label>Scenario
        <select data-scenario style="margin-left:.5rem">${SCENARIOS.map(
          (s) => `<option value="${esc(s.name)}"${s === state.scenario ? " selected" : ""}>${esc(s.name)}</option>`,
        ).join("")}</select>
      </label>
      <span style="color:${INK.muted};font-size:12px">${esc(state.scenario.description ?? "")}</span>
    </section>

    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:.5rem 1.5rem;margin-bottom:1.25rem">
      ${SLIDERS.map(sliderRow).join("")}
    </section>

    ${state.computing || !r ? `<p style="color:${INK.muted}">computing…</p>` : results(r, cohorts, net)}
  </main>`;

  root.querySelector<HTMLSelectElement>("[data-scenario]")!.addEventListener("change", (e) => {
    state.scenario = SCENARIOS.find((s) => s.name === (e.target as HTMLSelectElement).value)!;
    state.overrides = {};
    state.net = { viewer: null, overviewOn: false, colorMode: "cohort" };
    recompute(root);
  });
  for (const input of root.querySelectorAll<HTMLInputElement>("input[data-const]")) {
    input.addEventListener("input", () => {
      const key = input.dataset.const as keyof SimConstants;
      const value = Number(input.value);
      if (value === REFERENCE[key]) delete state.overrides[key];
      else state.overrides[key] = value;
      recompute(root);
    });
  }
  const resetBtn = root.querySelector("[data-reset]");
  resetBtn?.addEventListener("click", () => {
    state.overrides = {};
    recompute(root);
  });
  if (r) {
    attachLineTooltips(root, {
      cdf: cdfSeries(r, cohorts),
      trajectory: trajectorySeries(r),
    });
  }
  net?.wire(root, {
    onViewer: (id) => {
      state.net.viewer = id;
      render(root); // constants unchanged — re-render only, no recompute
    },
    onOverviewShow: () => {
      state.net.overviewOn = true;
      render(root);
    },
    onColorMode: (mode) => {
      state.net.colorMode = mode;
      render(root);
    },
  });
}

function sliderRow(s: SliderSpec): string {
  const value = state.overrides[s.key] ?? REFERENCE[s.key];
  const modified = value !== REFERENCE[s.key];
  return `<label style="font-size:12px;color:${INK.secondary};display:flex;align-items:center;gap:.5rem">
    <span style="flex:1">${esc(s.label)}</span>
    <input type="range" data-const="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${value}" style="flex:1.4">
    <strong style="width:2.6rem;text-align:right;color:${INK.primary}">${fmt(value)}</strong>
    ${
      modified
        ? `<span title="reference: ${REFERENCE[s.key]}" style="background:#fdf0e7;color:#a04010;border-radius:3px;padding:0 4px;font-size:10px">≠ ref</span>`
        : `<span style="width:2.2rem"></span>`
    }
  </label>`;
}

function results(r: RunResult, cohorts: string[], net: NetworkView | null): string {
  const underTarget = r.ceiling.hitRate < 0.01;
  const tiles = [
    tile(String(r.accounts), "accounts"),
    tile(
      `${(r.ceiling.hitRate * 100).toFixed(2)}%`,
      `good-faith accounts ever hitting a budget ceiling — ${underTarget ? "✓ under" : "✗ OVER"} the 1% design target`,
    ),
    ...cohorts.map((c) => tile(fmt(r.reach.byCohort[c]?.mean ?? 0), `${c}: mean reach (viewers surfacing normally)`)),
    tile(`${Math.round(r.reach.elapsedMs ?? 0)} ms`, "full-population recompute"),
  ].join("");

  const xMax = Math.max(1, ...cohorts.map((c) => r.reach.byCohort[c]?.max ?? 0));
  const hists = cohorts
    .map((c, i) =>
      histogram({ title: `${c} — reach distribution`, colorIndex: i, values: r.reach.byCohort[c]?.values ?? [], xMax }),
    )
    .join("");

  const trajectories = trajectorySeries(r);
  return `
    <section style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1.25rem">${tiles}</section>
    ${net?.html ?? ""}
    ${standingSection(r)}
    <section style="margin-bottom:1.25rem">
      <h2 style="font-size:14px;margin:0 0 .25rem">Reach CDF by cohort</h2>
      <p style="color:${INK.muted};font-size:11px;margin:0 0 .25rem">fraction of the cohort (y) whose reach is ≤ x — steeper-left = less reach</p>
      ${legend(cohorts)}
      ${lineChart({ id: "cdf", series: cdfSeries(r, cohorts), xLabel: "reach (viewers)", yLabel: "fraction ≤ x", yMax: 1 })}
    </section>
    <section style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1.25rem">${hists}</section>
    ${
      trajectories.length
        ? `<section style="margin-bottom:1.25rem">
      <h2 style="font-size:14px;margin:0 0 .25rem">Newcomer daily cold-outreach budget</h2>
      <p style="color:${INK.muted};font-size:11px;margin:0 0 .25rem">budget = (base + k·log(1+Σ inbound trust)) as followers accrue toward the cohort target</p>
      ${lineChart({ id: "trajectory", series: trajectories, xLabel: "day", yLabel: "budget (tokens/day)" })}
    </section>`
        : ""
    }
    <button data-reset style="font-size:12px">Reset constants to reference</button>`;
}

/**
 * M7 standing (trust-and-reach §4): if this scenario has reporting cohorts
 * (brigade-stress, diverse-reports), show diversity-weighted mass and the
 * resulting standing per target — always from @runa/core's own math via
 * metrics/standing.ts, computed at reference constants (not slider-wired;
 * the reach/budget sliders above cover the tunable-constant story already).
 */
function standingSection(r: RunResult): string {
  const standing = computeAllStanding(r.population);
  const targets = Object.entries(standing);
  if (targets.length === 0) return "";
  const rows = targets
    .map(([target, s]: [string, StandingResult]) => standingRow(target, s))
    .join("");
  return `
    <section style="margin-bottom:1.25rem">
      <h2 style="font-size:14px;margin:0 0 .25rem">Standing (reports)</h2>
      <p style="color:${INK.muted};font-size:11px;margin:0 0 .5rem">diversity-weighted report mass per target — each reporter cluster contributes only its strongest member's weight</p>
      <table style="border-collapse:collapse;font-size:12px">
        <thead><tr>${["target", "reporters", "clusters", "mass", "p_auto", "standing"].map((h) => `<th style="text-align:left;padding:2px 10px 4px 0;color:${INK.secondary};font-weight:500">${h}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function standingRow(target: string, s: StandingResult): string {
  const cells = [
    esc(target),
    String(s.reporters.length),
    String(s.clusters.length),
    fmt(s.mass),
    fmt(s.pAuto),
    fmt(s.standing),
  ];
  return `<tr>${cells.map((c) => `<td style="padding:2px 10px 2px 0">${c}</td>`).join("")}</tr>`;
}

function tile(value: string, label: string): string {
  return `<div style="border:1px solid #e2e1dd;border-radius:6px;padding:.6rem .9rem;min-width:130px;max-width:220px">
    <div style="font-size:22px;font-weight:600">${esc(value)}</div>
    <div style="font-size:11px;color:${INK.secondary}">${esc(label)}</div>
  </div>`;
}

function cdfSeries(r: RunResult, cohorts: string[]): Series[] {
  return cohorts.map((c) => {
    const values = r.reach.byCohort[c]?.values ?? [];
    const n = values.length || 1;
    const points: [number, number][] = values.map((v, i) => [v, (i + 1) / n]);
    return { name: c, points: points.length ? points : [[0, 1]] };
  });
}

function trajectorySeries(r: RunResult): Series[] {
  return Object.entries(r.newcomerTrajectories).map(([name, t]) => ({
    name,
    points: t.map((p) => [p.day, p.budget] as [number, number]),
  }));
}
