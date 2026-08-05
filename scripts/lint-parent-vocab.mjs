#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1200 — no emitter may write a bare `parent_id`.
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
// gate has to exist in the linter rather than in zod — nothing in the type
// system can stop a new writer from quietly emitting the old spelling and
// having it parse.
//
// So: this scans SOURCE for `parent_id` outside comments and strings, and
// allows it only in the files whose job is to read the legacy spelling.

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const ROOTS = [
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.mjs",
  "cli/src/**/*.ts",
  "examples/*/src/**/*.ts",
];

// Files allowed to name the legacy key, each for a stated reason. A new entry
// here should be a deliberate decision, not a way to quiet the gate.
const ALLOWED = new Map([
  [
    "packages/wire/src/recorder-events.ts",
    "declares `parent_id` as the legacy input key and hosts both tolerant readers",
  ],
  [
    "packages/wire/src/otel/span-event.ts",
    "accepts `parent_id` as a legacy input key on the OTel arm",
  ],
  [
    "packages/wire/src/otel/legacy-shim.ts",
    "reads raw pre-F-1200 rows straight off disk",
  ],
  [
    "packages/wire/src/otel/fixtures/data.ts",
    "golden corpus — its `legacy:` inputs ARE pre-F-1200 rows",
  ],
  [
    // Not the trace format at all: a Linear issue has a parent issue, and
    // `parent_id` is that SQLite column — in the schema DDL, the seed inserts,
    // the SELECT projections and the cycle check. Scoping the gate by field
    // name catches the whole package as collateral; renaming a twin's domain
    // model to satisfy a trace-vocab gate would be the tail wagging the dog.
    // A trailing `/` makes this a directory prefix, not one file.
    "packages/twin-linear/src/",
    "the Linear twin's own domain model — an issue's parent issue, not an event's parent row",
  ],
]);

// An entry ending in `/` covers everything beneath it.
function allowReason(rel) {
  for (const [key, reason] of ALLOWED) {
    if (key.endsWith("/") ? rel.startsWith(key) : rel === key) return reason;
  }
  return null;
}

// Strip comments only. Strings are NOT stripped: an earlier version removed
// them first, which meant a quoted or computed property key —
// `{ "parent_id": null }`, `{ ["parent_id"]: null }` — emitted the forbidden
// field with the gate still green. A quoted key is the same emission as a bare
// one, so the scan has to see it. (Caught in review on the PR that added this
// gate; `lint-parent-vocab.test.mjs` locks it.)
//
// The trade is that a legitimate string mention in non-allowlisted source now
// trips the gate. That is the right bias for an invariant: a loud false
// positive is answered with a one-line allowlist entry and a stated reason,
// while a silent false negative is how the old vocab comes back.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Bare identifier, or the same name as a quoted string — which in practice is
// either a property key or a reference to the legacy field. Both are emissions.
const BARE_PARENT_ID = /(?<![_\w])parent_id(?![_\w])|['"`]parent_id['"`]/;

const violations = [];
for (const pattern of ROOTS) {
  for (const file of globSync(pattern, { exclude: (p) => p.includes("node_modules") })) {
    const rel = file.split(`${process.cwd()}/`).pop();
    if (allowReason(rel) !== null) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    if (!BARE_PARENT_ID.test(code)) continue;
    // Report the real line numbers, from the unstripped source, for anything
    // that survived the strip.
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const bare = stripComments(line);
        if (BARE_PARENT_ID.test(bare)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
  }
}

if (violations.length > 0) {
  console.error("parent-vocab gate failed (F-1200): a bare `parent_id` in emitter source.\n");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\n`parent_id` meant four different things and is no longer written by anything.\n" +
      "Use `parent_event_id` (the spawning row's `event_id`) or, for a raw SDK\n" +
      "tool-use id that is not a parent edge, `causing_tool_use_id`.\n\n" +
      "The schema still ACCEPTS `parent_id` so stored 0.13.0 rows keep parsing —\n" +
      "which is why this gate exists: zod cannot tell a reader from a writer.",
  );
  process.exit(1);
}

console.log(
  `parent-vocab gate: no bare \`parent_id\` in emitter source ` +
    `(${ALLOWED.size} reader files allowed).`,
);
