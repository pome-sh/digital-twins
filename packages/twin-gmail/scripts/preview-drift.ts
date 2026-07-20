#!/usr/bin/env npx tsx
// SPDX-License-Identifier: Apache-2.0
/**
 * Opt-in preview-drift: diff the twin's live MCP tools/list (+ REST surface ids)
 * against frozen Gate 0 fixtures. Never rewrites fixtures.
 *
 * Usage: npm run preview:drift -w @pome-sh/twin-gmail
 * Exit 0 when identical; exit 1 when drift is detected.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sign } from "hono/jwt";
import { createGmailTwinApp, gmailTools } from "../src/index.js";

const root = join(import.meta.dirname, "..");
const fixtures = join(root, "fixtures");
const SECRET = "preview-drift-secret";
const SID = "preview-drift";
const EMAIL = "pome-agent@pome-twin.test";

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return current;
  });
}

async function main(): Promise<void> {
  process.env.TWIN_AUTH_SECRET = SECRET;
  const token = await sign(
    {
      sid: SID,
      team_id: "team_preview",
      gmail_email: EMAIL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SECRET
  );
  const app = createGmailTwinApp({
    seed: {
      primaryMailbox: { email: EMAIL },
      clock: "2026-07-20T00:00:00.000Z",
    },
    runId: "preview-drift",
  });

  const listed = await app.request(`/s/${SID}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (!listed.ok) {
    console.error(`tools/list failed: HTTP ${listed.status}`);
    process.exit(1);
  }
  const live = (await listed.json()) as {
    result: { tools: Array<{ name: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown }> };
  };
  const liveTools = live.result.tools.map((tool) => ({
    name: tool.name,
    annotations: tool.annotations ?? null,
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
  }));

  const canonical = readJson("fixtures/mcp-tools-list.canonical.json") as {
    result: { tools: Array<{ name: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown }> };
  };
  const frozenTools = canonical.result.tools.map((tool) => ({
    name: tool.name,
    annotations: tool.annotations ?? null,
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
  }));

  const liveHash = sha256(stableStringify(liveTools));
  const frozenHash = sha256(stableStringify(frozenTools));
  const liveNames = liveTools.map((tool) => tool.name);
  const frozenNames = frozenTools.map((tool) => tool.name);
  const packageNames = gmailTools.map((tool) => tool.name);

  const restSurface = readJson("fixtures/rest-surface.json") as {
    methods: Array<{ id: string; launchStatus?: string }>;
  };
  const surfaceIds = restSurface.methods.map((method) => method.id).sort();
  const surfaceHash = sha256(JSON.stringify(surfaceIds));

  let drifted = false;
  const report: string[] = [];
  report.push("Gmail twin preview-drift (read-only; fixtures are never rewritten)");
  report.push(`live tools/list names: ${liveNames.join(", ")}`);
  report.push(`frozen canonical names: ${frozenNames.join(", ")}`);
  report.push(`package gmailTools names: ${packageNames.join(", ")}`);
  report.push(`live schema hash:   ${liveHash}`);
  report.push(`frozen schema hash: ${frozenHash}`);
  report.push(`rest-surface method-id hash: ${surfaceHash}`);

  if (JSON.stringify(liveNames) !== JSON.stringify(frozenNames)) {
    drifted = true;
    report.push("DRIFT: tools/list name order/set differs from mcp-tools-list.canonical.json");
  }
  if (JSON.stringify(liveNames) !== JSON.stringify(packageNames)) {
    drifted = true;
    report.push("DRIFT: tools/list names differ from in-process gmailTools");
  }
  if (liveHash !== frozenHash) {
    drifted = true;
    report.push("DRIFT: tools/list schemas/annotations differ from frozen canonical fixture");
    const liveOnly = liveNames.filter((name) => !frozenNames.includes(name));
    const frozenOnly = frozenNames.filter((name) => !liveNames.includes(name));
    if (liveOnly.length) report.push(`  live-only: ${liveOnly.join(", ")}`);
    if (frozenOnly.length) report.push(`  frozen-only: ${frozenOnly.join(", ")}`);
    for (const name of liveNames.filter((n) => frozenNames.includes(n))) {
      const left = liveTools.find((tool) => tool.name === name);
      const right = frozenTools.find((tool) => tool.name === name);
      if (stableStringify(left) !== stableStringify(right)) {
        report.push(`  schema drift on tool: ${name}`);
      }
    }
  }

  // REST surface is fixture-only (no live Google fetch). Report presence of named gaps.
  const gaps = restSurface.methods.filter((method) => method.launchStatus === "named_gap_501").map((m) => m.id);
  report.push(`frozen named_gap_501: ${gaps.join(", ") || "(none)"}`);
  report.push(`fixture path: ${fixtures}`);

  console.log(report.join("\n"));
  if (drifted) {
    console.error("\npreview-drift: DIFFERENCES DETECTED (fixtures left unchanged)");
    process.exit(1);
  }
  console.log("\npreview-drift: OK — twin listing matches frozen fixtures");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
