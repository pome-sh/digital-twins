// SPDX-License-Identifier: Apache-2.0
//
// No emitter may write a bare `parent_id`.
//
// `parent_id` used to mean four different things depending on which of five
// writers produced the row: a spawning `event_id` (wrapQuery), a raw SDK
// `tool_use_id` (hooks), a hard null (turn-usage, and every twin HTTP row), and
// a mirror of `parent_span_id` (OtelSpanEvent). Reading a trace meant knowing
// which writer a row came from. The vocab is now `parent_event_id` — always the
// spawning row's `event_id` — plus `causing_tool_use_id` for the one meaning
// that was never a parent edge.
//
// The schema still ACCEPTS `parent_id` as a legacy input key, and must: every
// shipped 0.13.0 emitter writes it, and a row that fails to parse is dropped
// silently on the way into the cloud's tape. That tolerance is exactly why this
// has to be a lint rule rather than a zod refinement — nothing in the type
// system can stop a new writer from quietly emitting the old spelling and having
// it parse.

import { readdirSync } from "node:fs";
import { join } from "node:path";

// Files allowed to name the legacy key, each for a stated reason. A new entry
// here should be a deliberate decision, not a way to quiet the rule.
const ALLOWED = new Map([
  [
    "packages/wire/src/recorder-events.ts",
    "declares `parent_id` as the legacy input key and hosts both tolerant readers",
  ],
  ["packages/wire/src/otel/span-event.ts", "accepts `parent_id` as a legacy input key on the OTel arm"],
  [
    // Not the trace format at all: a Linear issue has a parent issue, and
    // `parent_id` is that SQLite column — in the schema DDL, the seed inserts,
    // the SELECT projections and the cycle check. Scoping by field name catches
    // the whole package as collateral; renaming a twin's domain model to satisfy
    // a trace-vocab rule would be the tail wagging the dog. A trailing `/` makes
    // this a directory prefix, not one file.
    "packages/twin-linear/src/",
    "the Linear twin's own domain model — an issue's parent issue, not an event's parent row",
  ],
]);

/** An entry ending in `/` covers everything beneath it. */
function allowed(rel) {
  for (const key of ALLOWED.keys()) {
    if (key.endsWith("/") ? rel.startsWith(key) : rel === key) return true;
  }
  return false;
}

// Strip comments only. Strings are NOT stripped: an earlier version removed them
// first, which meant a quoted or computed property key — `{ "parent_id": null }`,
// `{ ["parent_id"]: null }` — emitted the forbidden field with the gate still
// green. A quoted key is the same emission as a bare one, so the scan has to see
// it.
//
// The trade is that a legitimate string mention in non-allowlisted source now
// trips the rule. That is the right bias for an invariant: a loud false positive
// is answered with a one-line allowlist entry and a stated reason, while a silent
// false negative is how the old vocab comes back.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Bare identifier, or the same name as a quoted string — which in practice is
// either a property key or a reference to the legacy field. Both are emissions.
const BARE_PARENT_ID = /(?<![_\w])parent_id(?![_\w])|['"`]parent_id['"`]/;

/** `src/` under every package, the cli, and every agent example — and nothing
 *  else. `test/` and `fixtures/` legitimately name the legacy key. */
function emitterDirs(root) {
  const dirs = ["cli/src"];
  for (const [parent, child] of [
    ["packages", "src"],
    ["agent-examples", "src"],
  ]) {
    let entries;
    try {
      entries = readdirSync(join(root, parent), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}/${child}`);
    }
  }
  return dirs;
}

export default {
  name: "parent-vocab",
  describe: "no bare `parent_id` in emitter source",
  check(ctx) {
    const violations = [];
    // `mustExist: false`: the dirs are derived from `packages/*` and
    // `agent-examples/*`, and not every member has a `src/` (packages/shared-types
    // does not). The old `globSync` patterns returned nothing for those too.
    for (const file of ctx.files({ dirs: emitterDirs(ctx.root), ext: [".ts", ".mjs"], mustExist: false })) {
      const rel = ctx.rel(file);
      if (allowed(rel)) continue;
      const text = ctx.read(file);
      if (!BARE_PARENT_ID.test(stripComments(text))) continue;
      // Report real line numbers, from the unstripped source, for anything that
      // survived the strip.
      text.split("\n").forEach((line, i) => {
        if (BARE_PARENT_ID.test(stripComments(line))) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    return {
      violations,
      summary: `${ALLOWED.size} reader file(s)/tree(s) allowed`,
      hint:
        "`parent_id` meant four different things and is no longer written by anything.\n" +
        "Use `parent_event_id` (the spawning row's `event_id`) or, for a raw SDK tool-use id\n" +
        "that is not a parent edge, `causing_tool_use_id`.\n\n" +
        "The schema still ACCEPTS `parent_id` so stored 0.13.0 rows keep parsing — which is why\n" +
        "this rule exists: zod cannot tell a reader from a writer.",
    };
  },
};
