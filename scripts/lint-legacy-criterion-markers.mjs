// SPDX-License-Identifier: Apache-2.0
//
// F-778 legacy criterion-marker gate. The [D]/[P] authoring markers were
// retired in favor of [code]/[model]; this gate fails on any reintroduced
// legacy marker form ([D], [P], [D:<twin>], [P:<twin>]) anywhere in the repo.
//
// Sanctioned exceptions (the ONLY places the legacy spelling may appear):
//   - cli/src/scenario/parseScenario.ts — the parser's legacy-marker
//     detection + migration-hint error message.
//   - cli/test/unit/parseScenario.test.ts — the rejection tests for that
//     detection.
//   - */CHANGELOG.md — historical release notes are records, not current
//     spelling, and are never rewritten.
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWLIST = new Set([
  "cli/src/scenario/parseScenario.ts",
  "cli/test/unit/parseScenario.test.ts",
  "scripts/lint-legacy-criterion-markers.mjs",
]);

const SKIP_DIRS = new Set([".git", ".context", "node_modules", "dist", ".changeset"]);
const TEXT_EXT_RE = /\.(md|mdx|ts|tsx|mts|cts|js|mjs|cjs|json|ya?ml|txt|sh)$/;
const LEGACY_MARKER_RE = /\[D\]|\[P\]|\[D:|\[P:/;

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(resolve(dir, entry.name), out);
      continue;
    }
    if (TEXT_EXT_RE.test(entry.name)) out.push(resolve(dir, entry.name));
  }
  return out;
}

const violations = [];
for (const file of await walk(root)) {
  const rel = relative(root, file).replaceAll("\\", "/");
  if (ALLOWLIST.has(rel) || rel.endsWith("CHANGELOG.md")) continue;
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    if (LEGACY_MARKER_RE.test(line)) {
      violations.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error("Legacy criterion markers found — write [code]/[model] instead of [D]/[P]:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("legacy-criterion-marker gate passed — no [D]/[P] marker forms outside sanctioned files.");
