import { defineConfig } from "vitest/config";

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
