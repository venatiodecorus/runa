/**
 * Hand-rolled SVG charts (no library). Marks per the dataviz method: 2px
 * lines, thin bars with rounded data-ends and 2px gaps, recessive grid,
 * direct labels at line ends plus a legend, hover tooltip on line charts.
 */
import { GRID, INK, seriesColor } from "./theme.js";

const W = 620;
const H = 220;
const PAD = { l: 44, r: 90, t: 12, b: 28 };

export interface Series {
  name: string;
  points: [number, number][]; // x, y
}

function scale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

function axisTicks(min: number, max: number, n = 4): number[] {
  const span = max - min || 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / n)));
  const err = span / n / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const s = mult * step;
  const out: number[] = [];
  for (let v = Math.ceil(min / s) * s; v <= max + 1e-9; v += s) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Multi-series line chart (used for CDFs and trajectories) with hover layer. */
export function lineChart(opts: {
  id: string;
  series: Series[];
  xLabel: string;
  yLabel: string;
  yMax?: number;
}): string {
  const allX = opts.series.flatMap((s) => s.points.map((p) => p[0]));
  const allY = opts.series.flatMap((s) => s.points.map((p) => p[1]));
  const xd: [number, number] = [Math.min(0, ...allX), Math.max(1, ...allX)];
  const yd: [number, number] = [0, opts.yMax ?? Math.max(1, ...allY) * 1.05];
  const x = scale(xd, [PAD.l, W - PAD.r]);
  const y = scale(yd, [H - PAD.b, PAD.t]);

  const grid = axisTicks(yd[0], yd[1])
    .map((t) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t)}" y2="${y(t)}" stroke="${GRID}" stroke-width="1"/>
      <text x="${PAD.l - 6}" y="${y(t) + 3}" text-anchor="end" font-size="10" fill="${INK.muted}">${t}</text>`)
    .join("");
  const xticks = axisTicks(xd[0], xd[1])
    .map((t) => `<text x="${x(t)}" y="${H - PAD.b + 14}" text-anchor="middle" font-size="10" fill="${INK.muted}">${t}</text>`)
    .join("");

  const paths = opts.series
    .map((s, i) => {
      const d = s.points.map(([px, py], j) => `${j === 0 ? "M" : "L"}${x(px).toFixed(1)},${y(py).toFixed(1)}`).join("");
      const last = s.points.at(-1);
      const label = last
        ? `<text x="${x(last[0]) + 6}" y="${y(last[1]) + 3}" font-size="11" fill="${INK.primary}">${esc(s.name)}</text>`
        : "";
      return `<path d="${d}" fill="none" stroke="${seriesColor(i)}" stroke-width="2"/>${label}`;
    })
    .join("");

  // Hover layer: vertical crosshair + tooltip, wired up by attachLineTooltip.
  return `<svg viewBox="0 0 ${W} ${H}" role="img" data-linechart="${opts.id}"
       data-xd="${xd.join(",")}" data-yd="${yd.join(",")}"
       style="width:100%;max-width:${W}px;display:block">
    ${grid}${xticks}${paths}
    <text x="${(PAD.l + W - PAD.r) / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="${INK.secondary}">${esc(opts.xLabel)}</text>
    <text x="12" y="${(PAD.t + H - PAD.b) / 2}" font-size="10" fill="${INK.secondary}" transform="rotate(-90 12 ${(PAD.t + H - PAD.b) / 2})" text-anchor="middle">${esc(opts.yLabel)}</text>
    <line data-crosshair x1="0" x2="0" y1="${PAD.t}" y2="${H - PAD.b}" stroke="${INK.muted}" stroke-width="1" opacity="0"/>
  </svg>`;
}

/** Wire crosshair + shared tooltip for every line chart under root. */
export function attachLineTooltips(root: HTMLElement, seriesById: Record<string, Series[]>): void {
  const tip = document.createElement("div");
  tip.style.cssText =
    "position:fixed;pointer-events:none;background:#fff;border:1px solid #d5d4d0;border-radius:4px;" +
    `padding:4px 8px;font-size:11px;color:${INK.primary};box-shadow:0 1px 4px rgba(0,0,0,.12);display:none;z-index:10`;
  root.appendChild(tip);

  for (const svg of root.querySelectorAll<SVGSVGElement>("svg[data-linechart]")) {
    const series = seriesById[svg.dataset.linechart!];
    if (!series) continue;
    const [xd0, xd1] = svg.dataset.xd!.split(",").map(Number) as [number, number];
    const cross = svg.querySelector<SVGLineElement>("[data-crosshair]")!;
    svg.addEventListener("mousemove", (ev) => {
      const rect = svg.getBoundingClientRect();
      const fx = ((ev.clientX - rect.left) / rect.width) * W;
      if (fx < PAD.l || fx > W - PAD.r) return;
      const xv = xd0 + ((fx - PAD.l) / (W - PAD.r - PAD.l)) * (xd1 - xd0);
      cross.setAttribute("x1", String(fx));
      cross.setAttribute("x2", String(fx));
      cross.setAttribute("opacity", "0.5");
      const rows = series
        .map((s, i) => {
          const nearest = s.points.reduce((a, b) => (Math.abs(b[0] - xv) < Math.abs(a[0] - xv) ? b : a));
          return `<div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${seriesColor(i)};margin-right:4px"></span>${esc(s.name)}: <strong>${fmt(nearest[1])}</strong> at ${fmt(nearest[0])}</div>`;
        })
        .join("");
      tip.innerHTML = rows;
      tip.style.display = "block";
      tip.style.left = `${ev.clientX + 12}px`;
      tip.style.top = `${ev.clientY + 12}px`;
    });
    svg.addEventListener("mouseleave", () => {
      cross.setAttribute("opacity", "0");
      tip.style.display = "none";
    });
  }
}

