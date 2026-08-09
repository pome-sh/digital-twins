// SPDX-License-Identifier: Apache-2.0
//
// Regenerate `fixtures/mcp-tools-list.{raw,meta,canonical}.json` from
// `src/tools.ts` (F-1376).
//
// ── WHY THIS EXISTS, WHEN F-1325 SAID THE FIXTURE IS THE TABLE ───────────────
//
// It still is. `src/tools.ts` declares no tool name and no description; the
// fixture does, and the twin serves the fixture's bytes. What this script
// derives is the ONE thing the two files cannot disagree about without the
// suite going red: `inputSchema`, which is `z.toJSONSchema()` of the tool's zod
// validator. Writing 36 of those by hand and hoping they match the projection
// is the failure mode `test/mcp-tool-fixture.test.ts` exists to catch, so the
// bytes are generated and the test still checks them.
//
// It is NOT a capture. Nothing here reads GitHub — the substrate stays
// `twin-code-transcription` and the meta still says, in writing, that this
// listing has never been compared to what `api.githubcopilot.com/mcp/` serves.
// The comparison is pome-cloud's MCP lane, and its verdict on this twin is what
// F-1376 acted on.
//
// Descriptions are carried over per tool name from the previous fixture, so
// re-running this on an unchanged `toolArgumentSchemas` is a no-op. A tool with
// no previous description must be given one in NEW_DESCRIPTIONS below — the
// script refuses rather than inventing one, because a description is what an
// agent reads to decide whether to call the tool at all.
//
//   npx tsx scripts/regenerate-mcp-tool-fixture.ts            # write
//   npx tsx scripts/regenerate-mcp-tool-fixture.ts --check     # compare only

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveCanonicalMcpToolListing } from "@pome-sh/sdk";
import { githubToolInputSchema, toolArgumentSchemas } from "../src/tools.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const RAW = "mcp-tools-list.raw.json";
const META = "mcp-tools-list.meta.json";
const CANONICAL = "mcp-tools-list.canonical.json";

/**
 * Descriptions for tools that had none in the previous fixture. The five
 * F-1376 additions are the vendor's tool names, so each one says which
 * `method` values this twin answers — GitHub's own descriptions enumerate the
 * methods too, and a consolidated tool whose description does not is unusable.
 */
const NEW_DESCRIPTIONS: Record<string, string> = {
  issue_read: "Read an issue. Methods: get, get_comments, get_labels.",
  issue_write: "Create or update an issue. Methods: create, update.",
  list_repository_collaborators: "List repository collaborators.",
  pull_request_read:
    "Read a pull request. Methods: get, get_diff, get_status, get_files, get_commits, get_reviews, get_comments, get_review_comments, get_check_runs.",
  pull_request_review_write: "Create a pull request review. Methods: create.",
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function read(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

const check = process.argv.includes("--check");
const previous = JSON.parse(read(RAW)) as {
  jsonrpc: string;
  id: number;
  result: { tools: Array<{ name: string; description: string }> };
};
const previousDescriptions = new Map(previous.result.tools.map((tool) => [tool.name, tool.description]));

const tools = toolArgumentSchemas.map((declared) => {
  const description = previousDescriptions.get(declared.name) ?? NEW_DESCRIPTIONS[declared.name];
  if (description === undefined) {
    throw new Error(
      `'${declared.name}' is new to src/tools.ts and has no description. Add one to NEW_DESCRIPTIONS in ` +
        "scripts/regenerate-mcp-tool-fixture.ts — this script will not invent the sentence an agent reads " +
        "to decide whether to call the tool."
    );
  }
  return { name: declared.name, description, inputSchema: githubToolInputSchema(declared.schema) };
});

const rawText = JSON.stringify({ jsonrpc: previous.jsonrpc, id: previous.id, result: { tools } });
const meta = JSON.parse(read(META)) as Record<string, unknown>;
meta.rawFileSha256 = sha256(rawText);
meta.liveToolCount = tools.length;
meta.liveToolOrder = tools.map((tool) => tool.name);

const canonicalText = deriveCanonicalMcpToolListing({ raw: JSON.parse(rawText), meta });
meta.canonicalFileSha256 = sha256(canonicalText);
const metaText = `${JSON.stringify(meta, null, 2)}\n`;

if (check) {
  const drift = [
    [RAW, rawText],
    [META, metaText],
    [CANONICAL, canonicalText],
  ].filter(([name, derived]) => read(name) !== derived);
  if (drift.length > 0) {
    console.error(`[mcp-tool-fixture] ${drift.map(([name]) => name).join(", ")} differ from src/tools.ts`);
    process.exit(1);
  }
  console.log(`[mcp-tool-fixture] ${tools.length} tools, all three files match src/tools.ts`);
} else {
  writeFileSync(join(FIXTURES, RAW), rawText);
  writeFileSync(join(FIXTURES, META), metaText);
  writeFileSync(join(FIXTURES, CANONICAL), canonicalText);
  console.log(`[mcp-tool-fixture] wrote ${tools.length} tools`);
}
