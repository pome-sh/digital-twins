import { defineConfig } from "vitest/config";

// F-1128 — added so the `test` script can stop being a hand-maintained file
// list. It was `vitest run <eight explicit paths>`, and `faults.test.ts` had
// already fallen off it: a test file that exists, passes, and never ran in CI.
// Three more files land in this milestone, so the list was one edit away from
// silently not running the vocabulary's own contract suite.
//
// `include` is what makes the sweep safe: `test/gate0-fixtures.test.mjs` is a
// `node --test` file that vitest's default glob claims and then fails on
// ("No test suite found"). Restricting to `.test.ts` leaves it to the
// `node --test` half of the script, which is what runs it today.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The official-client and agent-path suites drive a real MCP handshake over
    // a listening socket; on a contended CI runner the sequential round-trips
    // can cross vitest's 5s default. Same budget the other first-party twins use.
    testTimeout: 30_000,
  },
});
