import { defineConfig } from "vitest/config";

// Coverage-only config, invoked by `test:coverage` with an explicit --config.
// See the sibling file in packages/twin-github for why coverage cannot live in
// the root config's `projects` entries.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    env: {
      TWIN_AUTH_SECRET: "test-secret-32-chars-minimum-length",
      SLACK_DETERMINISTIC_TS: "1",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/server.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 65,
        statements: 84,
      },
    },
  },
});
