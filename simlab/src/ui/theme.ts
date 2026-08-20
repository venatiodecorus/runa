/**
 * Reference dataviz palette (validated: 4 categorical slots pass CVD +
 * normal-vision floors on the light surface; aqua/yellow sit below 3:1
 * contrast, so every series is also direct-labeled — the relief rule).
 * simlab is an internal tool: light theme only for now.
 */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
export const SURFACE = "#fcfcfb";
export const GRID = "#e8e7e3";
export const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#8a8985" };

export function seriesColor(i: number): string {
  // Fixed order, never cycled: past 4 cohorts, fold into "other" (gray).
  return i < SERIES.length ? SERIES[i]! : "#9a9994";
}
