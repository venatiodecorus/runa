/**
 * Sigma glue: the ONLY file that touches WebGL/DOM for network views. The
 * model/layout inputs are computed elsewhere (viz/ego.ts, viz/overview.ts)
 * and passed in fully resolved — this file adds no math and no randomness.
 * The UI re-renders via innerHTML, so instances are recreated per render;
 * stale ones (disconnected containers) are killed to free WebGL contexts.
 */
import Graph from "graphology";
import Sigma from "sigma";
import { INK } from "../ui/theme.js";

export interface VizNode {
  id: string;
  x: number;
  y: number;
  size: number;
  color: string;
  label: string;
}

export interface VizEdge {
  source: string;
  target: string;
  size: number;
  color: string;
  /** "arrow" (directed, ego view) or "line" (overview, cheaper at 10k+). */
  type: "arrow" | "line";
}

export interface NetworkSpec {
  nodes: VizNode[];
  edges: VizEdge[];
  onNodeClick?: (id: string) => void;
  /** Plain-text lines for the hover tooltip. */
  tooltip?: (id: string) => string[];
}

const live: { container: HTMLElement; sigma: Sigma }[] = [];

export function renderNetwork(container: HTMLElement, spec: NetworkSpec): void {
  for (let i = live.length - 1; i >= 0; i--) {
    const inst = live[i]!;
    if (inst.container === container || !inst.container.isConnected) {
      inst.sigma.kill();
      live.splice(i, 1);
    }
  }

  const graph = new Graph({ type: "directed", allowSelfLoops: false });
  for (const n of spec.nodes) graph.addNode(n.id, { x: n.x, y: n.y, size: n.size, color: n.color, label: n.label });
  for (const e of spec.edges) {
    graph.mergeEdge(e.source, e.target, { size: e.size, color: e.color, type: e.type });
  }

  const sigma = new Sigma(graph, container, {
    labelColor: { color: INK.secondary },
    labelSize: 11,
    minCameraRatio: 0.05,
    maxCameraRatio: 4,
  });
  live.push({ container, sigma });

  if (spec.onNodeClick) sigma.on("clickNode", ({ node }) => spec.onNodeClick!(node));

  if (spec.tooltip) {
    const tip = document.createElement("div");
    tip.style.cssText =
      "position:fixed;pointer-events:none;background:#fff;border:1px solid #d5d4d0;border-radius:4px;" +
      `padding:4px 8px;font-size:11px;color:${INK.primary};box-shadow:0 1px 4px rgba(0,0,0,.12);display:none;z-index:10;white-space:pre`;
    container.appendChild(tip);
    let mouse = { x: 0, y: 0 };
    container.addEventListener("mousemove", (ev) => {
      mouse = { x: ev.clientX, y: ev.clientY };
      if (tip.style.display === "block") place(tip, mouse);
    });
    sigma.on("enterNode", ({ node }) => {
      tip.textContent = spec.tooltip!(node).join("\n");
      tip.style.display = "block";
      place(tip, mouse);
      container.style.cursor = spec.onNodeClick ? "pointer" : "default";
    });
    sigma.on("leaveNode", () => {
      tip.style.display = "none";
      container.style.cursor = "default";
    });
  }
}

function place(tip: HTMLElement, mouse: { x: number; y: number }): void {
  tip.style.left = `${mouse.x + 12}px`;
  tip.style.top = `${mouse.y + 12}px`;
}
