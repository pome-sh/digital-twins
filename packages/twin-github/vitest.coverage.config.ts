import { defineConfig } from "vitest/config";

// Coverage-only config, invoked by `test:coverage` with an explicit --config.
// It is separate from the root vitest.config.ts because vitest reads `coverage`
// only at the root level of whichever config it loaded: a coverage block inside
// a root `projects` entry is dropped silently. It is named
// vitest.coverage.config.ts rather than vitest.config.ts so there is no second
// file that only some invocation paths read.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // The in-process suites drive the app with app.request(), which has no
    // socket peer; the admin gate refuses that unless the process opts in
    // (F-1804). The root vitest.config.ts sets the same variable for every
    // packages/* project, and this config bypasses it, so it is repeated here.
    env: { TWIN_ADMIN_ALLOW_NO_PEER: "1" },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Scope coverage to this package's own src/ only.
      include: ["src/**"],
      thresholds: {
        statements: 90,
        functions: 90,
        lines: 90
      }
    }
  }
});
