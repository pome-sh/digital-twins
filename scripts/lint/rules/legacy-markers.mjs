// SPDX-License-Identifier: Apache-2.0
//
// The retired [D]/[P] criterion markers must not reappear; [code]/[model] are current.

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

const SKIP_DIRS = ["node_modules", "dist", "build", ".git", "coverage", ".context", ".changeset"];

const LEGACY_MARKER_RE = /\[D\]|\[P\]|\[D:|\[P:/;

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
