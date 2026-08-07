#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The gate that keeps the twin modules OTHER RUNTIMES import loadable by them.
//
// pome-cloud's `tools/fidelity-watch` runs under BUN, and several of its suites
// read declarations straight out of a pome-twins checkout — the stripe tool
// table for `isMutatingTool`, github's and slack's 501 envelopes, linear's
// GraphQL schema. Bun implements no `node:sqlite`. `packages/sdk/src/db.ts`
// opens with `import { DatabaseSync } from "node:sqlite"`, and the sdk's ROOT
// barrel re-exports `openTwinDatabase` from it — so one import of
// `@pome-sh/sdk` (rather than a leaf subpath) puts the whole engine's SQLite
// driver on the module-load path of a file whose own dependencies are zod and
// a JSON fixture.
//
// That is exactly what F-1325 did. It moved every twin's tool table onto a
// shared, dependency-free loader — `packages/sdk/src/mcp-tool-fixture.ts`, no
// imports at all — and each twin reached it through the barrel. The twins'
// own suites run on Node, where `node:sqlite` exists, so all of them stayed
// green; pome-cloud's daily fidelity-watch cron went red the next morning with
// `error: No such built-in module: node:sqlite` and one failing assertion, in
// a repo the change had not touched.
//
// The rule is structural, so it cannot drift as twins grow:
//
//   No module in ENTRIES may statically reach a builtin that non-Node runtimes
//   do not implement. ENTRIES is every twin's MCP tool table (found by looking
//   for the F-1325 loader call, so a new twin is covered with no hand edit)
//   plus CROSS_RUNTIME_LEAVES, the named modules pome-cloud imports directly.
//
// A twin's SERVER is deliberately out of scope: `src/index.ts`, `src/db.ts` and
// `src/twin.ts` ARE the SQLite-backed engine, and nothing loads them anywhere
// but Node. This gate is about the declaration leaves, which have no business
// dragging a database driver behind them in any runtime.
//
// Dependency-free and build-free on purpose: it reads TypeScript sources and
// the packages' real `exports` maps, so it runs in CI's always-on block before
// `npm ci`.
//
// Usage: node scripts/check-twin-leaf-portability.mjs [--verbose]

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { buildSpecifierMap, chainFor, reachable } from "./lib/static-import-graph.mjs";

// `process.cwd()`, as the sibling gates do: CI runs every gate from the repo
// root, and it lets the regression suite point the real script at a throwaway
// tree instead of at this repo.
const ROOT = process.cwd();
const VERBOSE = process.argv.includes("--verbose");
const rel = (path) => relative(ROOT, path).split("\\").join("/");

/**
 * Builtins a twin declaration leaf may not reach. Keyed by module specifier,
 * valued by the reason, which is printed on failure — a gate whose message does
 * not say which runtime broke gets "fixed" by adding an exception.
 */
const OFF_LIMITS_BUILTINS = new Map([
  [
    "node:sqlite",
    "bun implements no `node:sqlite`, and pome-cloud's fidelity-watch runs under bun",
  ],
]);

/**
 * Twin modules pome-cloud imports directly, beyond the tool tables found below.
 * Taken from its real import sites (`tools/fidelity-watch`, via `twinModule()`);
 * pome-cloud's own `lint-twin-imports` gate is what keeps that list honest on
 * its side. A listed path that does not exist is a hard failure, not a skip —
 * a stale entry silently covering nothing is how this gate would stop working.
 */
const CROSS_RUNTIME_LEAVES = [
  // `sandboxes/stripe/level2.test.ts` — `isMutatingTool` (also covered as a
  // tool table; listed because it is the import site the regression came from).
  "packages/twin-stripe/src/tools.ts",
  // `lint-twin-namespace.test.ts` — the frozen 501 envelopes.
  "packages/twin-github/src/unsupported-envelope.ts",
  "packages/twin-slack/src/unsupported-envelope.ts",
  "packages/twin-stripe/src/errors.ts",
  // `twin-linear-schema.ts` — `linearGraphQLSchema`.
  "packages/twin-linear/src/graphql/schema.ts",
];

/** The F-1325 loader call. A module that makes it IS a twin's MCP tool table,
 *  whatever the file is named (`tools.ts` on github/slack/stripe, `mcp.ts` on
 *  gmail/linear). */
const TOOL_TABLE_MARKER = "loadMcpToolFixture(";

function walkTs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walkTs(abs, out);
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(abs);
  }
  return out;
}

const packagesDir = join(ROOT, "packages");
const TWIN_DIRS = existsSync(packagesDir)
  ? readdirSync(packagesDir).filter(
      (dir) => dir.startsWith("twin-") && statSync(join(packagesDir, dir)).isDirectory(),
    )
  : [];

