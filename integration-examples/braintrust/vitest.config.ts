import { defineConfig } from "vitest/config";

// Each example is a STANDALONE npm package with its own lockfile, fetchable on
// its own with `npx degit`. This file is what keeps it standalone inside the
// monorepo too: without a config here, vitest walks up from this directory,
// finds the repo-root vitest.config.ts, and tries to run that file's projects
// from a cwd where none of them exist.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
