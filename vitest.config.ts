import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    setupFiles: ["test/setup.ts"],
    // The per-test limit catches a hang, not a slow host: a busy build host runs the compute-heavy tests
    // (header and index reads, line-start timing) several times slower than an idle one. Calibration (4 cores,
    // 8 suites at once): those took past vitest's 5 s default, from about 1.5 s idle.
    testTimeout: 30_000
  }
});