if (TWIN_DIRS.length === 0) {
  // A gate that silently passes on an empty tree reads as coverage it does not
  // have — the lesson `lint-parent-vocab.test.mjs` case 2 records.
  console.error(`No packages/twin-* found under ${ROOT}. Run this from the repo root.`);
  process.exit(1);
}

/** Each twin's tool-table module(s), discovered rather than listed. */
const toolTables = [];
const twinsWithNoToolTable = [];
for (const dir of TWIN_DIRS) {
  const found = walkTs(join(packagesDir, dir, "src")).filter((file) =>
    readFileSync(file, "utf8").includes(TOOL_TABLE_MARKER),
  );
  if (found.length === 0) {
    twinsWithNoToolTable.push(dir);
    continue;
  }
  toolTables.push(...found);
}

if (twinsWithNoToolTable.length > 0) {
  // The cheap way to pass a reachability gate is to remove the thing it walks.
  // Every first-party twin derives its tool table from a fixture (F-1325); a
  // twin that no longer calls the loader has either regressed to a hand-written
  // table or renamed the loader, and either way this gate just stopped checking
  // it.
  console.error(
    `\n${twinsWithNoToolTable.length} twin(s) have no module calling \`${TOOL_TABLE_MARKER}\`, so this ` +
      `gate covers no tool table for them:\n`,
  );
  for (const dir of twinsWithNoToolTable) console.error(`  packages/${dir}`);
  console.error(
    "\nEvery twin derives its MCP tool table from a fixture (F-1325). Restore the\n" +
      "loader call, or update TOOL_TABLE_MARKER in this script if the loader was renamed.\n",
  );
  process.exit(1);
}

const missingLeaves = CROSS_RUNTIME_LEAVES.filter((path) => !existsSync(join(ROOT, path)));
if (missingLeaves.length > 0) {
  console.error(
    `\n${missingLeaves.length} entry in CROSS_RUNTIME_LEAVES does not exist, so it covers nothing:\n`,
  );
  for (const path of missingLeaves) console.error(`  ${path}`);
  console.error(
    "\npome-cloud imports these modules by path from a pome-twins checkout. If one moved,\n" +
      "pome-cloud's import is already broken — fix the path here and there together.\n",
  );
  process.exit(1);
}

const ENTRIES = [
  ...new Set([...toolTables, ...CROSS_RUNTIME_LEAVES.map((path) => join(ROOT, path))]),
];

const SPECIFIERS = buildSpecifierMap(ROOT);
const violations = [];

// Walked one entry at a time on purpose: a shared walk would report the chain
// through whichever entry happened to reach the builtin first, and the useful
// output here is "THIS module pome-cloud imports cannot load, by THIS route".
for (const entry of ENTRIES) {
  const { importedBy, external } = reachable([entry], SPECIFIERS);
  for (const edge of external) {
    const reason = OFF_LIMITS_BUILTINS.get(edge.specifier);
    if (!reason) continue;
    violations.push({
      entry,
      specifier: edge.specifier,
      reason,
      chain: [...chainFor(edge.from, importedBy, rel), edge.specifier],
    });
  }
}

if (VERBOSE) {
  console.log(`Entries checked (${ENTRIES.length}):`);
  for (const entry of ENTRIES) console.log(`  ${rel(entry)}`);
}

if (violations.length > 0) {
  console.error(
    `\n${violations.length} twin module(s) that another runtime imports statically reach a builtin ` +
      `that runtime does not have:\n`,
  );
  for (const violation of violations) {
    console.error(`  ${rel(violation.entry)}  — reaches ${violation.specifier}`);
    console.error(`      ${violation.reason}`);
    for (const [index, step] of violation.chain.entries()) {
      console.error(`      ${index === 0 ? "" : "-> "}${step}`);
    }
    console.error("");
  }
  console.error(
    "The usual cause is an import of the `@pome-sh/sdk` ROOT barrel for a value a leaf\n" +
      "subpath already exports: the barrel re-exports `openTwinDatabase`, which is\n" +
      "`node:sqlite`. Import the leaf instead — `@pome-sh/sdk/mcp-tool-fixture` for the\n" +
      "F-1325 tool-table loader, `@pome-sh/sdk/db` for the database types. Types are\n" +
      "free either way: `import type` is erased and this gate ignores it.\n",
  );
  process.exit(1);
}

console.log(
  `check-twin-leaf-portability: OK — ${ENTRIES.length} cross-runtime twin module(s) across ` +
    `${TWIN_DIRS.length} twins, none reaching ${[...OFF_LIMITS_BUILTINS.keys()].join(", ")}.`,
);
