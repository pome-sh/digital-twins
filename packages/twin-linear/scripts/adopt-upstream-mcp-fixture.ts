// SPDX-License-Identifier: Apache-2.0
//
// Derive `fixtures/mcp-tools-list.{raw,meta,canonical}.json` from the upstream
// golden at `fixtures/mcp-tools-list/linear.*`.
//
// ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
//
// twin-linear's fixture was `twin-authored-from-vendor-docs`: the tool NAMES
// came from Linear's published documentation and every schema and description
// was ours. pome-cloud's MCP lane priced that at 435 findings across all 22
// compared tools — every single one diverged — against twin-slack's 0.
//
// It is the same shape retired on twin-github, one step further from the
// vendor: github at least transcribed a table it served, this one was authored
// from prose. And it is the EASIER of the two to fix, because twin-linear's 22
// names are a STRICT SUBSET of the golden's 58 (`twin_only` is 0, measured).
// There is no flag-gated row to carry, so this producer can only SUBTRACT — the
// property twin-slack's has and twin-github's could not.
//
// ── WHAT THIS PRODUCER MAY DO ───────────────────────────────────────────────
//
// Subtract, and nothing else. It re-hashes the golden before reading it and
// copies every surviving name, description, inputSchema and annotation through
// byte for byte. It cannot rename, re-describe, re-shape a schema, or add a tool
// Linear does not serve — which is exactly the set of edits that produced the
// defect fixed on twin-slack.
//
// `DROPPED` is the subtraction and each entry gives its reason. The ruling covers the
// same 36 in pome-cloud's `known-divergences/linear.mcp.yaml` against
// `mcp-tool-upstream-only` — as NINE entries, one per capability family, because
// each family is one absence rather than N independent ones. That yaml is the
// ruling; there is no prose doc beside it the way twin-github and twin-slack have
// (`docs/github-mcp-unmodelled-tools.md`, `docs/slack-mcp-unexposed-tools.md`),
// because nothing here needed an argument longer than the family reason itself.
//
//   npx tsx scripts/adopt-upstream-mcp-fixture.ts            # write
//   npx tsx scripts/adopt-upstream-mcp-fixture.ts --check     # compare only

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveCanonicalMcpToolListing } from "@pome-sh/sdk";
import { LINEAR_IMPLEMENTED_TOOL_NAMES } from "../src/mcp.js";

const PKG_FIXTURES = join(import.meta.dirname, "..", "fixtures");
const UPSTREAM = join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list");
const RAW = "mcp-tools-list.raw.json";
const META = "mcp-tools-list.meta.json";
const CANONICAL = "mcp-tools-list.canonical.json";
const SOURCE_FIXTURE = "fixtures/mcp-tools-list/linear.raw.json";
const PRODUCER =
  "packages/twin-linear/scripts/adopt-upstream-mcp-fixture.ts — re-derive and diff with " +
  "`npm run gate:mcp-fixture -w @pome-sh/twin-linear`";

/**
 * The 36 tools Linear declares under a read+write grant that this twin does not
 * model, and why. the scope ruling, grouped by CAPABILITY: each family is
 * one absence, and modelling any member means building the thing all of them
 * read from.
 *
 * ⚠️ THESE ARE REAL TOOLS, NOT SCOPE ARTIFACTS, and that was measured rather
 * than assumed — see `fixtures/mcp-tools-list/linear.meta.json`'s
 * `configuration.matchesExaminee`: the same endpoint, captured the same day,
 * answered 36 tools under `read` and 58 under `read write`. The question was whether
 * the golden had been captured under too narrow a grant; the capture that
 * answers it holds BOTH scopes, which are the only two `mcp.linear.app` gates
 * tools behind.
 */
const DROPPED: Record<string, string> = {
  ...family(
    ["get_attachment", "create_attachment", "create_attachment_from_upload", "prepare_attachment_upload", "delete_attachment", "extract_images"],
    "out of modeled scope: the twin models no attachments. There is no upload endpoint, no blob store and no file identity behind an issue, so every one of these reads or writes an object that does not exist here.",
  ),
  ...family(
    ["list_agent_skills", "get_agent_skill"],
    "out of modeled scope: Linear's agent-skill registry is a feature of Linear's own agent platform, not of the issue tracker this twin models.",
  ),
  ...family(
    ["list_release_pipelines", "list_releases", "get_release", "save_release", "list_release_notes", "get_release_note", "save_release_note"],
    "out of modeled scope: the twin models no releases, release pipelines or release notes. Nothing in its schema associates an issue with a shipped version.",
  ),
  ...family(
    ["get_diff", "list_diffs", "get_diff_threads", "save_diff_comment", "resolve_diff_thread", "delete_diff_comment", "submit_diff_review", "merge_diff"],
    "out of modeled scope: Linear's code-review surface. The twin models no diffs, no review threads and no merge, and an examinee reviewing code in Linear is exercising a capability that lives in twin-github here.",
  ),
  ...family(
    ["list_milestones", "get_milestone", "save_milestone"],
    "out of modeled scope: project milestones are not modeled. The twin's projects carry issues and no milestone layer between them.",
  ),
  ...family(
    ["list_initiatives", "get_initiative", "save_initiative", "list_initiative_labels", "create_initiative_label"],
    "out of modeled scope: initiatives are the layer ABOVE projects, and the twin's hierarchy stops at project. Modelling one member means adding that layer and everything that hangs off it.",
  ),
  ...family(
    ["get_status_updates", "save_status_update", "delete_status_update"],
    "out of modeled scope: project and initiative status updates are not modeled — the twin has no periodic-update object attached to either.",
  ),
  ...family(
    ["get_workspace"],
    "out of modeled scope: the twin serves ONE implicit workspace and has no workspace object to read. This is also why the initiative and status-update families above have nothing to hang from.",
  ),
  ...family(
    ["list_project_labels"],
    "out of modeled scope: labels on PROJECTS are a separate taxonomy from labels on issues, which the twin does model (`list_issue_labels`, `create_issue_label`). Adding it is a second label namespace, not a second endpoint on the first.",
  ),
};

