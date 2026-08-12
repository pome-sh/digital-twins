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
// above, scripts/capture-mcp-tools-list.test.mjs's assertion about a
// producer's SOURCE TEXT, and any generator that WRITES the string into
// source it emits) — those are not code and must not red.
// Conversely the real thing can be spelled in ways a naive regex misses:
// `import.meta?.main`, split across lines, wrapped in parens, negated
// (`!import.meta.main`), read via computed access (`import.meta["main"]`), or
// via destructuring (`const { main } = import.meta`, with or without a
// rename). Matching AST node shapes catches all of those and none of the false
// positives, because a string literal or a comment never becomes a
// MetaProperty node at all.
//
// The parser is `typescript`, not a JS-only one, because the defect's live
// instances were in `.ts`: six bundled examples under `examples/*/src/` shipped
// a bare guard, and a JS-only parser cannot read those files at all — a gate
// that silently cannot parse its subject is the shape D5 targets. typescript is
// already a direct devDependency of all ten workspaces (uniformly `^5.9.3`),
// parses `.ts`/`.mts`/`.tsx` and plain `.mjs`/`.js` through one entry point,
// and needs no plugin.
//
// The file set is DISCOVERED — every source file under the roots below, found
// by walking the directory tree, never a hand-kept list. A hand-kept list is
// the exact shape this milestone (D5) targets: it stops covering its subject
// the day a file is added and nothing notices.
//
// F-1488 extends this same walk with a second, related check rather than
// building a separate scanner: the SANCTIONED replacement for bare
// `import.meta.main` — comparing `process.argv[1]` against `import.meta.url`
// — has its own silent-skip shape when neither side (or only one side) is
// realpath'd. Node resolves symlinks before deriving `import.meta.url`, so an
// unresolved (or only-partly-resolved) argv0 disagrees with it through any
// symlinked invocation (a `git worktree`, or macOS's `/tmp` → `/private/tmp`)
// and the guard falls false — the exact vacuous-pass shape this file already
// exists to catch, reached through a different comparison. Ten instances
// shipped with no realpath on either side (`resolve()`-only, or a bare
// `pathToFileURL(...).href`/`fileURLToPath(...)` compare), and two more
// compared a `basename()` — weaker still, since a basename match is satisfied
// by any file of that name anywhere on disk, so it never needed a symlink at
// all. `findEntryGuardRealpathGaps` below reports a comparison in EITHER of
// those shapes; a comparison with `realpathSync` wrapping both sides is not a
// finding.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const SOURCE_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts", ".mts", ".cts", ".tsx"]);

// Every root that ships an entry point. This is `scripts/no-eval-in-oss.mjs`'s
// root list plus `contract/` and `examples/` — the two the narrower first cut
// of this gate covered (`scripts`, `contract`) left the class open one
// directory over, which is precisely how F-1481 itself happened: F-1353 fixed
// `contract/run.mjs` and the same bug survived ten lines from `probe:examples`.
// `examples/` is load-bearing, not defensive: six examples were live instances.
const SCAN_ROOTS = ["scripts", "contract", "cli/src", "cli/scripts", "packages", "examples"];

// Pruned at ANY depth. Without this the walk finds ~19,600 files instead of
// ~740 and parses third-party CJS, which reds spuriously.
const PRUNED_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".turbo", ".next"]);

/**
 * Every source file under SCAN_ROOTS, sorted, found by recursively walking the
 * directory tree rather than by any hand-kept list. A root that does not exist
 * contributes nothing — the caller asserts a per-root floor so a renamed or
 * relocated root reds instead of quietly dropping out of coverage.
 */
export function discoverSourceFiles(repoRoot = REPO_ROOT, roots = SCAN_ROOTS) {
  const byRoot = new Map();
  const walk = (dir, into) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (PRUNED_DIRS.has(entry.name)) continue;
      // `isDirectory()`/`isFile()` are both FALSE for a symlink, so keying off
      // the dirent alone silently skips a symlinked script or subdirectory —
      // a skip that reads as a pass, in a gate whose whole premise is that it
      // must not. `statSync` follows the link.
      let stat;
      try {
        stat = statSync(full);
      } catch (err) {
        if (err.code === "ENOENT") continue; // broken symlink
        throw err;
      }
      if (stat.isDirectory()) walk(full, into);
      else if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) into.push(full);
    }
  };
  for (const root of roots) {
    const found = [];
    walk(join(repoRoot, root), found);
    byRoot.set(root, found.sort());
  }
  return byRoot;
}

const SCRIPT_KINDS = new Map([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
]);

