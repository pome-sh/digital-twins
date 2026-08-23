// SPDX-License-Identifier: Apache-2.0
//
// Derive `fixtures/mcp-tools-list.{raw,meta,canonical}.json` from the upstream
// golden at `fixtures/mcp-tools-list/github.*`.
//
// ── WHAT THIS REPLACED, AND WHY ──────────────────────────────────────────────
//
// `regenerate-mcp-tool-fixture.ts` derived this fixture from `src/tools.ts`:
// the substrate was `twin-code-transcription`, the descriptions were ours, and
// every `inputSchema` was `z.toJSONSchema()` of the twin's own validator. That
// made twin-github the last twin serving a table read off itself — slack and
// gmail have served the vendor's capture for longer — and
// pome-cloud's MCP lane priced the difference at 577 findings across 34 tools,
// against slack's 0.
//
// Almost none of those 577 were a decision anybody made. They were the shape of
// a projection:
//
//   68  `annotations.readOnlyHint` / `idempotentHint` / `title` — GitHub
//       publishes tool annotations, `z.toJSONSchema` has none to emit.
//  181  descriptions — ours, written here, never GitHub's.
//   78  `minLength: 1` / `minimum` — zod projecting `z.string().min(1)`.
//   37  `type: "integer"` where GitHub says `"number"` — `z.number().int()`.
//   34  `additionalProperties: false` on every tool — what `z.object()` (STRIP
//       mode) projects. Measured: strip mode ADVERTISES `false` and ACCEPTS the
//       unknown key at runtime, so that row was a claim the twin never enforced.
//
// Serving GitHub's own rows retires all of it at once, and moves the real
// question to where it belongs: the twin's zod validators, which are the thing
// that actually accepts or refuses an examinee's call. That gap is
// `src/tool-schema-conformance.ts`'s subject, not this file's.
//
// ── WHAT THIS PRODUCER MAY DO ────────────────────────────────────────────────
//
// slack's equivalent can only SUBTRACT, and says so: it re-hashes the golden and
// copies every surviving row through byte for byte, so it cannot rename,
// re-describe, re-shape a schema, or invent a tool. That property is why the
// substrate on its fixture can be Slack's own.
//
// This one subtracts AND carries, and the asymmetry is forced rather than
// convenient. Two tools this twin serves — `create_issue` and
// `create_pull_request_review` — are ones GitHub registers behind feature flags
// (`issues_granular`, `pull_requests_granular`), and the golden is captured with
// NO flags set on purpose, because that is the surface an examinee pointed at
// `api.githubcopilot.com/mcp/` actually gets. So those two rows cannot come from
// the capture and cannot be dropped either: dropping them would stop the twin
// serving a tool GitHub answers for any client that sets `X-MCP-Features`, which
// is the defect reached from the other side.
//
// So `CARRIED` is a second, narrower door, and it is fenced the same way
// `DROPPED` is:
//
//   - a CARRIED name the capture DOES carry fails — the flag ruling has expired
//     and the row should be the capture's;
//   - a DROPPED name the capture does NOT carry fails — a typo suppressing
//     nothing, or GitHub retired the tool;
//   - the resulting name set must equal the twin's implemented set exactly, in
//     both directions, or nothing is written;
//   - every name in either map must give a reason, and the reasons are copied
//     into `meta.projection` so they ship with the file rather than living only
//     in this script.
//
// Neither door can alter a row it passes through. `CARRIED` rows come from the
// PREVIOUS fixture verbatim; every other row is the capture's bytes.
//
//   npx tsx scripts/adopt-upstream-mcp-fixture.ts            # write
//   npx tsx scripts/adopt-upstream-mcp-fixture.ts --check     # compare only

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveCanonicalMcpToolListing } from "@pome-sh/sdk";
import { toolArgumentSchemas } from "../src/tools.js";

const PKG_FIXTURES = join(import.meta.dirname, "..", "fixtures");
const UPSTREAM = join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list");
const RAW = "mcp-tools-list.raw.json";
const META = "mcp-tools-list.meta.json";
const CANONICAL = "mcp-tools-list.canonical.json";
const SOURCE_FIXTURE = "fixtures/mcp-tools-list/github.raw.json";
const PRODUCER =
  "packages/twin-github/scripts/adopt-upstream-mcp-fixture.ts — re-derive and diff with " +
  "`npm run gate:mcp-fixture -w @pome-sh/twin-github`";

