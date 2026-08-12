// SPDX-License-Identifier: Apache-2.0
//
// Real-SDK wire-protocol validation for the MCP JSON-RPC endpoint.
//
// Boots the twin in-process via @hono/node-server, mints a JWT, connects an
// `@modelcontextprotocol/sdk` `Client` over `StreamableHTTPClientTransport`
// with a Bearer header, and:
//
//   1. Verifies tools/list returns the 18 Slack tools this twin serves via
//      real JSON-RPC framing.
//   2. Calls slack_search_channels and slack_send_message end-to-end.
//   3. Calls the same tools via the legacy `/mcp/call` REST shim and diffs
//      the recorder events to prove field-shape parity.
//
// Prints the entire validation output to stdout (captured by CI); it used to
// also write a committed `scripts/validate-mcp.output.txt` snapshot, which
// could never reproduce byte-for-byte — it embeds the ephemeral port this run
// bound to — so a CI job that wrote it would rewrite a tracked file mid-job
// (F-1472, same fix as twin-github's F-1354).

import { serve } from "@hono/node-server";
import { sign } from "hono/jwt";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { defaultSeedState } from "../src/seed.js";
import { slackToolFixture } from "../src/tools.js";
import type { RecorderEvent } from "@pome-sh/wire";

const SID = "validate-mcp-session";
const SECRET = "validate-mcp-secret-32-chars-long-enough";

process.env.TWIN_AUTH_SECRET = SECRET;
process.env.SLACK_DETERMINISTIC_TS = "1";

function record(line: string) {
  console.log(line);
}

function section(title: string) {
  record("");
  record(`━━━ ${title} ━━━`);
}

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

async function mintToken() {
  return sign(
    { sid: SID, team_id: "tm_validate", login: "pome-agent", exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET
  );
}

async function main() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  const recorder = createRecorderStore();
  const app = createSlackTwinApp({ db, domain, recorder, runId: "validate-mcp" });
  // Bind to an ephemeral port. serve() invokes the listener once bound.
  const { server, port } = await new Promise<{ server: ReturnType<typeof serve>; port: number }>(
    (resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        resolve({ server: s, port: info.port });
      });
      s.on("error", reject);
    }
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  const mcpUrl = `${baseUrl}/s/${SID}/mcp`;
  const token = await mintToken();
  record(`Server: ${baseUrl}`);
  record(`MCP   : ${mcpUrl}`);

  section("1. JSON-RPC tools/list");
  const client = new Client({ name: "validate-mcp", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  record(`tools/list returned ${tools.tools.length} tools (expected ${slackToolFixture.tools.length})`);
  if (tools.tools.length !== slackToolFixture.tools.length) {
    throw new Error("tools/list length mismatch");
  }
  for (const t of tools.tools) record(`  - ${t.name}: ${t.description}`);

  section("2. tools/call slack_search_channels via JSON-RPC");
  const listRes = await client.callTool({
    name: "slack_search_channels",
    arguments: { query: "general", limit: 10 },
  });
  record(pretty(listRes));

  section("3. tools/call slack_send_message via JSON-RPC");
  const postRes = await client.callTool({
    name: "slack_send_message",
    arguments: { channel_id: "C_GENERAL", message: "via validate-mcp" },
  });
  record(pretty(postRes));

  section("4. Legacy /mcp/call parity check");
  const legacyRes = await fetch(`${baseUrl}/s/${SID}/mcp/call`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool: "slack_search_channels", arguments: { query: "general", limit: 10 } }),
  });
  const legacyBody = await legacyRes.json();
  record(`legacy /mcp/call status=${legacyRes.status}`);
  record(pretty(legacyBody));

  section("5. Recorder events (twin emits one event per tools/call regardless of MCP vs legacy)");
  const events = recorder.events() as RecorderEvent[];
  const toolEvents = events.filter((e) => e.request_body && typeof e.request_body === "object" && "tool" in (e.request_body as object));
  record(`recorder captured ${toolEvents.length} tool events`);
  for (const ev of toolEvents) {
    const body = ev.request_body as { tool: string };
    record(`  - ${ev.path} → tool=${body.tool} status=${ev.status} state_mutation=${ev.state_mutation}`);
  }

  await client.close();
  server.close();
}

main().catch((err) => {
  console.error("validate-mcp FAILED:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
