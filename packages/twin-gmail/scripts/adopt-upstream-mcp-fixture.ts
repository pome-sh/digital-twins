// SPDX-License-Identifier: Apache-2.0
//
// Derive `fixtures/mcp-tools-list.{raw,meta,canonical}.json` from the upstream
// golden at `fixtures/mcp-tools-list/gmail.*`.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// twin-slack's equivalent script exists because that twin's table had been
// TYPED, and eight of the names did not exist at Slack. This one exists for the
// opposite failure. twin-gmail never invented a tool: `src/mcp.ts` has always
// served an unauthenticated capture of Google's own endpoint verbatim. What it
// could not do was NOTICE the capture ageing. The 2026-07-20 bytes it shipped
// with sat seventeen days behind the vendor, so every divergence pome-cloud's
// lane reported against gmail was one file's capture date and nothing else —
// 34 findings across 11 tools, and the only 2 tools that matched were the 2
// Google had left byte-identical.
//
// So the answer is the same producer shape, minus the one thing slack's has:
// there is NO suppression list here. Google serves 13 tools and this twin
// serves all 13, which makes this script a pure copy — it re-hashes the golden,
// then writes the golden's own bytes through untouched. `raw.json` is not
// re-serialised from a parse; it is `gmail.raw.json`'s bytes, so the two files
// share a sha and "adopted, not edited" is a hash equality rather than a claim.
// The day a Gmail tool has to be withheld, the subtraction gets added here with
// its ruling, the way slack's `UNEXPOSED` carries one.
//
// The provenance is the golden's too — substrate, endpoint, protocol version
// and `captureDate` are copied from `gmail.meta.json` rather than kept by hand.
// That is what makes staleness visible instead of arguable: this fixture cannot
// claim a capture date the capture does not have, and re-adopting after a fresh
// `capture-mcp-tools-list.mjs` run moves the date with the bytes.
//
// ADOPTING THE TEXT ALONE WOULD BE THE DEFECT, NOT THE FIX. The August listing
// declares `Message.bccRecipients`, `Label.messagesTotal`/`messagesUnread`, and
// a `list_labels` that returns ALL labels rather than only user-defined ones.
// Running this script without moving `src/mcp.ts` would make the twin advertise
// three capabilities it does not have — the false-capability shape adoption
// exists to prevent, reached from the other direction. `test/mcp.test.ts` holds
// the handler side to the same listing this writes.
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
 * The editorial half of `meta.json` — the only prose in this file that is not
 * the capture's. Everything else below is copied or computed, so a reviewer can
 * read this array and know it is the whole of what a human decided.
 */
const NOTES = [
  "These bytes are Google's, adopted rather than transcribed. The fixture that shipped before this one was the same endpoint read on 2026-07-20 and was never refreshed, so the twin advertised a seventeen-day-old listing and pome-cloud's mcp_diff reported 34 findings across 11 tools — all of them the vendor moving, none of them a twin defect. Produced by scripts/adopt-upstream-mcp-fixture.ts; `npm run gate:mcp-fixture -w @pome-sh/twin-gmail` re-derives and diffs.",
  "13 tools, which is every tool the capture carries. Unlike twin-slack's adoption there is no suppression list: nothing here is withheld, so raw.json is byte-identical to fixtures/mcp-tools-list/gmail.raw.json and the two shas agree.",
  "Descriptions, schemas and annotations are the capture's verbatim. Three of its claims are behavioural and were implemented in the same change rather than merely served: Message.bccRecipients, Label.messagesTotal/messagesUnread, and a list_labels that answers with ALL labels — the July listing said 'all user-defined labels' and the twin returned exactly those.",
  "list_labels takes no arguments in this listing. The July capture declared pageSize/pageToken and the twin paginated; Google has since removed both, along with nextPageToken from the response, so the twin answers every label in one page. LIMITS.md's MCP page-size row no longer names this tool.",
  "Authenticated tools/call success envelopes were unavailable; the reconstructed shapes live in mcp-tools-call.representative.json and the live unauthenticated error envelope in mcp-tools-call-unauth-error.raw.json.",
  "initialize returned protocolVersion=2025-03-26 (mcp-initialize.raw.json).",
];

