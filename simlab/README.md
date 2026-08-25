# simlab

Models how tuning Runa's published constants changes reach over a simulated population (design §16). Every number it produces comes from the **same `@runa/core` trust/budget code the client ships** — simlab never forks the math; that is its entire evidentiary value.

## Run

- Interactive UI: `make simlab` from the repo root (or `npm run dev -w simlab`) — scenario picker, live constant sliders with ≠-reference badges, reach CDF/histograms, newcomer budget trajectory, stat tiles including the "<1% of good-faith accounts ever hit a budget ceiling" design target.
- Network views (in the UI): an **ego view** — the selected viewer's whole trusted world (trust is hop-capped at 2) on deterministic concentric rings, node color = feed bucket from that viewer's vantage, node size = subjective trust, click any node to refocus; when constants deviate from reference it splits into side-by-side small multiples (positions pinned, only colors/sizes change) with a bucket-delta line. A **population overview** (ForceAtlas2, seeded + fixed iterations, cached per scenario) colors by cohort or by "trust lens" from the selected viewer — sybil rings read as separate clusters, and the trust lens shows them no-path gray from any honest vantage. Rendering is sigma.js/graphology (WebGL); all numbers still come from `@runa/core` via `src/viz/ego.ts`, and `src/viz/render.ts` is the only file that touches WebGL.
- Headless: from `simlab/`:
  ```sh
  npx vite-node cli/run.ts -- scenarios/baseline-10k.json            # JSON summary
  npx vite-node cli/run.ts -- scenarios/baseline-10k.json --csv      # CSV row(s)
  npx vite-node cli/run.ts -- scenarios/baseline-10k.json --sweep per_hop_decay=0.2:0.6:0.05
  ```

## Scenario format

JSON in `scenarios/` — see `src/population/types.ts` (`ScenarioSpec`). A scenario is `{name, seed, graphModel, cohorts[], days?, constants?}`; cohort kinds are `honest` (wired by the graph model: `random` | `small-world` | `preferential`), `newcomer` (2 outbound follows, followers accrue toward `targetFollowers` over the horizon), and `sybil-ring` (dense internal follows + `bridges` honest edges in). Everything is seeded — a scenario file fully determines a run; `Math.random`/`Date` are banned in simulation paths.

## Citing a scenario in a constant-change PR

Per `docs/trust-and-reach.md` §6, a change to any published constant must cite the scenario(s) that motivated it: check in the scenario JSON (or name an existing one), include the before/after CLI output (`--sweep` across the value), and state which metric moved and why that's the right trade. `baseline-10k` is the default first citation; `sybil-stress` must not regress (ring reach stays confined regardless of tuning).

Standing/report dynamics (brigade red-teaming) land when M7 defines the standing model.