/**
 * Tools GitHub's `default` toolset declares that this twin does not model, and
 * why. the scope ruling; each one is also registered in pome-cloud's
 * `known-divergences/github.mcp.yaml` against `mcp-tool-upstream-only`, and the
 * per-tool reasoning is `docs/github-mcp-unmodelled-tools.md`.
 *
 * Eight are whole capabilities the twin has no route for. TWO ARE NOT, and they
 * are written as what they are — a coverage gap somebody should close, not a
 * design decision — because a register that files those two next to `get_teams`
 * would be a scope ruling covering a defect.
 */
const DROPPED: Record<string, string> = {
  add_comment_to_pending_review:
    "out of modeled scope: the twin has no pending-review workflow. `pull_request_review_write` " +
    "creates a review in one call, so there is no pending review for a comment to attach to.",
  assign_copilot_to_issue:
    "out of modeled scope: nothing in this twin models the Copilot coding agent — no assignment, " +
    "no agent session, no resulting branch or pull request.",
  request_copilot_review:
    "out of modeled scope: same absence as `assign_copilot_to_issue`. A review this twin cannot " +
    "produce is not a review an examinee can be graded on requesting.",
  get_teams:
    "out of modeled scope: the twin models no organization teams. Its access-control layer is " +
    "per-repository (src/access-control.ts), with no team membership behind it.",
  get_team_members:
    "out of modeled scope: same absence as `get_teams`. There is no team for this to enumerate.",
  list_issue_types:
    "out of modeled scope: organization-level issue types are not modeled. The twin's issues carry " +
    "labels and state, and no type.",
  list_issue_fields:
    "out of modeled scope: Projects-v2 issue fields are not modeled. The twin has no project board.",
  sub_issue_write:
    "out of modeled scope: the twin models no sub-issue hierarchy — issues have no parent and no " +
    "children, so there is no edge for this tool to write.",
  get_label:
    "COVERAGE GAP, not a scope decision, and it is filed here so it stops being invisible rather " +
    "than because it is acceptable. The twin DOES model labels — it serves list-repository-labels, " +
    "create-repository-label and list-issue-labels (src/routes.ts) — and simply has no single-label " +
    "read. Closing it is a route plus a tool, not a new capability. Tracked in " +
    "docs/github-mcp-unmodelled-tools.md.",
  search_pull_requests:
    "COVERAGE GAP, not a scope decision, on the same terms as `get_label`. The twin serves five " +
    "search tools and GitHub's sixth is `/search/issues` scoped to `is:pr`, which this twin answers " +
    "unscoped as `search_issues`. An examinee that searches for pull requests gets issues here. " +
    "Tracked in docs/github-mcp-unmodelled-tools.md.",
};

/**
 * Rows this twin serves that the capture cannot carry, and why. Copied from the
 * PREVIOUS fixture verbatim — this script writes no schema of its own.
 *
 * Both are registered in pome-cloud's `known-divergences/github.mcp.yaml`
 * (GITHUB-MCP-001/002) against `mcp-tool-twin-only`, with the retirement
 * conditions spelled out there and in `docs/github-mcp-twin-only-tools.md`.
 */
const CARRIED: Record<string, string> = {
  create_issue:
    "GitHub registers this into the `issues` toolset (Default:true) gated on the `issues_granular` " +
    "feature flag, which is in `AllowedFeatureFlags` — so a client sending `X-MCP-Features: " +
    "issues_granular` IS served it. The golden is captured with no flags set, deliberately, because " +
    "that is the default surface. Registered as GITHUB-MCP-001.",
  create_pull_request_review:
    "Same fact, different flag: `pull_requests_granular`, likewise in `AllowedFeatureFlags`. " +
    "Registered as GITHUB-MCP-002.",
};

/**
 * Row keys the wire projection does not emit, and therefore keys a fixture may
 * not carry — `canonicalMcpToolSchema` is a `strictObject` over exactly `name`,
 * `description`, `inputSchema`, `title`, `outputSchema` and `annotations`.
 *
 * GitHub's listing carries `icons` (a base64 PNG per tool, ~2KB each). Dropping
 * it is not a judgement call this script is making: `mcp-jsonrpc.ts` would drop
 * it on the way to the wire anyway, so carrying it would mean the fixture stated
 * something the served listing does not. pome-cloud's lane independently treats
 * `icons` as unobservable (`UNOBSERVABLE_KEYS`), so the drop produces no finding
 * on either side.
 */
const UNSERVED_ROW_KEYS = ["icons"] as const;

type ToolRow = { name: string } & Record<string, unknown>;
type ToolsListEnvelope = { jsonrpc: string; id: number | string; result: { tools: ToolRow[] } };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function read(name: string): string {
  return readFileSync(join(PKG_FIXTURES, name), "utf8");
}