/** Small-multiple histogram: one per cohort, shared x domain. */
export function histogram(opts: { title: string; colorIndex: number; values: number[]; xMax: number; bins?: number }): string {
  const bins = opts.bins ?? 24;
  const counts = new Array<number>(bins).fill(0);
  const binW = (opts.xMax || 1) / bins;
  for (const v of opts.values) counts[Math.min(bins - 1, Math.floor(v / binW))]!++;
  const peak = Math.max(1, ...counts);
  const w = 300;
  const h = 110;
  const pad = { l: 8, r: 8, t: 18, b: 16 };
  const bw = (w - pad.l - pad.r) / bins;
  const bars = counts
    .map((c, i) => {
      const bh = ((h - pad.t - pad.b) * c) / peak;
      const x0 = pad.l + i * bw;
      const range = `${Math.round(i * binW)}–${Math.round((i + 1) * binW)}`;
      return `<rect x="${(x0 + 1).toFixed(1)}" y="${(h - pad.b - bh).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${bh.toFixed(1)}"
        rx="2" fill="${seriesColor(opts.colorIndex)}"><title>reach ${range}: ${c} accounts</title></rect>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" style="width:100%;max-width:${w}px">
    <text x="${pad.l}" y="12" font-size="11" fill="${INK.primary}">${esc(opts.title)}</text>
    <line x1="${pad.l}" x2="${w - pad.r}" y1="${h - pad.b}" y2="${h - pad.b}" stroke="${GRID}"/>
    <text x="${pad.l}" y="${h - 3}" font-size="9" fill="${INK.muted}">0</text>
    <text x="${w - pad.r}" y="${h - 3}" font-size="9" fill="${INK.muted}" text-anchor="end">${Math.round(opts.xMax)}</text>
    ${bars}
  </svg>`;
}

export function legend(names: string[]): string {
  return `<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:${INK.secondary}">${names
    .map(
      (n, i) =>
        `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${seriesColor(i)};margin-right:4px;vertical-align:-1px"></span>${esc(n)}</span>`,
    )
    .join("")}</div>`;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
export const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
