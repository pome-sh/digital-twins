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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// `process.cwd()`, as `lint-parent-vocab.mjs` and `lint-task-class.mjs` do: CI
// runs every gate from the repo root, and it lets the regression suite point the
// real script at a throwaway tree instead of at this repo.
const ROOT = process.cwd();
const ENTRY = resolve(ROOT, "cli/src/cli/main.ts");
const VERBOSE = process.argv.includes("--verbose");

/** Workspace `@pome-sh/*` specifiers → source file, read from each package's
 *  own `exports` map so a renamed subpath cannot silently stop being checked. */
function buildSpecifierMap() {
  const map = new Map();
  const packagesDir = join(ROOT, "packages");
  if (!existsSync(packagesDir)) return map;
  for (const dir of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.name?.startsWith("@pome-sh/")) continue;
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      // `{ types, default }` conditions or a bare string; either way we want the
      // JS target, then map `dist/src/foo.js` (or `dist/foo.js`) back to source.
      const js = typeof target === "string" ? target : target.default;
      if (typeof js !== "string" || !js.endsWith(".js")) continue;
      const sourceRel = js
        .replace(/^\.\//, "")
        .replace(/^dist\/(?:src\/)?/, "src/")
        .replace(/\.js$/, ".ts");
      const sourcePath = join(packagesDir, dir, sourceRel);
      if (!existsSync(sourcePath)) continue;
      const specifier = subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
      map.set(specifier, sourcePath);
    }
  }
  return map;
}

const SPECIFIERS = buildSpecifierMap();

/**
 * Blank out comments and string/template bodies, keeping newlines so the text
 * stays line-addressable.
 *
 * Load-bearing, not hygiene: `cli/src/cli/init-sdk.ts` embeds the scaffolded
 * agent's SOURCE in a template literal, and that source contains
 * `import { query, tool, withPome } from "@pome-sh/adapter-claude-sdk";`. A
 * regex over raw text reads that as a real edge and reports a package the CLI
 * never imports — and by the same mistake would report a twin root as eager
 * because a scaffold string mentions one. Scaffolds are the one place this repo
 * writes import statements it does not execute, and it writes several.
 */
function stripNonCode(source) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === "`") {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== "`") {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      const stop = Math.min(cursor + 1, source.length);
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}
// Ordinary quoted strings are left alone deliberately: they cannot span lines, and
// every pattern below is anchored to the start of one, so a specifier inside a
// single-line string can never sit where an import statement would.

/**
 * Runtime static import specifiers in one TypeScript source.
 *
 * Type-only edges are EXCLUDED because they are erased before the bundler sees
 * them — both the `import type` / `export type` form and the form where every
 * named binding is individually marked (`import { type A, type B } from …`).
 * Counting either would fail this gate on an edge that emits no code, which is
 * the failure mode that gets a gate deleted rather than fixed.
 *
 * `import()` is EXCLUDED because a dynamic import is the thing this gate wants.
 */
function staticImportSpecifiers(rawSource) {
  const source = stripNonCode(rawSource);
  const found = [];
  const pattern =
    /^[ \t]*(?:import|export)\b([\s\S]*?)from\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[2] ?? match[3];
    const clause = match[1] ?? "";
    if (/^\s*type\b/.test(clause)) continue;
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      const named = braced[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const hasDefaultOrNamespace = /^\s*(?:[A-Za-z_$][\w$]*\s*,|\*)/.test(clause);
      if (named.length > 0 && !hasDefaultOrNamespace && named.every((n) => /^type\s/.test(n))) {
        continue;
      }
    }
    found.push(specifier);
  }
  return found;
}

function resolveSpecifier(specifier, fromFile) {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(fromFile), specifier);
    const candidates = base.endsWith(".js")
      ? [`${base.slice(0, -3)}.ts`]
      : [base, `${base}.ts`, join(base, "index.ts")];
    return candidates.find((candidate) => existsSync(candidate) && candidate.endsWith(".ts")) ?? null;
  }
  // Third-party, node builtins and JSON asset imports carry no twin edges.
  return SPECIFIERS.get(specifier) ?? null;
}

/** Files statically reachable from `entry`, each mapped to the file that first
 *  pulled it in — so a violation can be reported as a chain a human can follow. */
function reachable(entry) {
  const importedBy = new Map([[entry, null]]);
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of staticImportSpecifiers(source)) {
      const target = resolveSpecifier(specifier, file);
      if (target === null || importedBy.has(target)) continue;
      importedBy.set(target, file);
      stack.push(target);
    }
  }
  return importedBy;
}

function chainFor(file, importedBy) {
  const chain = [];
  for (let current = file; current; current = importedBy.get(current)) {
    chain.push(relative(ROOT, current));
  }
  return chain.reverse();
}

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

const importedBy = reachable(ENTRY);
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
    for (const [index, step] of chainFor(violation.file, importedBy).entries()) {
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
