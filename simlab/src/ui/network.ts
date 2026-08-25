/**
 * Network visualization UI: the ego (viewer-subjective) view and the
 * population overview. All numbers come from viz/ego.ts, which calls the
 * real @runa/core math; this file only encodes them visually.
 *
 * Encodings (per the dataviz method + PGP web-of-trust convention of
 * discrete trust tiers over continuous gradients): node color = feed
 * bucket from the selected viewer, node size = subjective trust (ego) or
 * follower count (overview), edge thickness/opacity = trust contribution.
 * Comparison of constants uses side-by-side small multiples with pinned
 * positions — the regime where juxtaposition beats animation (Archambault
 * et al., TVCG 2011).
 */
import type { Population, SimConstants } from "../population/types.js";
import type { RunResult } from "../run.js";
import { buildEgoModel, radialLayout, resolveViewer, type EgoModel } from "../viz/ego.js";
import { overviewPositions } from "../viz/overview.js";
import { renderNetwork, type VizEdge, type VizNode } from "../viz/render.js";
import { esc, fmt } from "./charts.js";
import { INK, seriesColor } from "./theme.js";

export const BUCKET_COLORS: Record<string, string> = {
  self: "#2a78d6",
  normal: "#1baf7a",
  "below-threshold": "#eda100",
  "no-path": "#9a9994",
};

export type ColorMode = "cohort" | "trust";

export interface NetworkState {
  viewer: string | null;
  overviewOn: boolean;
  colorMode: ColorMode;
}

export interface NetworkHandlers {
  onViewer(id: string): void;
  onOverviewShow(): void;
  onColorMode(mode: ColorMode): void;
}

export interface NetworkView {
  html: string;
  wire(root: HTMLElement, handlers: NetworkHandlers): void;
}

export function buildNetworkView(
  r: RunResult,
  reference: SimConstants,
  compare: boolean,
  state: NetworkState,
): NetworkView {
  const pop = r.population;
  const viewer = resolveViewer(pop, state.viewer);
  const cur = buildEgoModel(pop, viewer, r.constants);
  const ref = compare ? buildEgoModel(pop, viewer, reference) : null;
  const positions = radialLayout(cur); // topology-only: identical for ref

  const html = `
    ${egoSection(r, viewer, cur, ref)}
    ${overviewSection(r, state)}`;

  const wire = (root: HTMLElement, handlers: NetworkHandlers): void => {
    root.querySelector<HTMLSelectElement>("[data-viewer]")?.addEventListener("change", (e) => {
      handlers.onViewer((e.target as HTMLSelectElement).value);
    });
    root.querySelector("[data-overview-show]")?.addEventListener("click", handlers.onOverviewShow);
    root.querySelector<HTMLSelectElement>("[data-colormode]")?.addEventListener("change", (e) => {
      handlers.onColorMode((e.target as HTMLSelectElement).value as ColorMode);
    });

    const tooltip = (id: string): string[] => {
      const n = cur.nodes.find((x) => x.id === id);
      const lines = [id, `${pop.cohortOf[id] ?? "?"} (${pop.kindOf[id] ?? "?"})`];
      if (n && n.ring > 0) {
        lines.push(`trust from ${viewer}: ${fmt(n.trust)}`);
        lines.push(`bucket: ${n.bucket}${n.directOverride ? " (direct-follow override)" : ""}`);
      } else if (!n) {
        lines.push(`no trust path from ${viewer}`);
      }
      lines.push(`${pop.followerCount[id] ?? 0} followers · reach ${r.reach.perAccount[id] ?? 0}`);
      return lines;
    };

    const egoEl = root.querySelector<HTMLElement>("[data-ego]");
    if (egoEl) renderNetwork(egoEl, egoSpec(cur, positions, r.constants, handlers, tooltip));
    const refEl = root.querySelector<HTMLElement>("[data-ego-ref]");
    if (refEl && ref) renderNetwork(refEl, egoSpec(ref, positions, reference, handlers, tooltip));

    const ovEl = root.querySelector<HTMLElement>("[data-overview]");
    if (ovEl) {
      // Yield a frame so the section paints before the (seconds-long on big
      // scenarios, cached after the first run) ForceAtlas2 layout blocks.
      setTimeout(() => {
        if (ovEl.isConnected) renderNetwork(ovEl, overviewSpec(r, cur, state.colorMode, handlers, tooltip));
      }, 0);
    }
  };

  return { html, wire };
}

