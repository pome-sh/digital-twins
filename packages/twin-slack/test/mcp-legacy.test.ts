import { beforeEach, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";
import { slackToolFixture } from "../src/tools.js";
import { signTestToken, TEST_SID, withAuth } from "./_authHelper.js";

const base = `/s/${TEST_SID}`;

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return createSlackTwinApp({ db, domain, runId: "mcp-legacy" });
}

describe("legacy MCP routes", () => {
  let token: string;
  beforeEach(async () => {
    token = await signTestToken();
  });

  it("GET /mcp/tools lists 18 tools", async () => {
    const app = freshApp();
    const res = await app.request(`${base}/mcp/tools`, withAuth(token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: Array<{ name: string; input_schema: { additionalProperties: boolean } }>;
    };
    expect(body.tools.map((t) => t.name).sort()).toEqual([...slackToolFixture.toolNames].sort());
    // The legacy surface keeps its snake_case key. It no longer carries
    // `additionalProperties:false`, because F-1330 made the served schemas
    // Slack's and Slack declares none — the legacy shim renames the key, it
    // does not add constraints the vendor's listing has not got.
    for (const tool of body.tools) {
      expect(tool.input_schema.additionalProperties).toBeUndefined();
    }
  });

  it("POST /mcp/call slack_search_channels succeeds", async () => {
    const app = freshApp();
    const res = await app.request(
      `${base}/mcp/call`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "slack_search_channels", arguments: { query: "general", limit: 2 } }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; channels: Array<{ name: string }> };
    expect(body.ok).toBe(true);
    // Two channels read, one kept: `query` is required on Slack's tool and it
    // filters, unlike the `slack_list_channels` this replaced.
    expect(body.channels.map((channel) => channel.name)).toEqual(["general"]);
  });

  it("POST /mcp/call slack_send_message mutates channel", async () => {
    const app = freshApp();
    const res = await app.request(
      `${base}/mcp/call`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: "slack_send_message",
          arguments: { channel_id: "C_GENERAL", message: "via legacy mcp" },
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ts: string };
    expect(body.ok).toBe(true);
    expect(body.ts).toMatch(/^\d+\.\d{6}$/);
  });
});
