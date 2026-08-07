#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The gate that makes "each twin is a lazily-loaded chunk" a fact instead of a
// comment (F-1306).
//
// `cli/tsup.config.ts` and `cli/src/twin/registry.ts` both claim it, and
// CHANGELOG 0.21.0 shipped it as a headline. It was false for three of the five
// twins for five releases: `cli/src/task/{parseTask,taskSchema,githubSeedCompat,
// seed-compiler,seed-compiler-hosted}.ts` top-level-imported the PACKAGE ROOT of
// twin-github/gmail/linear to reach a zod seed schema, and `seed-verifier.ts`
// imported the root to reach `GitHubDomain`. Each of those roots also exports the
// twin's domain, its SQLite schema and its Hono app, so `pome --version` parsed
// ~600 KB of three twins' servers. Nothing failed; the claim just stopped being
// true, quietly, and was found by an audit rather than by CI.
//
// The rule is structural, so it cannot drift as twins grow:
//
//   The CLI's STATIC import graph must not reach any twin's package root
//   (`src/index.ts`), its database module (`src/db.ts`), or anything under
//   `src/domain/`. A twin's domain is reached through `import()` inside
//   `TWIN_REGISTRY`'s own methods — nowhere else.
//
// and the complement is asserted too, because the cheap way to pass a
// laziness gate is to break a command:
//
//   Every twin's `src/checks.ts` MUST stay statically reachable. `pome checks`
//   lists, looks up and digests the declared vocabulary synchronously; deferring
//   it behind `import()` would move the cost, not remove it, and would turn
//   `findCheck`/`twinOf` async for no gain.
//
// Dependency-free and build-free on purpose: it reads TypeScript sources and the
// twins' real `exports` maps, so it runs in CI's always-on block before `npm ci`,
// and it cannot disagree with the bundler about which subpath resolves where.
//
// Usage: node scripts/check-twin-chunk-laziness.mjs [--verbose]

import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// The import lexer and the graph walk are shared with
// `check-twin-leaf-portability.mjs` — two gates asking reachability questions
// about the same graph must not hold two opinions about what a type-only import
// is.
import { buildSpecifierMap, chainFor, reachable } from "./lib/static-import-graph.mjs";

// `process.cwd()`, as `lint-parent-vocab.mjs` and `lint-task-class.mjs` do: CI
// runs every gate from the repo root, and it lets the regression suite point the
// real script at a throwaway tree instead of at this repo.
const ROOT = process.cwd();
const ENTRY = resolve(ROOT, "cli/src/cli/main.ts");
const VERBOSE = process.argv.includes("--verbose");

const SPECIFIERS = buildSpecifierMap(ROOT);

const TWIN_DIRS = existsSync(join(ROOT, "packages"))
  ? readdirSync(join(ROOT, "packages")).filter((dir) => dir.startsWith("twin-"))
  : [];

if (TWIN_DIRS.length === 0) {
  // A gate that silently passes on an empty tree reads as coverage it does not
  // have — the lesson `lint-parent-vocab.test.mjs` case 2 records.
  console.error(`No packages/twin-* found under ${ROOT}. Run this from the repo root.`);
  process.exit(1);
}

if (!existsSync(ENTRY)) {
  console.error(`CLI entry not found: ${relative(ROOT, ENTRY)}. Run this from the repo root.`);
  process.exit(1);
}

/** Reaching any of these means the twin's whole server came along: `index.ts` is
 *  the barrel that exports it, `db.ts` is the SQLite schema, `domain/` is the
 *  state machine. Every other twin module worth deferring hangs off one of them. */
function domainViolation(file) {
  const rel = relative(ROOT, file).split("/").join("/");
  for (const dir of TWIN_DIRS) {
    const prefix = `packages/${dir}/`;
    if (!rel.startsWith(prefix)) continue;
    const inside = rel.slice(prefix.length);
    if (inside === "src/index.ts") return { twin: dir, what: "package root (exports the domain and the Hono app)" };
    if (inside === "src/db.ts") return { twin: dir, what: "SQLite schema" };
    if (inside.startsWith("src/domain/")) return { twin: dir, what: "domain" };
  }
  return null;
}

const { importedBy } = reachable([ENTRY], SPECIFIERS);
const violations = [];
for (const file of importedBy.keys()) {
  const hit = domainViolation(file);
  if (hit) violations.push({ file, ...hit });
}

const missingChecks = TWIN_DIRS.map((dir) => join(ROOT, "packages", dir, "src/checks.ts"))
  .filter((path) => existsSync(path))
  .filter((path) => !importedBy.has(path));

if (VERBOSE) {
  const perPackage = new Map();
  for (const file of importedBy.keys()) {
    const rel = relative(ROOT, file);
    const key = rel.startsWith("packages/") ? rel.split("/").slice(0, 2).join("/") : "cli";
    perPackage.set(key, (perPackage.get(key) ?? 0) + 1);
  }
  console.log(`Statically reachable from ${relative(ROOT, ENTRY)}: ${importedBy.size} files`);
  for (const [key, count] of [...perPackage].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
}

let failed = false;

if (violations.length > 0) {
  failed = true;
  console.error(
    `\n${violations.length} twin module(s) are STATICALLY reachable from the CLI entry — they load on every ` +
      `\`pome\` invocation, including \`pome --version\`:\n`,
  );
  for (const violation of violations) {
    console.error(`  ${relative(ROOT, violation.file)}  — ${violation.twin}'s ${violation.what}`);
    const chain = chainFor(violation.file, importedBy, (path) => relative(ROOT, path));
    for (const [index, step] of chain.entries()) {
      console.error(`      ${index === 0 ? "" : "-> "}${step}`);
    }
    console.error("");
  }
  console.error(
    "Reach a twin's domain through `import()` inside its `TWIN_REGISTRY` entry\n" +
      "(cli/src/twin/registry.ts). If all you need is a seed schema or a default\n" +
      "world, import the twin's `/seed` subpath — it is a zod-only leaf.\n",
  );
}

if (missingChecks.length > 0) {
  failed = true;
  console.error(
    `\n${missingChecks.length} twin's declared check vocabulary is NO LONGER statically reachable:\n`,
  );
  for (const path of missingChecks) console.error(`  ${relative(ROOT, path)}`);
  console.error(
    "\n`pome checks` lists, looks up and digests these synchronously (cli/src/cli/checks.ts).\n" +
      "Deferring them behind `import()` moves the cost instead of removing it and makes\n" +
      "`findCheck`/`twinOf`/`localDigest` async for no gain. Keep the static import and\n" +
      "keep the checks graph free of domain edges instead.\n",
  );
}

if (failed) process.exit(1);

console.log(
  `check-twin-chunk-laziness: OK — ${TWIN_DIRS.length} twins, no domain/db/package-root edge in the ` +
    `CLI's static graph (${importedBy.size} files), every declared check vocabulary still reachable.`,
);