// ---------------------------------------------------------------- ego view

function egoSection(r: RunResult, viewer: string, cur: EgoModel, ref: EgoModel | null): string {
  const s = cur.stats;
  const tiles = [
    tile(String(s.direct), "direct follows (weight 1.0)"),
    tile(String(s.twoHop), "2-hop reachable"),
    tile(String(s.noPath), "no path (pull-only)"),
    tile(String(s.normal), "surface normally"),
    tile(String(s.belowThreshold), "below threshold"),
    tile(fmt(s.budget), "daily cold budget (tokens)"),
    tile(String(r.reach.perAccount[viewer] ?? 0), "reach as author (viewers)"),
  ].join("");

  const graphs = ref
    ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
        <div>${caption("reference constants")}${container("data-ego-ref")}</div>
        <div>${caption("current constants")}${container("data-ego")}</div>
      </div>
      <p style="font-size:12px;color:${INK.secondary};margin:.5rem 0 0">${esc(deltaLine(ref, cur))}</p>`
    : container("data-ego");

  return `
  <section style="margin-bottom:1.5rem">
    <h2 style="font-size:14px;margin:0 0 .25rem">Network — ego view</h2>
    <p style="color:${INK.muted};font-size:11px;margin:0 0 .5rem">Trust is hop-capped at 2, so this IS the viewer's whole trusted world: ring 1 = direct follows, ring 2 = their follows. Node color = feed bucket from this viewer's vantage, node size = subjective trust. Click any node to refocus.</p>
    <label style="font-size:12px;color:${INK.secondary}">Viewer
      <select data-viewer style="margin-left:.5rem">${viewerOptions(r.population, viewer)}</select>
    </label>
    <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin:.6rem 0">${tiles}</div>
    ${bucketLegend()}
    ${graphs}
  </section>`;
}

function deltaLine(ref: EgoModel, cur: EgoModel): string {
  const refBucket = new Map(ref.nodes.map((n) => [n.id, n.bucket]));
  let gained = 0;
  let lost = 0;
  for (const n of cur.nodes) {
    const before = refBucket.get(n.id);
    if (before === n.bucket || n.ring === 0) continue;
    if (n.bucket === "normal") gained++;
    else if (before === "normal") lost++;
  }
  const budget = cur.stats.budget - ref.stats.budget;
  return (
    `vs reference: ${gained} account${gained === 1 ? "" : "s"} gain normal surfacing, ${lost} lose it; ` +
    `daily budget ${budget >= 0 ? "+" : ""}${fmt(budget)} tokens`
  );
}

function egoSpec(
  model: EgoModel,
  positions: Record<string, { x: number; y: number }>,
  constants: SimConstants,
  handlers: NetworkHandlers,
  tooltip: (id: string) => string[],
): { nodes: VizNode[]; edges: VizEdge[]; onNodeClick: (id: string) => void; tooltip: (id: string) => string[] } {
  const cap = constants.multi_path_sum_cap || 1;
  const nodes: VizNode[] = model.nodes.map((n) => ({
    id: n.id,
    x: positions[n.id]!.x,
    y: positions[n.id]!.y,
    size: n.ring === 0 ? 10 : 3.5 + 6 * Math.min(n.trust, cap) / cap,
    color: BUCKET_COLORS[n.bucket]!,
    label: n.id,
  }));
  const edges: VizEdge[] = model.edges.map((e) => ({
    source: e.source,
    target: e.target,
    size: e.source === model.viewer ? 1.6 : 0.7,
    color: e.source === model.viewer ? "rgba(42,120,214,0.4)" : "rgba(60,60,60,0.12)",
    type: "arrow" as const,
  }));
  return { nodes, edges, onNodeClick: (id) => handlers.onViewer(id), tooltip };
}

// ------------------------------------------------------------- overview

function overviewSection(r: RunResult, state: NetworkState): string {
  if (!state.overviewOn) {
    return `
    <section style="margin-bottom:1.5rem">
      <h2 style="font-size:14px;margin:0 0 .25rem">Population overview</h2>
      <button data-overview-show style="font-size:12px">Render population map</button>
      <span style="font-size:11px;color:${INK.muted};margin-left:.5rem">ForceAtlas2, seeded &amp; fixed-iteration — may take a few seconds on large scenarios</span>
    </section>`;
  }
  const cohorts = r.population.spec.cohorts.map((c) => c.name);
  const legendItems =
    state.colorMode === "cohort"
      ? cohorts.map((c, i) => legendDot(seriesColor(i), c))
      : Object.entries(BUCKET_COLORS).map(([k, col]) => legendDot(col, k === "self" ? "viewer" : k));
  return `
  <section style="margin-bottom:1.5rem">
    <h2 style="font-size:14px;margin:0 0 .25rem">Population overview</h2>
    <p style="color:${INK.muted};font-size:11px;margin:0 0 .5rem">Whole scenario, laid out by topology only (constants never move nodes). Node size = follower count. Click an account to make it the ego viewer.</p>
    <label style="font-size:12px;color:${INK.secondary}">Color by
      <select data-colormode style="margin-left:.5rem">
        <option value="cohort"${state.colorMode === "cohort" ? " selected" : ""}>cohort</option>
        <option value="trust"${state.colorMode === "trust" ? " selected" : ""}>trust lens (from selected viewer)</option>
      </select>
    </label>
    <div style="margin:.4rem 0">${legendItems.join("")}</div>
    ${container("data-overview", 440)}
  </section>`;
}

function overviewSpec(
  r: RunResult,
  ego: EgoModel,
  colorMode: ColorMode,
  handlers: NetworkHandlers,
  tooltip: (id: string) => string[],
): { nodes: VizNode[]; edges: VizEdge[]; onNodeClick: (id: string) => void; tooltip: (id: string) => string[] } {
  const pop = r.population;
  const positions = overviewPositions(pop);
  const cohortIndex = new Map(pop.spec.cohorts.map((c, i) => [c.name, i]));
  const egoBucket = new Map(ego.nodes.map((n) => [n.id, n.bucket]));

  const nodes: VizNode[] = pop.accounts.map((id) => {
    const color =
      colorMode === "cohort"
        ? seriesColor(cohortIndex.get(pop.cohortOf[id] ?? "") ?? 99)
        : BUCKET_COLORS[egoBucket.get(id) ?? "no-path"]!;
    return {
      id,
      x: positions[id]!.x,
      y: positions[id]!.y,
      size: Math.min(9, 2 + 0.6 * Math.sqrt(pop.followerCount[id] ?? 0)),
      color,
      label: id,
    };
  });
  const edges: VizEdge[] = [];
  for (const [follower, followees] of Object.entries(pop.follows)) {
    for (const f of followees) {
      edges.push({ source: follower, target: f, size: 0.3, color: "rgba(60,60,60,0.05)", type: "line" as const });
    }
  }
  return { nodes, edges, onNodeClick: (id) => handlers.onViewer(id), tooltip };
}

// ------------------------------------------------------------- fragments

function viewerOptions(pop: Population, viewer: string): string {
  return pop.spec.cohorts
    .map((c) => {
      const members = pop.accounts.filter((a) => pop.cohortOf[a] === c.name);
      const shown = members.slice(0, 20);
      if (members.includes(viewer) && !shown.includes(viewer)) shown.push(viewer);
      return `<optgroup label="${esc(c.name)}">${shown
        .map((id) => `<option value="${esc(id)}"${id === viewer ? " selected" : ""}>${esc(id)}</option>`)
        .join("")}</optgroup>`;
    })
    .join("");
}

function container(attr: string, height = 340): string {
  return `<div ${attr} style="height:${height}px;border:1px solid #e2e1dd;border-radius:6px;position:relative"></div>`;
}

function caption(text: string): string {
  return `<div style="font-size:11px;color:${INK.secondary};margin-bottom:.25rem">${esc(text)}</div>`;
}

function bucketLegend(): string {
  const items = [
    legendDot(BUCKET_COLORS.self!, "viewer"),
    legendDot(BUCKET_COLORS.normal!, "normal"),
    legendDot(BUCKET_COLORS["below-threshold"]!, "below threshold"),
  ];
  return `<div style="margin:0 0 .4rem">${items.join("")}</div>`;
}

function legendDot(color: string, label: string): string {
  return `<span style="font-size:11px;color:${INK.secondary};margin-right:12px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:4px;vertical-align:-1px"></span>${esc(label)}</span>`;
}

function tile(value: string, label: string): string {
  return `<div style="border:1px solid #e2e1dd;border-radius:6px;padding:.4rem .7rem;min-width:90px">
    <div style="font-size:18px;font-weight:600">${esc(value)}</div>
    <div style="font-size:10px;color:${INK.secondary}">${esc(label)}</div>
  </div>`;
}
