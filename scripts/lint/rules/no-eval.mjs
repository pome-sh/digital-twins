// SPDX-License-Identifier: Apache-2.0
//
// Repo-wide. This repo is capture-only: it must never compute a score, call a
// judge, or import a scoring path. Denies by import, by path and by file-name stem;
// only stem collisions are allowlistable.

import { fileURLToPath } from "node:url";

// Paths that NAME a scoring capability. Not a list of files that once existed:
// a directory called `score` or `evaluator` is local scoring whatever its files
// happen to import, and the module and file-name arms below cannot see it when
// those files carry innocuous names.
const FORBIDDEN_PATHS = [
  "cli/src/evaluator",
  "cli/src/matrix",
  "cli/src/score",
  "cli/src/runner/correlateRun.ts",
  "cli/src/cli/render.ts",
  "cli/src/cli/matrix.ts",
  "cli/src/cli/matrix-html.ts",
  "cli/src/cli/eval-report.ts",
  "cli/src/recorder/verdictArtifact.ts",
  "packages/correlator",
];

const FORBIDDEN_MODULE_PATTERNS = [
  { re: /@pome-sh\/correlator/, why: "the correlator (no local correlation in the OSS CLI)" },
  { re: /(^|\/)evaluator\//, why: "a local evaluator tree" },
  { re: /(^|\/)matrix\//, why: "a local scoring matrix" },
  { re: /correlateRun/, why: "a local correlation module" },
  { re: /probabilistic/, why: "a local LLM judge" },
  { re: /deterministic/, why: "local deterministic matchers" },
  { re: /twin-plugins/, why: "local deterministic twin matchers" },
  {
    re: /^@pome-cloud\//,
    why: "a pome-cloud-only package — pome-twins (OSS) must never depend on cloud code",
  },
];

const FORBIDDEN_NAME_STEMS = ["correlate", "score", "judge", "verdict"];

const FILE_ALLOWLIST = new Set([]);

const IMPORT_SPECIFIER_RES = [
  /\bfrom\s*["']([^"']+)["']/g, // static import + `export ... from`
  /(?:^|[^.\w])import\s*\(\s*["']([^"']+)["']/g, // dynamic import()
  /(?:^|[^.\w])require\s*\(\s*["']([^"']+)["']/g, // require()
  /(?:^|[^.\w])import\s+["']([^"']+)["']/g, // bare side-effect `import "x"`
];

const SCAN_DIRS = ["cli/src", "cli/scripts", "packages", "scripts"];

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

const SKIP_DIRS = [
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
  "test",
  "tests",
  "__fixtures__",
  "fixtures",
];

const SELF = fileURLToPath(import.meta.url);
const SELF_CASES = SELF.replace(/\.mjs$/, ".test.mjs");

export default {
  name: "no-eval",
  describe: "pome-twins is capture-only — no local scoring, judging or correlation",
  check(ctx) {
    const violations = [];

    for (const rel of FORBIDDEN_PATHS) {
      if (ctx.exists(rel)) {
        violations.push(
          `deleted local-eval path reappeared: ${rel} — evaluation is the product; it lives in pome-cloud, never in pome-twins.`,
        );
      }
    }

    for (const file of ctx.files({ dirs: SCAN_DIRS, ext: EXTENSIONS, skip: SKIP_DIRS, mustExist: false })) {
      if (file === SELF || file === SELF_CASES) continue;
      const rel = ctx.rel(file);

      if (!FILE_ALLOWLIST.has(rel)) {
        const stem = rel.split("/").pop().replace(/\.[^.]+$/, "").toLowerCase();
        const denied = FORBIDDEN_NAME_STEMS.find((candidate) => stem.startsWith(candidate));
        if (denied) {
          violations.push(
            `${rel}: file name matches denied eval-role stem "${denied}*" — evaluation is the product; capture-only modules must not be named like one.`,
          );
          continue;
        }
      }

      const text = ctx.read(file);
      const seen = new Set();
      for (const specRe of IMPORT_SPECIFIER_RES) {
        specRe.lastIndex = 0;
        let match;
        while ((match = specRe.exec(text)) !== null) {
          const specifier = match[1];
          for (const { re, why } of FORBIDDEN_MODULE_PATTERNS) {
            if (!re.test(specifier)) continue;
            const key = `${specifier}|${why}`;
            if (seen.has(key)) continue;
            seen.add(key);
            violations.push(
              `${rel}: imports "${specifier}" → ${why}. Capture is open; evaluation is the product.`,
            );
          }
        }
      }
    }

    return {
      violations,
      summary: "pome-twins is capture-only",
      hint:
        "pome-twins must never score, judge, or correlate locally. A verdict comes only from\n" +
        "pome-cloud (`pome eval`, or a hosted `pome run`).",
    };
  },
};
