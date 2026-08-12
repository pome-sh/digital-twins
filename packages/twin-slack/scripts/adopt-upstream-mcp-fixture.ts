// SPDX-License-Identifier: Apache-2.0
//
// Derive `fixtures/mcp-tools-list.{raw,meta,canonical}.json` from the upstream
// golden at `fixtures/mcp-tools-list/slack.*` (F-1330).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// The table is SLACK'S, captured live over OAuth by F-1329, and the twin's job
// is to serve it. So the code is what has to follow, and the only thing this
// script is allowed to do to the vendor's bytes is DROP a tool the heat ruling
// says this twin does not expose.
//
// (This comment used to open by contrasting twin-github, "which derives its
// fixture from `src/tools.ts`, because that twin's table is its own". F-1468
// retired that: twin-github projects GitHub's capture now, through
// `packages/twin-github/scripts/adopt-upstream-mcp-fixture.ts`. The one
// remaining difference is that its producer can also ADD — two tools GitHub
// gates behind `X-MCP-Features` flags cannot appear in a flags-off golden — so
// this script's subtract-only property is the stricter of the two and stays
// worth stating.)
//
// It cannot rename, cannot re-describe, cannot re-shape an inputSchema, and
// cannot add a tool the capture does not carry. That is the whole point:
// F-1330 exists because eleven names were typed into TypeScript from an
// archived reference server and served as though Slack had declared them. A
// producer that can only subtract makes that unrepresentable.
//
// `UNEXPOSED` is the subtraction, and each entry has to give its reason —
// which is also what `docs/slack-mcp-unexposed-tools.md` records, and what
// pome-cloud's `known-divergences/slack.mcp.yaml` registers, so the lane reads
// an absence someone ruled on rather than an absence nobody noticed.
//
//   npx tsx scripts/adopt-upstream-mcp-fixture.ts            # write
//   npx tsx scripts/adopt-upstream-mcp-fixture.ts --check     # compare only

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveCanonicalMcpToolListing } from "@pome-sh/sdk";

const PKG_FIXTURES = join(import.meta.dirname, "..", "fixtures");
const UPSTREAM = join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list");
const RAW = "mcp-tools-list.raw.json";
const META = "mcp-tools-list.meta.json";
const CANONICAL = "mcp-tools-list.canonical.json";

/**
 * Tools Slack declares that this twin deliberately does not serve, and why.
 *
 * One entry today. It is `cold` under `packages/sdk/ENDPOINT-TIERS.md` and was
 * already ruled so before this ticket existed — `fidelity.inventory.json`'s
 * own notes named it a client-UI concept with no Web API analog, which is
 * verbatim the rubric's cold criterion.
 */
const UNEXPOSED: Record<string, string> = {
  slack_send_message_draft:
    "cold (F-1330 gate 1): a draft lives in the Slack client's 'Drafts & Sent' pane and has no " +
    "Web API analog to back it. Registered in known-divergences/slack.mcp.yaml; reasoning in " +
    "docs/slack-mcp-unexposed-tools.md.",
};

type ToolsListEnvelope = {
  jsonrpc: string;
  id: number | string;
  result: { tools: Array<{ name: string } & Record<string, unknown>> };
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const check = process.argv.includes("--check");

const upstreamRawText = readFileSync(join(UPSTREAM, "slack.raw.json"), "utf8");
const upstreamMeta = JSON.parse(readFileSync(join(UPSTREAM, "slack.meta.json"), "utf8")) as Record<
  string,
  unknown
>;

// The golden is hash-locked by its own producer; re-check it here rather than
// trusting the path, because everything below is "Slack's bytes, verbatim" and
// that claim is only worth what the digest is worth.
if (sha256(upstreamRawText) !== upstreamMeta.rawFileSha256) {
  throw new Error(
    `fixtures/mcp-tools-list/slack.raw.json hashes to ${sha256(upstreamRawText)} but its meta ` +
      `declares ${String(upstreamMeta.rawFileSha256)}. Re-capture it before adopting it.`
  );
}

const upstream = JSON.parse(upstreamRawText) as ToolsListEnvelope;
const upstreamNames = new Set(upstream.result.tools.map((tool) => tool.name));
for (const name of Object.keys(UNEXPOSED)) {
  if (!upstreamNames.has(name)) {
    throw new Error(
      `UNEXPOSED names '${name}', which the 2026-08-10 capture does not carry. Either Slack ` +
        `dropped it — in which case delete the entry — or the name is a typo suppressing nothing.`
    );
  }
}

// The only transform: drop the ruled-cold tools. Order, descriptions, schemas
// and annotations are the capture's.
const tools = upstream.result.tools.filter((tool) => !(tool.name in UNEXPOSED));

const rawText = JSON.stringify({ jsonrpc: upstream.jsonrpc, id: upstream.id, result: { tools } });

const meta = JSON.parse(readFileSync(join(PKG_FIXTURES, META), "utf8")) as Record<string, unknown>;
meta.rawFileSha256 = sha256(rawText);
meta.liveToolCount = tools.length;
meta.liveToolOrder = tools.map((tool) => tool.name);

const canonicalText = deriveCanonicalMcpToolListing({ raw: JSON.parse(rawText), meta });
meta.canonicalFileSha256 = sha256(canonicalText);
const metaText = `${JSON.stringify(meta, null, 2)}\n`;

function read(name: string): string {
  return readFileSync(join(PKG_FIXTURES, name), "utf8");
}

if (check) {
  const drift = [
    [RAW, rawText],
    [META, metaText],
    [CANONICAL, canonicalText],
  ].filter(([name, derived]) => read(name!) !== derived);
  if (drift.length > 0) {
    console.error(
      `[adopt-upstream-mcp-fixture] ${drift.map(([name]) => name).join(", ")} differ from the ` +
        `upstream golden minus ${Object.keys(UNEXPOSED).join(", ")}`
    );
    process.exit(1);
  }
  console.log(
    `[adopt-upstream-mcp-fixture] ${tools.length} tools, all three files match the upstream golden`
  );
} else {
  writeFileSync(join(PKG_FIXTURES, RAW), rawText);
  writeFileSync(join(PKG_FIXTURES, META), metaText);
  writeFileSync(join(PKG_FIXTURES, CANONICAL), canonicalText);
  console.log(
    `[adopt-upstream-mcp-fixture] wrote ${tools.length} tools ` +
      `(${upstream.result.tools.length} upstream − ${Object.keys(UNEXPOSED).length} unexposed)`
  );
}
