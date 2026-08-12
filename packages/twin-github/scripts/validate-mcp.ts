// SPDX-License-Identifier: Apache-2.0
//
// Real-SDK wire-protocol validation for the new MCP JSON-RPC endpoint.
//
// Boots the twin in-process via @hono/node-server, mints a JWT (same shape
// the existing test fixture mints), connects an `@modelcontextprotocol/sdk`
// `Client` over `StreamableHTTPClientTransport` with a Bearer header, and:
//
//   1. Verifies tools/list returns the catalog `githubToolFixture` derives from
//      the captured upstream listing — count and names, both directions —
//      through real JSON-RPC framing (i.e. through the wire, not from internal
//      state). The size is never written down here: it moved 65 → 36 (F-1376)
//      while a hardcoded `65` in this file went on claiming otherwise.
//   2. Verifies a strict-read tools/call against a seeded PR.
//   3. Calls the same tool via the legacy `/mcp/call` REST shim and diffs
//      the recorder events to prove field-shape parity.
//
// Prints the entire validation output to stdout (captured by CI); it used to
// also write a committed `scripts/validate-mcp.output.txt` snapshot, which
// could silently disagree with a re-run of this same script and did (F-1354).

import { serve } from "@hono/node-server";
import { sign } from "hono/jwt";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGitHubCloneApp } from "../src/twin.js";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { githubToolFixture } from "../src/tools.js";
import type { RecorderEvent } from "@pome-sh/wire";
import type { GitHubStateSeed } from "../src/types.js";

const SID = "validate-mcp-session";
const SECRET = "validate-mcp-secret-32-chars-long-enough";

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

function seedWithPullRequest(): GitHubStateSeed {
  return {
    users: [
      { login: "acme", type: "Organization", name: "Acme" },
      { login: "alice", type: "User", name: "Alice" },
      { login: "pome-agent", type: "User", name: "Pome Agent" }
    ],
    repositories: [
      {
        owner: "acme",
        name: "api",
        description: "Validation fixture for MCP wire-protocol round-trip.",
        default_branch: "main",
        collaborators: ["alice", "pome-agent"],
        labels: [{ name: "bug", color: "d73a4a", description: "Something is not working" }],
        files: [
          { path: "README.md", content: "# Acme API\n" },
          { path: "src/index.ts", content: "export function handler() {\n  return 'ok';\n}\n" },
          {
            path: "src/index.ts",
            content: "export function handler() {\n  return 'new';\n}\n",
            branch: "feature/x"
          }
        ],
        issues: [],
        pull_requests: [
          {
            number: 1,
            title: "MCP wire-fixture PR",
            body: "Strict-read fixture for validate-mcp.",
            head: "feature/x",
            base: "main",
            state: "open",
            author: "alice"
          }
        ]
      }
    ]
  };
}

async function mintToken() {
  return sign(
    {
      sid: SID,
      team_id: "tm_validate",
      login: "pome-agent",
      exp: Math.floor(Date.now() / 1000) + 3600
    },
    SECRET
  );
}

