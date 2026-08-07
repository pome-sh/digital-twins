import { defineConfig } from "vitest/config";

// F-1325 — added for the reason F-1128 added twin-gmail's: the `test` script
// was a hand-maintained list of nineteen paths, so a test file that exists and
// passes could sit in this directory never having run. `include` restricts the
// sweep to `.test.ts` and leaves the two `node --test` `.mjs` files to the
// first half of the script, which is what runs them today.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The official-client and agent-path suites drive a real MCP handshake over
    // a listening socket, and checks-contract exports the whole seeded world;
    // on a contended runner those cross vitest's 5s default. Same budget the
    // other four first-party twins already use.
    testTimeout: 30_000,
  },
});