type ToolsListEnvelope = {
  jsonrpc: string;
  id: number | string;
  result: { tools: Array<{ name: string } & Record<string, unknown>> };
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const check = process.argv.includes("--check");

const upstreamRawText = readFileSync(join(UPSTREAM, "gmail.raw.json"), "utf8");
const upstreamMeta = JSON.parse(readFileSync(join(UPSTREAM, "gmail.meta.json"), "utf8")) as Record<
  string,
  unknown
>;

// The golden is hash-locked by its own producer; re-check it here rather than
// trusting the path, because everything below is "Google's bytes, verbatim" and
// that claim is only worth what the digest is worth.
if (sha256(upstreamRawText) !== upstreamMeta.rawFileSha256) {
  throw new Error(
    `fixtures/mcp-tools-list/gmail.raw.json hashes to ${sha256(upstreamRawText)} but its meta ` +
      `declares ${String(upstreamMeta.rawFileSha256)}. Re-capture it before adopting it.`
  );
}

const upstream = JSON.parse(upstreamRawText) as ToolsListEnvelope;

// `loadMcpToolFixture` re-hashes `JSON.stringify(<the imported module>)`, since
// a bundled twin cannot read its own fixture off disk. Copying the golden's
// bytes through is only sound while those bytes ARE that serialisation — true
// of a compact vendor response, and false the moment one arrives pretty-printed
// or key-reordered. Check it rather than assume it: the alternative failure is
// a twin that throws at module load in a consumer's process.
if (JSON.stringify(upstream) !== upstreamRawText) {
  throw new Error(
    `fixtures/mcp-tools-list/gmail.raw.json is not the compact serialisation of its own parse, so ` +
      `copying its bytes would produce a fixture whose sha the SDK loader recomputes differently. ` +
      `Re-capture it, or teach this script to re-serialise (and lose byte-identity with the golden).`
  );
}

// The only transform: none. Gmail withholds nothing, so the raw file is the
// golden's own bytes and the two digests are the same number.
const rawText = upstreamRawText;
const tools = upstream.result.tools;

const meta = {
  twin: "gmail",
  // Provenance is the CAPTURE's, copied rather than kept: a fixture that could
  // hold its own captureDate could go stale while still looking current, which
  // is the defect.
  substrate: upstreamMeta.substrate,
  endpoint: upstreamMeta.endpoint,
  method: upstreamMeta.method,
  protocol: upstreamMeta.protocol,
  protocolVersion: upstreamMeta.protocolVersion,
  captureDate: upstreamMeta.captureDate,
  rawFileSha256: sha256(rawText),
  liveToolCount: tools.length,
  liveToolOrder: tools.map((tool) => tool.name),
  configuration: {
    ...(upstreamMeta.configuration as Record<string, unknown>),
    derivation:
      `the upstream golden in full — all ${tools.length} tools, no subtraction. Produced by ` +
      `scripts/adopt-upstream-mcp-fixture.ts from fixtures/mcp-tools-list/gmail.raw.json at ` +
      `rawFileSha256 ${String(upstreamMeta.rawFileSha256)}, whose bytes this file copies verbatim.`,
    matchesExaminee:
      "exactly, for all 13 tools — name, description, inputSchema, outputSchema and annotations are " +
      "Google's own bytes, and an examinee pointing an MCP client at the endpoint above gets this listing.",
  },
  notes: NOTES,
  // Filled in below. `deriveCanonicalMcpToolListing` validates the whole meta
  // before it strips this field out of the bytes it hashes, so it has to parse
  // as a sha before the sha exists — hence a placeholder rather than a blank.
  // Nothing it stands for reaches the canonical file.
  canonicalFileSha256: "0".repeat(64),
  files: { raw: RAW, canonical: CANONICAL },
};

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
        `upstream golden captured ${String(upstreamMeta.captureDate)}`
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
      `captured ${String(upstreamMeta.captureDate)}, nothing withheld`
  );
}