/** `import.meta` itself — the node every real reference hangs off. */
function isImportMetaNode(node) {
  return (
    !!node &&
    node.kind === ts.SyntaxKind.MetaProperty &&
    node.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name?.text === "meta"
  );
}

/** Does this name/key node name the literal `main`? */
function namesMain(node) {
  if (!node) return false;
  // `{ ["main"]: m }` wraps the key in a ComputedPropertyName node.
  if (ts.isComputedPropertyName(node)) return namesMain(node.expression);
  if (ts.isIdentifier(node)) return node.text === "main";
  // `import.meta["main"]` and `import.meta[`main`]` are both statically
  // resolvable and plausible accidents, so both count. `import.meta["ma"+"in"]`
  // deliberately does not — that needs real constant folding, and nobody
  // reaches it by accident.
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text === "main";
  return false;
}

/** `{ main }`, `{ main: isMain }`, `{ ["main"]: m }`, or `{ ...rest }`. */
function bindsMain(pattern) {
  if (!pattern || !ts.isObjectBindingPattern(pattern)) return false;
  return pattern.elements.some((el) => {
    // `const { ...rest } = import.meta` hands the whole object over, so
    // `rest.main` is reachable and the guard is just as broken.
    if (el.dotDotDotToken) return true;
    return namesMain(el.propertyName ?? el.name);
  });
}

/** The object-literal form of the same thing: `({ main } = import.meta)`. */
function assignsMain(target) {
  if (!target || !ts.isObjectLiteralExpression(target)) return false;
  return target.properties.some((prop) => {
    if (ts.isSpreadAssignment(prop)) return true;
    return namesMain(prop.name);
  });
}

/**
 * Every real `import.meta.main` reference in `source`: a plain, optional-chained
 * or computed member access, or a destructure straight off `import.meta`.
 *
 * @param {string} source
 * @param {string} [fileName] drives the script kind, so `.ts` is parsed as TS.
 */
export function findBareImportMetaMain(source, fileName = "input.mjs") {
  const kind = SCRIPT_KINDS.get(extname(fileName)) ?? ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);

  const hits = [];
  const visit = (node) => {
    const isMemberAccess =
      (ts.isPropertyAccessExpression(node) && isImportMetaNode(node.expression) && namesMain(node.name)) ||
      (ts.isElementAccessExpression(node) &&
        isImportMetaNode(node.expression) &&
        namesMain(node.argumentExpression));
    const isDestructure =
      (ts.isVariableDeclaration(node) && isImportMetaNode(node.initializer) && bindsMain(node.name)) ||
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isImportMetaNode(node.right) &&
        assignsMain(node.left));
    if (isMemberAccess || isDestructure) hits.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return hits.map((node) => {
    const start = node.getStart(sourceFile);
    return {
      line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
      snippet: source.slice(start, Math.min(node.getEnd(), start + 80)).replace(/\s+/g, " "),
    };
  });
}

/** `import.meta.url` itself — the property access the sanctioned entry-guard
 * form reads off `import.meta`, the counterpart to `namesMain`/`isImportMetaNode`
 * above but for `.url` instead of `.main`. */
function isImportMetaUrlNode(node) {
  return (
    !!node &&
    ts.isPropertyAccessExpression(node) &&
    isImportMetaNode(node.expression) &&
    node.name?.text === "url"
  );
}

/** `process.argv[1]` — an element access on `process.argv` with the literal
 * index `1`. Every shipped guard reads argv0 this way; none used `.at(1)`. */
function isProcessArgv1Node(node) {
  if (!node || !ts.isElementAccessExpression(node)) return false;
  const obj = node.expression;
  if (!ts.isPropertyAccessExpression(obj)) return false;
  if (!ts.isIdentifier(obj.expression) || obj.expression.text !== "process") return false;
  if (obj.name.text !== "argv") return false;
  const idx = node.argumentExpression;
  return ts.isNumericLiteral(idx) && idx.text === "1";
}

/** The first descendant of `node` (inclusive) satisfying `pred`, depth-first,
 * or `null`. Bounded to the subtree passed in — this is what lets the caller
 * ask "does THIS SIDE of the comparison hold the argv0/meta-url leaf", not
 * "does this leaf appear anywhere in the file" (which a grep would ask). */
function findLeaf(node, pred) {
  if (pred(node)) return node;
  let found = null;
  ts.forEachChild(node, (child) => {
    if (!found) found = findLeaf(child, pred);
  });
  return found;
}

