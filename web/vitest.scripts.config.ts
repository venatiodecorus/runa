import { defineConfig } from "vitest/config";

// Separate config so the vector generator (a side-effectful script driven by
// vitest for TS execution) never runs as part of the normal test suite.
// Mirrors packages/core/vitest.scripts.config.ts.
export default defineConfig({
  test: { include: ["scripts/**/*.gen.ts"] },
});
