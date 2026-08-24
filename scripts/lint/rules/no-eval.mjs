// SPDX-License-Identifier: Apache-2.0
//
// no-eval (D9) — REPO-WIDE.
//
// pome-twins is capture-only: it must never compute a score, call a judge, or
// correlate locally, anywhere in the OSS surface (cli/src/**, cli/scripts/**,
// packages/**). Evaluation is the product; it lives in pome-cloud. This rule
// FAILS the build when any of that reappears, in three independent ways:
//
//   1. PATH — a known deleted local-eval tree/package/file reappears on disk.
//   2. NAME — any scanned file's basename matches a denied eval-role stem
//      (correlate*/score*/judge*/verdict*, case-insensitive). This catches a
//      reintroduction under a NEW path we don't remember to deny by name — e.g.
//      a fresh `packages/x/src/score.ts` — not just the historical ones.
//   3. IMPORT — any scanned file IMPORTS a forbidden module SPECIFIER: the local
//      correlator/judge/matcher packages, or ANY `@pome-cloud/*` package
//      (pome-twins, the OSS repo, must never depend on cloud-only code). Matches
//      every module-loading form — static `import ... from`, `export ... from`,
//      dynamic `import(...)`, `require(...)`, and bare side-effect
//      `import "..."` — against the SPECIFIER, so prose/comments referencing the
//      old design don't trip it.
//
// ALLOWLIST (D16): file-name-stem violations may be allowlisted by relative path
// below, for a module that is GENUINELY only trace-format TYPES (no eval logic)
// and happens to collide with a denied stem. Target: EMPTY. Path violations and
// import violations are NEVER allowlistable.
//
// LIMITATIONS (honest): this is a static import/path/name scanner. It cannot
// detect local evaluation logic hand-written INLINE inside an innocuously named,
// non-importing file. It does not scan `test/`, `tests/`, `__fixtures__/`, or
// `fixtures/` directories (at any depth) — those legitimately embed forbidden
// strings as fixtures. The NAME rule is a PREFIX match only —
// `basename.startsWith(stem)` — so `scoreRun.ts` / `judgeOutput.ts` trip it but
// an infix like `runScorer.ts` does not; those rely on the import rule instead.
// This narrowness is accepted policy for the OSS gate (allowlist discipline over
// broad heuristics), not an oversight.

import { fileURLToPath } from "node:url";

// Deleted logic trees / packages / entrypoints must stay gone.
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

// Matched against the MODULE SPECIFIER of an import, so a comment mentioning
// "@pome-sh/correlator" or "evaluator/score" is not a violation.
const FORBIDDEN_MODULE_PATTERNS = [
  { re: /@pome-sh\/correlator/, why: "the correlator (no local correlation in the OSS CLI)" },
  { re: /(^|\/)evaluator\//, why: "the deleted local evaluator tree" },
  { re: /(^|\/)matrix\//, why: "the deleted local-scoring matrix tree" },
  { re: /correlateRun/, why: "the deleted local correlation module" },
  { re: /probabilistic/, why: "the deleted local LLM judge" },
  { re: /deterministic/, why: "the deleted deterministic matchers" },
  { re: /twin-plugins/, why: "the deleted deterministic twin matchers" },
  {
    re: /^@pome-cloud\//,
    why: "a pome-cloud-only package — pome-twins (OSS) must never depend on cloud code",
  },
];

const FORBIDDEN_NAME_STEMS = ["correlate", "score", "judge", "verdict"];

// D16 — allowlist by relative path for FILE-NAME-STEM violations only.
const FILE_ALLOWLIST = new Set([]);

// Capture the module SPECIFIER from every module-loading form.
const IMPORT_SPECIFIER_RES = [
  /\bfrom\s*["']([^"']+)["']/g, // static import + `export ... from`
  /(?:^|[^.\w])import\s*\(\s*["']([^"']+)["']/g, // dynamic import()
  /(?:^|[^.\w])require\s*\(\s*["']([^"']+)["']/g, // require()
  /(?:^|[^.\w])import\s+["']([^"']+)["']/g, // bare side-effect `import "x"`
];

// Repo-root `scripts/` is included so eval logic reintroduced as e.g.
// `scripts/local-judge.mjs` (alongside the other build/CI scripts) is walked too.
const SCAN_DIRS = ["cli/src", "cli/scripts", "packages", "scripts"];

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

// test/tests/fixtures dirs legitimately embed forbidden strings as fixtures.
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

// This rule's own source carries the denylist literals it scans for, and so does
// its case table — a table that could not write a forbidden import could not
// prove the rule goes red on one. (The old vitest suite got this for free by
// living under `cli/test/unit/`, a directory the walk skips.) Both are derived
// from `import.meta.url` rather than hard-coded, so renaming cannot leave them
// self-tripping, and the exemption stays scoped to these two files rather than
// to `scripts/**/*.test.mjs` at large.
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

    for (const file of ctx.files({ dirs: SCAN_DIRS, ext: EXTENSIONS, skip: SKIP_DIRS })) {
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
      // De-dupe so a single offending line matched by multiple specifier regexes
      // (or multiple forbidden patterns) is reported once per (specifier, reason).
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
