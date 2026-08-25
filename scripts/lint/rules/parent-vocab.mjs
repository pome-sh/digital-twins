// SPDX-License-Identifier: Apache-2.0
//
// `parent_id` is accepted as a legacy input key and must keep being accepted, but
// nothing may write it. Allowlisted files are the tolerant readers themselves.

import { readdirSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = new Map([
  [
    "packages/wire/src/recorder-events.ts",
    "declares `parent_id` as the legacy input key and hosts both tolerant readers",
  ],
  ["packages/wire/src/otel/span-event.ts", "accepts `parent_id` as a legacy input key on the OTel arm"],
  [
    "packages/twin-linear/src/",
    "the Linear twin's own domain model — an issue's parent issue, not an event's parent row",
  ],
]);

function allowed(rel) {
  for (const key of ALLOWED.keys()) {
    if (key.endsWith("/") ? rel.startsWith(key) : rel === key) return true;
  }
  return false;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const BARE_PARENT_ID = /(?<![_\w])parent_id(?![_\w])|['"`]parent_id['"`]/;

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
    for (const file of ctx.files({ dirs: emitterDirs(ctx.root), ext: [".ts", ".mjs"], mustExist: false })) {
      const rel = ctx.rel(file);
      if (allowed(rel)) continue;
      const text = ctx.read(file);
      if (!BARE_PARENT_ID.test(stripComments(text))) continue;
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
