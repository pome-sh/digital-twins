#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1481: a bare `import.meta.main` entry guard is false on Node 24.0.0,
// 24.0.1, 24.0.2 and 24.1.0 — the property landed in 24.2, root `engines`
// allows `>=24`, so on those versions it silently reads `undefined` and a
// guard built on it exits 0 having done nothing. `scripts/probe-twin-endpoints.mjs`
// shipped exactly that shape; `contract/run.mjs` and `scripts/smoke-examples.mjs`
// were already fixed to the sanctioned form (realpath both sides of
// process.argv[1] vs. import.meta.url, throw on a guard miss rather than exit
// 0). This gate is what stops the next file from reintroducing it.
//
// It PARSES rather than greps. A grep for the string "import.meta.main" also
// matches it inside a comment or a string literal (this file's own header
// above, and scripts/capture-mcp-tools-list.test.mjs's assertion that the
// producer's SOURCE TEXT excludes it) — those are not code and must not red.
// Conversely the real thing can be spelled in ways a naive regex misses:
// `import.meta?.main`, split across lines, wrapped in parens, negated
// (`!import.meta.main`), or read via destructuring (`const { main } =
// import.meta`, with or without a rename). Parsing an AST and matching node
// shapes catches all of those and none of the false positives, because a
// string literal or a comment never becomes a MetaProperty node at all.
//
// The file set is DISCOVERED — every `.mjs`/`.js` file under `scripts/` and
// `contract/`, found by walking the directory tree, never a hand-kept list.
// A hand-kept list is the exact shape this milestone (D5) targets: it stops
// covering its subject the day a file is added and nothing notices.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as acorn from "acorn";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const SOURCE_EXTENSIONS = new Set([".mjs", ".js"]);
const SCAN_ROOTS = ["scripts", "contract"];

/**
 * Every `.mjs`/`.js` file under `scripts/` and `contract/`, sorted, found by
 * recursively walking the directory tree rather than by any hand-kept list.
 * A directory that does not exist is simply absent from the result — that is
 * a fact about the repo layout, not a reason to skip silently; the caller
 * asserts non-zero total instead.
 */
export function discoverSourceFiles(repoRoot = REPO_ROOT, roots = SCAN_ROOTS) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(full);
      }
    }
  };
  for (const root of roots) walk(join(repoRoot, root));
  return files.sort();
}

function isImportMetaNode(node) {
  return (
    !!node &&
    node.type === "MetaProperty" &&
    node.meta?.type === "Identifier" &&
    node.meta.name === "import" &&
    node.property?.type === "Identifier" &&
    node.property.name === "meta"
  );
}

/** Does a (possibly computed) property/key node name the literal `main`? */
function namesMain(keyNode, computed) {
  if (!keyNode) return false;
  if (!computed) return keyNode.type === "Identifier" && keyNode.name === "main";
  return keyNode.type === "Literal" && keyNode.value === "main";
}

function isImportMetaMainPattern(pattern) {
  if (!pattern || pattern.type !== "ObjectPattern") return false;
  return pattern.properties.some((prop) => prop.type === "Property" && namesMain(prop.key, prop.computed));
}

/**
 * Walk every node in the AST generically (no per-node-type shape table, so a
 * node type acorn adds later is still visited) and report each real
 * `import.meta.main` reference: a plain or optional-chained member access
 * (`import.meta.main`, `import.meta?.main`, `import.meta["main"]`), or a
 * destructure straight off `import.meta` (`const { main } = import.meta`,
 * `const { main: isMain } = import.meta`).
 */
export function findBareImportMetaMain(source) {
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const hits = [];

  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node.type === "string") {
      if (node.type === "MemberExpression" && isImportMetaNode(node.object) && namesMain(node.property, node.computed)) {
        hits.push(node);
      } else if (node.type === "VariableDeclarator" && isImportMetaNode(node.init) && isImportMetaMainPattern(node.id)) {
        hits.push(node);
      } else if (
        node.type === "AssignmentExpression" &&
        isImportMetaNode(node.right) &&
        isImportMetaMainPattern(node.left)
      ) {
        hits.push(node);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);

  return hits.map((node) => ({
    line: lineOf(source, node.start),
    snippet: source.slice(node.start, Math.min(node.end, node.start + 80)).replace(/\s+/g, " "),
  }));
}

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/**
 * Scan every discovered file and return one finding per real
 * `import.meta.main` reference. A file that fails to PARSE is itself a
 * finding, named as such — a script this gate cannot read is exactly the
 * shape of skip that must not read as a pass.
 */
export function scanRepo(repoRoot = REPO_ROOT) {
  const files = discoverSourceFiles(repoRoot);
  if (files.length === 0) {
    throw new Error(
      `lint:import-meta-main discovered zero files under ${SCAN_ROOTS.join(", ")} — refusing to report a pass having scanned nothing`
    );
  }

  const findings = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const relPath = relative(repoRoot, file);
    let hits;
    try {
      hits = findBareImportMetaMain(source);
    } catch (err) {
      findings.push({ file: relPath, line: null, snippet: `could not parse: ${err.message}` });
      continue;
    }
    for (const hit of hits) findings.push({ file: relPath, line: hit.line, snippet: hit.snippet });
  }
  return { filesScanned: files.length, findings };
}

// Realpath'd on both sides, never bare `import.meta.main` — this file is one
// of the files it would scan, and using the property it forbids to guard its
// own entry would be a fine irony but a broken gate. A guard miss while
// invoked as this file throws rather than exits 0 (F-1481, same shape as
// contract/run.mjs and scripts/smoke-examples.mjs).
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("lint-no-bare-import-meta-main.mjs")) {
  throw new Error(`lint-no-bare-import-meta-main.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  const { filesScanned, findings } = scanRepo();
  if (findings.length > 0) {
    console.error(`Bare \`import.meta.main\` found in ${findings.length} place(s):\n`);
    for (const finding of findings) {
      console.error(`  ${finding.file}${finding.line !== null ? `:${finding.line}` : ""} — ${finding.snippet}`);
    }
    console.error(
      "\nThat property is undefined on Node 24.0.0/24.0.1/24.0.2/24.1.0 (it landed in 24.2), and root " +
        "`engines` allows `>=24` — an entry guard built on it exits 0 having done nothing there. Use " +
        "`realpathSync(process.argv[1])` vs. `realpathSync(fileURLToPath(import.meta.url))` instead " +
        "(see scripts/smoke-examples.mjs or contract/run.mjs)."
    );
    process.exit(1);
  }
  console.log(`No bare \`import.meta.main\` in ${filesScanned} file(s) under ${SCAN_ROOTS.join(", ")}.`);
  process.exit(0);
}
