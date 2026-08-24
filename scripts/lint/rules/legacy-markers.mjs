// SPDX-License-Identifier: Apache-2.0
//
// The [D]/[P] authoring markers were retired in favor of [code]/[model]; this
// rule fails on any reintroduced legacy form ([D], [P], [D:<twin>], [P:<twin>])
// anywhere in the repo.
//
// Sanctioned exceptions (the ONLY places the legacy spelling may appear):
//   - cli/src/task/parseTask.ts — the parser's legacy-marker detection and
//     its migration-hint error message.
//   - cli/test/unit/parseTask.test.ts — the rejection tests for that detection.
//   - */CHANGELOG.md — historical release notes are records, not current
//     spelling, and are never rewritten.

import { fileURLToPath } from "node:url";

const ALLOWLIST = new Set(["cli/src/task/parseTask.ts", "cli/test/unit/parseTask.test.ts"]);

const EXTENSIONS = [
  ".md",
  ".mdx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".txt",
  ".sh",
];

// `.context` and `.changeset` on top of the shared prune list: generated
// scratch and release-tool state, neither of them authored spelling.
const SKIP_DIRS = ["node_modules", "dist", "build", ".git", "coverage", ".context", ".changeset"];

const LEGACY_MARKER_RE = /\[D\]|\[P\]|\[D:|\[P:/;

// This rule's own source carries the marker forms it denies, and so does its
// case table — a table that could not write a `[D]` could not prove the rule
// goes red on one. Both are derived from `import.meta.url` rather than
// hard-coded, so renaming the file cannot leave it self-tripping, and the
// exemption stays scoped to these two files rather than to `*.test.mjs` at
// large.
const SELF = fileURLToPath(import.meta.url);
const SELF_CASES = SELF.replace(/\.mjs$/, ".test.mjs");

export default {
  name: "legacy-markers",
  describe: "no retired [D]/[P] criterion markers outside the parser's own legacy path",
  check(ctx) {
    const violations = [];
    for (const file of ctx.files({ dirs: ["."], ext: EXTENSIONS, skip: SKIP_DIRS })) {
      const rel = ctx.rel(file);
      if (ALLOWLIST.has(rel) || rel.endsWith("CHANGELOG.md")) continue;
      if (file === SELF || file === SELF_CASES) continue;
      ctx.read(file)
        .split("\n")
        .forEach((line, i) => {
          if (LEGACY_MARKER_RE.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    return {
      violations,
      summary: "no [D]/[P] marker forms outside sanctioned files",
      hint: "Write [code]/[model] instead of [D]/[P].",
    };
  },
};
