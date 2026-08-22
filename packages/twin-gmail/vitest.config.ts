import { defineConfig } from "vitest/config";

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