function family(names: readonly string[], reason: string): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, reason]));
}

/**
 * Row keys the wire projection does not emit, and therefore keys a fixture may
 * not carry — `canonicalMcpToolSchema` is a `strictObject` over exactly `name`,
 * `description`, `inputSchema`, `title`, `outputSchema` and `annotations`.
 *
 * Linear puts `_meta` on ALL 58 rows. Dropping it is not a judgement this script
 * is making: `mcp-jsonrpc.ts` emits none of it, so a fixture carrying it would
 * state something the served listing does not — and an examinee can never
 * observe it either way. pome-cloud's lane treats it the same, in
 * `UNOBSERVABLE_KEYS` alongside `icons`, so the drop produces no finding on
 * either side.
 */
const UNSERVED_ROW_KEYS: readonly string[] = ["_meta"];

type ToolRow = { name: string } & Record<string, unknown>;
type ToolsListEnvelope = { jsonrpc: string; id: number | string; result: { tools: ToolRow[] } };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function read(name: string): string {
  return readFileSync(join(PKG_FIXTURES, name), "utf8");
}

const check = process.argv.includes("--check");

const upstreamRawText = readFileSync(join(UPSTREAM, "linear.raw.json"), "utf8");
const upstreamMeta = JSON.parse(readFileSync(join(UPSTREAM, "linear.meta.json"), "utf8")) as Record<
  string,
  unknown
>;

// The golden is hash-locked by its own producer; re-check it here rather than
// trusting the path, because everything below is "Linear's bytes, verbatim" and
// that claim is only worth what the digest is worth.
const upstreamSha = sha256(upstreamRawText);
if (upstreamSha !== upstreamMeta.rawFileSha256) {
  throw new Error(
    `fixtures/mcp-tools-list/linear.raw.json hashes to ${upstreamSha} but its meta declares ` +
      `${String(upstreamMeta.rawFileSha256)}. Re-capture it before projecting from it.`
  );
}

const upstream = JSON.parse(upstreamRawText) as ToolsListEnvelope;
const upstreamNames = new Set(upstream.result.tools.map((tool) => tool.name));
for (const name of Object.keys(DROPPED)) {
  if (!upstreamNames.has(name)) {
    throw new Error(
      `DROPPED names '${name}', which the ${String(upstreamMeta.captureDate)} capture does not ` +
        `carry. Either Linear retired it — delete the entry — or the name is a typo suppressing ` +
        `nothing while the real divergence goes on failing elsewhere.`
    );
  }
}

/** Copy a row through, minus the keys the wire never emits. Nothing else. */
function project(row: ToolRow): ToolRow {
  const out = { ...row };
  for (const key of UNSERVED_ROW_KEYS) delete out[key];
  return out;
}

const tools = upstream.result.tools.filter((tool) => !(tool.name in DROPPED)).map(project);

// The 1:1 with `src/mcp.ts`, in both directions, BEFORE anything is written.
// `loadMcpToolFixture` asserts the same thing at module load, but on the file
// this script already wrote — a failure there is a broken build, here it is a
// refusal.
const served = new Set<string>(tools.map((tool) => tool.name));
const implemented = new Set<string>(LINEAR_IMPLEMENTED_TOOL_NAMES);
const advertisedNotImplemented = [...served].filter((name) => !implemented.has(name)).sort();
const implementedNotAdvertised = [...implemented].filter((name) => !served.has(name)).sort();
if (advertisedNotImplemented.length > 0 || implementedNotAdvertised.length > 0) {
  throw new Error(
    `the projection does not match src/mcp.ts. Advertised with no handler: ` +
      `[${advertisedNotImplemented.join(", ")}]; implemented and not advertised: ` +
      `[${implementedNotAdvertised.join(", ")}]. A tool Linear added belongs in DROPPED with a ` +
      `reason or in src/mcp.ts with a handler — never advertised without one.`
  );
}

const previous = JSON.parse(read(RAW)) as ToolsListEnvelope;
const rawText = JSON.stringify({ jsonrpc: previous.jsonrpc, id: previous.id, result: { tools } });

const meta = JSON.parse(read(META)) as Record<string, unknown>;
meta.substrate = "upstream-capture-projection";
meta.endpoint = upstreamMeta.endpoint;
meta.protocol = upstreamMeta.protocol;
meta.protocolVersion = upstreamMeta.protocolVersion;
meta.captureDate = upstreamMeta.captureDate;
meta.configuration = upstreamMeta.configuration;
delete meta.transcription;
delete meta.source;
meta.projection = {
  sourceFixture: SOURCE_FIXTURE,
  sourceRawFileSha256: upstreamSha,
  sourceCaptureDate: upstreamMeta.captureDate,
  sourceSubstrate: upstreamMeta.substrate,
  producer: PRODUCER,
  dropped: DROPPED,
  // Empty, and that is the strong form: every row this twin serves is the
  // capture's. twin-github's producer needs a `carried` door because two of its
  // tools are feature-flag-gated upstream; nothing here is.
  carried: {},
};
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
  ].filter(([name, derived]) => read(name!) !== derived);
  if (drift.length > 0) {
    console.error(
      `[adopt-upstream-mcp-fixture] ${drift.map(([name]) => name).join(", ")} differ from the ` +
        `upstream golden minus ${Object.keys(DROPPED).length} unmodelled`
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
      `(${upstream.result.tools.length} upstream − ${Object.keys(DROPPED).length} unmodelled)`
  );
}