/** Walking from `leaf` up through its parent chain, up to and including
 * `sideTop` (the top of the comparison operand this leaf belongs to), is
 * there a call to `calleeName` wrapping it? This is how a side is classified
 * as realpath'd (or not) without re-deriving the operand from scratch — the
 * parent chain IS the nesting `realpathSync(resolve(process.argv[1]))`
 * builds, and `node.parent` is populated because `createSourceFile` above is
 * called with `setParentNodes: true`. */
function hasWrappingCall(leaf, sideTop, calleeName) {
  let node = leaf;
  while (node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === calleeName) {
      return true;
    }
    if (node === sideTop) return false;
    node = node.parent;
  }
  return false;
}

const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * Every entry-guard-shaped relation between `process.argv[1]` and
 * `import.meta.url` in `source` — an equality/inequality compare, or the
 * `X.endsWith(Y)` form the two basename instances used — that does NOT
 * realpath both sides. A relation with `realpathSync` wrapping both operands
 * and no `basename()` anywhere in it is the sanctioned form and is not
 * returned; everything else is a finding, tagged with which shape it is:
 *
 *   "basename-comparison" — either side is wrapped in `basename(...)`. Weaker
 *     than even an unresolved full-path compare, since it is satisfied by any
 *     file of that name anywhere on disk — it does not need a symlink to be
 *     wrong.
 *   "one-sided-realpath"  — exactly one side is wrapped in `realpathSync`.
 *     The narrow silent skip F-1353's first fix traded a wide one for: still
 *     defeated by a symlinked checkout, just through a smaller set of paths.
 *   "no-realpath"         — neither side is wrapped in `realpathSync` (this
 *     covers a bare compare, a `resolve()`-only compare, and a
 *     `pathToFileURL(...).href`/`fileURLToPath(...)` compare with no
 *     `realpathSync` anywhere).
 *
 * @param {string} source
 * @param {string} [fileName] drives the script kind, as in `findBareImportMetaMain`.
 */
export function findEntryGuardRealpathGaps(source, fileName = "input.mjs") {
  const kind = SCRIPT_KINDS.get(extname(fileName)) ?? ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);

  const gaps = [];

  const report = (guardNode, argvSide, metaSide, argvLeaf, metaLeaf) => {
    const argvRealpath = hasWrappingCall(argvLeaf, argvSide, "realpathSync");
    const metaRealpath = hasWrappingCall(metaLeaf, metaSide, "realpathSync");
    const argvBasename = hasWrappingCall(argvLeaf, argvSide, "basename");
    const metaBasename = hasWrappingCall(metaLeaf, metaSide, "basename");
    let gapKind;
    if (argvBasename || metaBasename) gapKind = "basename-comparison";
    else if (argvRealpath && metaRealpath) return; // sanctioned form — not a finding
    else if (argvRealpath || metaRealpath) gapKind = "one-sided-realpath";
    else gapKind = "no-realpath";

    const start = guardNode.getStart(sourceFile);
    gaps.push({
      line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
      kind: gapKind,
      snippet: source.slice(start, Math.min(guardNode.getEnd(), start + 140)).replace(/\s+/g, " "),
    });
  };

  const visit = (node) => {
    if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
      const leftArgv = findLeaf(node.left, isProcessArgv1Node);
      const rightMeta = findLeaf(node.right, isImportMetaUrlNode);
      const leftMeta = findLeaf(node.left, isImportMetaUrlNode);
      const rightArgv = findLeaf(node.right, isProcessArgv1Node);
      if (leftArgv && rightMeta) report(node, node.left, node.right, leftArgv, rightMeta);
      else if (leftMeta && rightArgv) report(node, node.right, node.left, rightArgv, leftMeta);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "endsWith" &&
      node.arguments.length > 0
    ) {
      const object = node.expression.expression;
      const arg = node.arguments[0];
      const objArgv = findLeaf(object, isProcessArgv1Node);
      const objMeta = findLeaf(object, isImportMetaUrlNode);
      const argArgv = findLeaf(arg, isProcessArgv1Node);
      const argMeta = findLeaf(arg, isImportMetaUrlNode);
      if (objArgv && argMeta) report(node, object, arg, objArgv, argMeta);
      else if (objMeta && argArgv) report(node, arg, object, argArgv, objMeta);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return gaps;
}

/** Syntax errors, reported as their own category rather than as fake guards. */
export function parseErrorsIn(source, fileName) {
  const kind = SCRIPT_KINDS.get(extname(fileName)) ?? ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  // typescript RECOVERS from syntax errors rather than throwing, so an
  // unreadable file would otherwise scan "clean" — a skip that reads as a
  // pass. Read the diagnostics explicitly instead.
  return (sourceFile.parseDiagnostics ?? []).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, " ")
  );
}

