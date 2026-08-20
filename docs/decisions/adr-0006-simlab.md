# ADR-0006: simlab — TypeScript simulator sharing the client's core math

**Status:** accepted · 2026-08-20 · amends the module layout in ADR-0003

## Context

Design §16 requires in-repo tooling to model how tuning published constants changes reach over a simulated population, with visuals (interactive) and scripted sweeps (headless). Its evidentiary value depends on running the *same* math the shipping client runs — a reimplementation proves nothing about the real system. Design §13's tuning flags and brigade red-teaming resolve through it.

## Decision

- **Restructure the TS side into npm workspaces** (root `package.json`): `packages/core` — framework-free protocol core (records/canonicalization, trust math, budget math, published constants); `web` — the client app, importing core; `simlab` — the simulator, importing core. Crypto/IndexedDB/UI stay in `web` (simlab doesn't need them). This moves ADR-0003's "framework-free modules inside `web/src`" up to a real shared package; nothing else in ADR-0003 changes.
- **simlab = Vite + TS browser app + a Node CLI entry** in one workspace: the UI offers population/scenario controls, live constant sliders, and charts; the CLI (`node`, same core) runs parameter sweeps emitting JSON/CSV. Scenario definitions are JSON files in `simlab/scenarios/`, checked in and cited in constant-change PRs.
- **Determinism:** seeded PRNG throughout (no `Math.random`); a scenario file + seed fully determines a run. Graph generators (random, small-world/clustered, preferential attachment) and cohort models (newcomers, dense communities, Sybil rings, brigades) live in `simlab/src/population/`.
- **Charts:** keep dependencies minimal; pick at implementation time (hand-rolled SVG or one small chart lib) — needs histogram/CDF, line series, and stat tiles. Not worth pre-deciding.

## Consequences

- The Go server's mirror of the trust math is *not* what simlab exercises — the shared protocol vectors remain the bridge asserting Go ≡ TS ≡ simlab.
- Budget/standing math lands in `packages/core` when simlab needs it (before the server implements M4/M7) — core becomes the reference implementation, server follows it.
- simlab is a dev/governance tool, not a deployable: excluded from release artifacts, but its scenarios are normative inputs to constant changes (design §16).
