/**
 * Headless simlab runner (run with vite-node, which ships with vitest):
 *
 *   npx vite-node cli/run.ts -- scenarios/baseline-10k.json
 *   npx vite-node cli/run.ts -- scenarios/baseline-10k.json --sweep per_hop_decay=0.2:0.6:0.05
 *   npx vite-node cli/run.ts -- scenarios/baseline-10k.json --csv > out.csv
 *
 * Emits one JSON (or CSV row) summary per run to stdout — the scripted-sweep
 * mode behind constant-change PRs.
 */
import { readFileSync } from "node:fs";
import { runScenario, summarize } from "../src/run.js";
import type { ScenarioSpec, SimConstants } from "../src/population/types.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const scenarioPath = args.find((a) => !a.startsWith("--"));
if (!scenarioPath) {
  console.error("usage: vite-node cli/run.ts -- <scenario.json> [--sweep name=start:end:step] [--csv]");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(scenarioPath, "utf8")) as ScenarioSpec;
const csv = args.includes("--csv");
const sweepArg = args.find((a) => a.startsWith("--sweep"))?.split("=").slice(1).join("=");

interface Variant {
  label: string;
  overrides: Partial<SimConstants>;
}
let variants: Variant[] = [{ label: "base", overrides: {} }];
if (sweepArg) {
  const [name, range] = sweepArg.split("=") as [keyof SimConstants, string];
  const [start, end, step] = range!.split(":").map(Number);
  variants = [];
  for (let v = start!; v <= end! + 1e-9; v += step!) {
    const value = Math.round(v * 1e6) / 1e6;
    variants.push({ label: `${name}=${value}`, overrides: { [name]: value } });
  }
}

const rows = variants.map(({ label, overrides }) => ({ label, ...summarize(runScenario(spec, overrides)) }));

if (csv) {
  const cohorts = Object.keys(rows[0]!.reach_by_cohort);
  const header = ["label", "ceiling_hit_rate", ...cohorts.flatMap((c) => [`${c}_mean`, `${c}_median`, `${c}_p90`])];
  console.log(header.join(","));
  for (const r of rows) {
    console.log(
      [
        r.label,
        r.ceiling.hit_rate,
        ...cohorts.flatMap((c) => {
          const s = r.reach_by_cohort[c]!;
          return [s.mean, s.median, s.p90];
        }),
      ].join(","),
    );
  }
} else {
  console.log(JSON.stringify(rows, null, 2));
}
