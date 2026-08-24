#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case 2 is the reason this table exists: the first version of the rule stripped
// string literals before scanning, so `{ "parent_id": null }` emitted the
// forbidden field with the rule still green. A rule that cannot fail is worse
// than no rule, because it reads as coverage.

import { defineCases } from "../harness.mjs";

const EMITTER = "packages/twin-x/src/emit.ts";

defineCases("parent-vocab", [
  {
    name: "a bare parent_id key is a violation",
    files: { [EMITTER]: `export const row = { parent_id: null };\n` },
    expect: "red",
  },
  {
    name: "a QUOTED parent_id key is a violation (the review finding)",
    files: { [EMITTER]: `export const row = { "parent_id": null };\n` },
    expect: "red",
  },
  {
    name: "a computed parent_id key is a violation",
    files: { [EMITTER]: `export const row = { ["parent_id"]: null };\n` },
    expect: "red",
  },
  {
    name: "a single-quoted key is a violation",
    files: { [EMITTER]: `export const row = { 'parent_id': null };\n` },
    expect: "red",
  },
  {
    name: "a line comment mentioning parent_id is fine",
    files: { [EMITTER]: `// parent_id used to mean four things\nexport const row = {};\n` },
    expect: "green",
  },
  {
    name: "a block comment mentioning parent_id is fine",
    files: { [EMITTER]: `/* parent_id\n * still mentioned here\n */\nexport const row = {};\n` },
    expect: "green",
  },
  {
    name: "the canonical spellings are not false positives",
    files: {
      [EMITTER]:
        `export const row = { parent_event_id: null, parent_span_id: null, ` +
        `parent_tool_use_id: "t", causing_tool_use_id: null };\n`,
    },
    expect: "green",
  },
  {
    name: "an allowlisted reader may name the legacy key",
    files: { "packages/wire/src/recorder-events.ts": `export const s = { parent_id: 1 };\n` },
    expect: "green",
  },
  {
    name: "the allowlist covers a whole directory when it ends in /",
    files: {
      "packages/twin-linear/src/domain/issues.ts": `const sql = "SELECT parent_id FROM issues";\n`,
      "packages/twin-linear/src/db.ts": `const ddl = "parent_id TEXT";\n`,
    },
    expect: "green",
  },
  {
    name: "the report names the exact file and line",
    files: { [EMITTER]: `const a = 1;\nexport const row = { parent_id: null };\n` },
    expect: "red",
    contains: `${EMITTER}:2:`,
  },
  {
    // `test/` is not emitter source: only `src/` is walked, so a fixture naming
    // the legacy key cannot red the rule for the package that owns it.
    name: "a package's test tree is out of scope",
    files: { "packages/twin-x/test/emit.test.ts": `const row = { parent_id: null };\n` },
    expect: "green",
  },
]);
