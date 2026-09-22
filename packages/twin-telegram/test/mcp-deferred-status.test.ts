// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { telegramMcpToolFixture } from "../src/mcp-deferred-status.js";

const packageStatus = join(import.meta.dirname, "..", "fixtures", "mcp-tools-list.status.json");
const sharedStatus = join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list", "telegram.status.json");

describe("Telegram deferred MCP status", () => {
  it("loads the shared deferred status rather than a tool table", () => {
    expect(JSON.parse(readFileSync(packageStatus, "utf8"))).toEqual(JSON.parse(readFileSync(sharedStatus, "utf8")));
    expect(telegramMcpToolFixture).toMatchObject({
      status: { twin: "telegram", captured: false, status: "deferred" },
      tools: [],
      toolNames: [],
    });
  });
});