async function main() {
  process.env.TWIN_AUTH_SECRET = SECRET;

  const recorder = createRecorderStore();
  const app = createGitHubCloneApp({
    seed: seedWithPullRequest(),
    recorder,
    runId: "run_validate_mcp"
  });

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
  const mcpUrl = new URL(`/s/${SID}/mcp`, baseUrl);

  record(`Twin booted on ${baseUrl}`);
  record(`MCP endpoint: ${mcpUrl.toString()}`);

  const token = await mintToken();

  try {
    // ── Real SDK client ────────────────────────────────────────────────
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    });
    const client = new Client(
      { name: "validate-mcp", version: "0.0.1" },
      { capabilities: {} }
    );

    await client.connect(transport);
    record("MCP client.connect() OK (initialize handshake completed)");

    // ── tools/list via the wire ────────────────────────────────────────
    section("tools/list (real SDK over the wire)");
    const listResult = await client.listTools();
    record(`Tool count returned: ${listResult.tools.length}`);
    record(`Expected count (githubToolFixture.tools.length): ${githubToolFixture.tools.length}`);
    if (listResult.tools.length !== githubToolFixture.tools.length) {
      throw new Error(`tool count mismatch: got ${listResult.tools.length}, want ${githubToolFixture.tools.length}`);
    }

    const gotNames: string[] = listResult.tools.map((t) => t.name);
    const wantNames: string[] = [...githubToolFixture.toolNames];
    const missing = wantNames.filter((n) => !gotNames.includes(n));
    const extra = gotNames.filter((n) => !wantNames.includes(n));
    if (missing.length || extra.length) {
      throw new Error(`tool name mismatch: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
    }
    record(`All ${gotNames.length} tool names match the tool-table fixture ✓`);
    record("Full tool list (from the wire):");
    record(pretty(listResult.tools));

    // ── tools/call (strict read against the seeded PR) ─────────────────
    // `get_pull_request` was consolidated into `pull_request_read` (F-1376),
    // replacing the seven `get_pull_request*` tools GitHub no longer declares.
    section("tools/call pull_request_read (strict read against seeded fixture)");
    const callResult = await client.callTool({
      name: "pull_request_read",
      arguments: { method: "get", owner: "acme", repo: "api", pullNumber: 1 }
    });
    record("Raw callTool() result:");
    record(pretty(callResult));

    const content = callResult.content as Array<{ type: string; text?: string }>;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") {
      throw new Error(`expected content: [{type:"text", text:...}], got ${pretty(content)}`);
    }
    const parsed = JSON.parse(content[0].text ?? "");
    if (parsed.title !== "MCP wire-fixture PR" || parsed.number !== 1) {
      throw new Error(`unexpected PR payload: ${pretty(parsed)}`);
    }
    record(`✓ MCP content[0].text parses to PR #${parsed.number} title="${parsed.title}" state=${parsed.state}`);

    await client.close();

    // ── Recorder parity: same tool via legacy /mcp/call ────────────────
    section("Recorder parity: legacy /mcp/call vs new /mcp (same tool, same args)");
    const legacyResp = await fetch(`${baseUrl}/s/${SID}/mcp/call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        tool: "pull_request_read",
        arguments: { method: "get", owner: "acme", repo: "api", pullNumber: 1 }
      })
    });
    if (!legacyResp.ok) throw new Error(`legacy /mcp/call failed: ${legacyResp.status} ${await legacyResp.text()}`);

    const events = recorder.events();
    const mcpEvent = events.find((e) => e.path === `/s/${SID}/mcp` && e.method === "POST");
    const legacyEvent = events.find((e) => e.path === `/s/${SID}/mcp/call`);
    if (!mcpEvent) throw new Error("no recorder event for /s/<sid>/mcp");
    if (!legacyEvent) throw new Error("no recorder event for /s/<sid>/mcp/call");

    record("Legacy /mcp/call event:");
    record(pretty(redactVolatile(legacyEvent)));
    record("");
    record("New /mcp (JSON-RPC) event:");
    record(pretty(redactVolatile(mcpEvent)));

    const legacyKeys = Object.keys(legacyEvent).sort();
    const mcpKeys = Object.keys(mcpEvent).sort();
    const keysEqual = legacyKeys.length === mcpKeys.length && legacyKeys.every((k, i) => k === mcpKeys[i]);
    record("");
    record(`Field-key set equal? ${keysEqual ? "YES ✓" : "NO ✗"}`);
    if (!keysEqual) {
      record(`  legacy keys: ${legacyKeys.join(", ")}`);
      record(`  mcp keys:    ${mcpKeys.join(", ")}`);
      throw new Error("field-key parity failed");
    }

    const diff = diffEvents(legacyEvent, mcpEvent);
    record(`Per-field comparison (excluding volatile ts/request_id/correlation_id/latency_ms):`);
    record(pretty(diff));
    // `request_headers` records what the CLIENT sent, so it is a fact about the
    // caller and not about surface parity: the two halves of this comparison are
    // deliberately two different clients. The MCP SDK client sends
    // `accept: application/json, text/event-stream`, an `mcp-protocol-version`
    // header and its own content-length; the legacy shim is a plain fetch and
    // sends none of them. Demanding those match is demanding two different HTTP
    // clients emit identical headers, which is never true — the diff is still
    // printed above so a reader can see exactly what differs.
    const SURFACE_SHAPED = new Set(["path", "request_headers"]);
    const onlyExpectedDiffs = Object.keys(diff).every((k) => SURFACE_SHAPED.has(k));
    if (!onlyExpectedDiffs) {
      throw new Error(
        `unexpected field divergence beyond ${[...SURFACE_SHAPED].join("/")}: ${JSON.stringify(Object.keys(diff))}`
      );
    }
    record("✓ Only `path` (the surface-identifying field) and `request_headers` (the caller's own");
    record("  headers — two different clients) differ between surfaces.");
    record("✓ request_body, response_body, state_mutation, state_delta, status, fidelity, error all identical.");

    section("RESULT");
    record("ALL VALIDATIONS PASSED ✓");
  } finally {
    server.close();
  }
}

function redactVolatile<T extends RecorderEvent>(event: T): Partial<T> {
  const { ts, request_id, correlation_id, latency_ms, ...rest } = event;
  return rest as Partial<T>;
}

function diffEvents(a: RecorderEvent, b: RecorderEvent) {
  const exclude = new Set(["ts", "request_id", "correlation_id", "latency_ms"]);
  const diff: Record<string, { legacy: unknown; mcp: unknown }> = {};
  for (const key of Object.keys(a) as Array<keyof RecorderEvent>) {
    if (exclude.has(key as string)) continue;
    const va = a[key];
    const vb = b[key];
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      diff[key as string] = { legacy: va, mcp: vb };
    }
  }
  return diff;
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