const check = process.argv.includes("--check");

const upstreamRawText = readFileSync(join(UPSTREAM, "github.raw.json"), "utf8");
const upstreamMeta = JSON.parse(readFileSync(join(UPSTREAM, "github.meta.json"), "utf8")) as Record<
  string,
  unknown
>;

// The golden is hash-locked by its own producer; re-check it here rather than
// trusting the path, because everything below is "GitHub's bytes, verbatim" and
// that claim is only worth what the digest is worth.
const upstreamSha = sha256(upstreamRawText);
if (upstreamSha !== upstreamMeta.rawFileSha256) {
  throw new Error(
    `fixtures/mcp-tools-list/github.raw.json hashes to ${upstreamSha} but its meta declares ` +
      `${String(upstreamMeta.rawFileSha256)}. Re-capture it before projecting from it.`
  );
}

const upstream = JSON.parse(upstreamRawText) as ToolsListEnvelope;
const upstreamRows = new Map(upstream.result.tools.map((tool) => [tool.name, tool]));

for (const name of Object.keys(DROPPED)) {
  if (!upstreamRows.has(name)) {
    throw new Error(
      `DROPPED names '${name}', which the ${String(upstreamMeta.captureDate)} capture does not ` +
        `carry. Either GitHub retired it — in which case delete the entry — or the name is a typo ` +
        `suppressing nothing while the real divergence goes on failing elsewhere.`
    );
  }
}
for (const name of Object.keys(CARRIED)) {
  if (upstreamRows.has(name)) {
    throw new Error(
      `CARRIED names '${name}', and the ${String(upstreamMeta.captureDate)} capture DOES carry it. ` +
        `The feature-flag ruling that justified carrying a hand-held row has expired: serve the ` +
        `capture's row instead, and retire the matching known-divergences/github.mcp.yaml entry.`
    );
  }
}

const previous = JSON.parse(read(RAW)) as ToolsListEnvelope;
const previousRows = new Map(previous.result.tools.map((tool) => [tool.name, tool]));
for (const name of Object.keys(CARRIED)) {
  if (!previousRows.has(name)) {
    throw new Error(
      `CARRIED names '${name}' and the previous fixture has no row for it. This script writes no ` +
        `schema of its own, so there is nothing to carry — add the row deliberately, in its own change.`
    );
  }
}

/** Copy a row through, minus the keys the wire never emits. Nothing else. */
function project(row: ToolRow): ToolRow {
  const out = { ...row };
  for (const key of UNSERVED_ROW_KEYS) delete out[key];
  return out;
}

const tools: ToolRow[] = [
  ...upstream.result.tools.filter((tool) => !(tool.name in DROPPED)).map(project),
  ...Object.keys(CARRIED).map((name) => project(previousRows.get(name)!)),
];

// The 1:1 with `src/tools.ts`, in both directions, BEFORE anything is written.
// `loadMcpToolFixture` asserts the same thing at module load, but it does so on
// the file this script already wrote — a failure there is a broken build, and a
// failure here is a refusal.
const served = new Set<string>(tools.map((tool) => tool.name));
const implemented = new Set<string>(toolArgumentSchemas.map((tool) => tool.name));
const advertisedNotImplemented = [...served].filter((name) => !implemented.has(name)).sort();
const implementedNotAdvertised = [...implemented].filter((name) => !served.has(name)).sort();
if (advertisedNotImplemented.length > 0 || implementedNotAdvertised.length > 0) {
  throw new Error(
    `the projection does not match src/tools.ts. Advertised with no handler: ` +
      `[${advertisedNotImplemented.join(", ")}]; implemented and not advertised: ` +
      `[${implementedNotAdvertised.join(", ")}]. A tool GitHub added belongs in DROPPED with a ` +
      `reason or in src/tools.ts with a handler — never advertised without one.`
  );
}

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
  ...(typeof (upstreamMeta.source as { commit?: unknown } | undefined)?.commit === "string"
    ? { sourceCommit: (upstreamMeta.source as { commit: string }).commit }
    : {}),
  producer: PRODUCER,
  dropped: DROPPED,
  carried: CARRIED,
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
        `upstream golden minus ${Object.keys(DROPPED).length} unmodelled plus ` +
        `${Object.keys(CARRIED).length} flag-gated`
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
      `(${upstream.result.tools.length} upstream − ${Object.keys(DROPPED).length} unmodelled + ` +
      `${Object.keys(CARRIED).length} flag-gated)`
  );
}