/**
 * Scan every discovered file. Returns real `import.meta.main` references
 * (`findings`), entry guards that do not realpath both sides (`guardGaps`,
 * F-1488) and unparseable files (`unparseable`) SEPARATELY — a syntax error
 * is not a broken entry guard, and reporting it as one sends the reader
 * looking for a guard that does not exist.
 */
export function scanRepo(repoRoot = REPO_ROOT, roots = SCAN_ROOTS) {
  const byRoot = discoverSourceFiles(repoRoot, roots);

  // Per-root, not aggregate: an aggregate floor is satisfied by `scripts/`
  // alone, so renaming or relocating `contract/` would leave it unscanned
  // while the gate still printed a pass.
  const emptyRoots = [...byRoot.entries()].filter(([, files]) => files.length === 0).map(([root]) => root);
  if (emptyRoots.length > 0) {
    throw new Error(
      `lint:import-meta-main discovered zero files under ${emptyRoots.join(", ")} — ` +
        "refusing to report a pass having scanned nothing there (was the directory renamed or moved?)"
    );
  }

  const findings = [];
  const unparseable = [];
  const guardGaps = [];
  let filesScanned = 0;
  for (const files of byRoot.values()) {
    for (const file of files) {
      filesScanned += 1;
      const source = readFileSync(file, "utf8");
      const relPath = relative(repoRoot, file);
      const errors = parseErrorsIn(source, file);
      if (errors.length > 0) {
        unparseable.push({ file: relPath, errors: errors.slice(0, 3) });
        continue;
      }
      for (const hit of findBareImportMetaMain(source, file)) {
        findings.push({ file: relPath, line: hit.line, snippet: hit.snippet });
      }
      for (const gap of findEntryGuardRealpathGaps(source, file)) {
        guardGaps.push({ file: relPath, line: gap.line, kind: gap.kind, snippet: gap.snippet });
      }
    }
  }
  return { filesScanned, findings, unparseable, guardGaps };
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
  const { filesScanned, findings, unparseable, guardGaps } = scanRepo();
  if (unparseable.length > 0) {
    console.error(`Could not parse ${unparseable.length} file(s), so they were NOT checked:\n`);
    for (const bad of unparseable) console.error(`  ${bad.file} — ${bad.errors.join("; ")}`);
    console.error("\nA file this gate cannot read is an unchecked file, which must not read as a pass.");
  }
  if (findings.length > 0) {
    console.error(`\nBare \`import.meta.main\` found in ${findings.length} place(s):\n`);
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line} — ${finding.snippet}`);
    }
    console.error(
      "\nThat property is undefined on Node 24.0.0/24.0.1/24.0.2/24.1.0 (it landed in 24.2), and root " +
        "`engines` allows `>=24` — an entry guard built on it exits 0 having done nothing there. Use " +
        "`realpathSync(process.argv[1])` vs. `realpathSync(fileURLToPath(import.meta.url))` instead " +
        "(see scripts/smoke-examples.mjs, contract/run.mjs, or examples/support-triage/src/index.ts)."
    );
  }
  if (guardGaps.length > 0) {
    console.error(
      `\nEntry guard(s) comparing process.argv[1] against import.meta.url without realpath'ing both sides, ` +
        `found in ${guardGaps.length} place(s):\n`
    );
    for (const gap of guardGaps) {
      console.error(`  ${gap.file}:${gap.line} [${gap.kind}] — ${gap.snippet}`);
    }
    console.error(
      "\nNode resolves symlinks before deriving `import.meta.url`, so a guard missing realpathSync on either " +
        "side disagrees with argv0 through any symlinked invocation (a `git worktree`, or macOS's symlinked " +
        "`/tmp`) and falls false, reading as a pass having checked nothing (F-1488). A `basename()` compare " +
        "is weaker still — satisfied by any file of that name anywhere on disk, no symlink required. Realpath " +
        "BOTH sides: `realpathSync(resolve(process.argv[1]))` vs. `realpathSync(fileURLToPath(import.meta.url))`, " +
        "and throw rather than exit 0 on a guard miss while invoked as the file itself " +
        "(see contract/run.mjs or scripts/no-eval-in-oss.mjs)."
    );
  }
  if (findings.length > 0 || unparseable.length > 0 || guardGaps.length > 0) process.exit(1);
  console.log(
    `No bare \`import.meta.main\` and no un-realpath'd entry guard in ${filesScanned} file(s) under ${SCAN_ROOTS.join(", ")}.`
  );
  process.exit(0);
}
