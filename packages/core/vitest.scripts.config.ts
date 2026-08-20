import { defineConfig } from "vitest/config";

// Separate config so the vector generator (a side-effectful script driven by
// vitest for TS execution) never runs as part of the normal test suite.
export default defineConfig({
  test: { include: ["scripts/**/*.gen.ts"] },
});
