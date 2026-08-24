// SPDX-License-Identifier: Apache-2.0
//
// A bare `import.meta.main` entry guard is false on Node 24.0.0,
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
// instances were in `.ts`: six bundled examples under `agent-examples/*/src/` shipped
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
// The realpath check extends this same walk with a second, related check rather than
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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

// `../../..` — this rule lives two directories below `scripts/`. Only a default
// for the exported helpers; the runner always passes an explicit root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const SOURCE_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts", ".mts", ".cts", ".tsx"]);

// Every root that ships an entry point. This is `scripts/lint/rules/no-eval.mjs`'s
// root list plus `contract/` and `agent-examples/` — the two the narrower first cut
// of this gate covered (`scripts`, `contract`) left the class open one
// directory over, which is precisely how this gate's own gap happened: one fix landed
// `contract/run.mjs` and the same bug survived ten lines from `probe:examples`.
// `agent-examples/` is load-bearing, not defensive: six examples were live instances.
const SCAN_ROOTS = ["scripts", "contract", "cli/src", "cli/scripts", "packages", "agent-examples"];

// Pruned at ANY depth. Without this the walk finds ~19,600 files instead of
// ~740 and parses third-party CJS, which reds spuriously.
const PRUNED_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".turbo", ".next"]);

// The floor on how many entry-guard comparisons the realpath half must CLASSIFY
// before its "no gaps" verdict means anything. See the rule's `check()` at the
// bottom of this file for why it is proportional rather than `> 0`.
//
// 12 is the instance count that motivated it. It was measured against 31 present;
// consolidating the lint fleet behind one runner deleted 8 of those guards
// outright — every retired gate script had one, and the runner has one for all of
// them — leaving 23. The floor is unchanged because the number it guards against
// is a classifier that has gone blind, not the repo's script count, and 12 of 23
// is still the proportional bound the comment below argues for.
const MIN_ENTRY_GUARD_RELATIONS = 12;

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

/** The self-path properties on `import.meta` — the counterpart to
 * `namesMain`/`isImportMetaNode` above but for the entry guard's other operand.
 * `filename` and `dirname` are in here alongside `url` because Node ships all
 * three (they landed in 21.2), they are all derived AFTER symlink resolution,
 * and a guard comparing an unresolved argv0 against `import.meta.filename` has
 * exactly the realpath bug in a spelling the `url`-only check would call clean. */
const IMPORT_META_SELF_PATH_PROPS = new Set(["url", "filename", "dirname"]);
function isImportMetaUrlNode(node) {
  return (
    !!node &&
    ts.isPropertyAccessExpression(node) &&
    isImportMetaNode(node.expression) &&
    IMPORT_META_SELF_PATH_PROPS.has(node.name?.text)
  );
}

/** argv0 — `process.argv[1]` or `process.argv.at(1)`. Every shipped guard used
 * the element access; `.at(1)` is here because it is the same read in a
 * spelling a future author reaches for without thinking, and a gate that
 * asserts a PROPERTY has to cover the spellings of that property rather than
 * the ones that happened to ship.
 *
 * Not covered: argv0 reached through destructuring (`const [, entry] = process.argv`).
 * That needs binding resolution rather than a syntactic match; the zero-relation
 * floor in the runner is what catches a repo whose guards all moved to a shape
 * this predicate cannot see.
 * ponytail: syntactic match; add binding resolution if a destructured guard ever ships. */
function isProcessArgv1Node(node) {
  if (!node) return false;
  const isProcessArgv = (n) =>
    ts.isPropertyAccessExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "process" &&
    n.name.text === "argv";
  const isOne = (n) => n && ts.isNumericLiteral(n) && n.text === "1";
  if (ts.isElementAccessExpression(node)) {
    return isProcessArgv(node.expression) && isOne(node.argumentExpression);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "at" &&
      isProcessArgv(callee.expression) &&
      node.arguments.length === 1 &&
      isOne(node.arguments[0])
    );
  }
  return false;
}

/** EVERY descendant of `node` (inclusive) satisfying `pred`, depth-first.
 * Bounded to the subtree passed in — this is what lets the caller ask "does
 * THIS SIDE of the comparison hold the argv0/meta-url leaf", not "does this
 * leaf appear anywhere in the file" (which a grep would ask). All matches,
 * not the first, because one side can legitimately read argv0 twice: the
 * sanctioned form's own argv side is
 * `process.argv[1] ? realpathSync(resolve(process.argv[1])) : ""`, whose
 * FIRST occurrence depth-first is the unwrapped ternary condition. */
function findLeaves(node, pred, out = []) {
  if (pred(node)) out.push(node);
  // The callback must return nothing: `ts.forEachChild` treats a truthy return
  // as "found it" and stops iterating siblings, so returning the accumulator
  // here would visit only the first child of every node.
  ts.forEachChild(node, (child) => {
    findLeaves(child, pred, out);
  });
  return out;
}

/** Does any identifier in `call`'s callee chain name one of `names`?
 * Deliberately name-based rather than binding-based, so that `realpathSync(p)`,
 * `fs.realpathSync(p)`, `realpathSync.native(p)` and `await realpath(p)` from
 * `node:fs/promises` all read as the same act. They are — and a gate that
 * accepted only the bare-identifier spelling would red three correct guards
 * out of four, which is a false red on correct work and the fastest way to
 * get a gate deleted. */
function calleeNamesOneOf(call, names) {
  let expr = call.expression;
  for (;;) {
    if (ts.isIdentifier(expr)) return names.has(expr.text);
    if (ts.isPropertyAccessExpression(expr)) {
      if (names.has(expr.name.text)) return true;
      expr = expr.expression;
      continue;
    }
    return false;
  }
}

const REALPATH_CALLEES = new Set(["realpathSync", "realpath"]);
const BASENAME_CALLEES = new Set(["basename"]);

/** Walking from each of `leaves` up through its parent chain, up to and
 * including `sideTop` (the top of the comparison operand the leaves belong
 * to), is ANY of them wrapped in a call naming one of `names`? This is how a
 * side is classified as realpath'd (or not) without re-deriving the operand
 * from scratch — the parent chain IS the nesting
 * `realpathSync(resolve(process.argv[1]))` builds, and `node.parent` is
 * populated because `createSourceFile` above is called with
 * `setParentNodes: true`.
 *
 * ANY rather than EVERY for the ternary reason in `findLeaves` above: the
 * sanctioned form reads argv0 once unwrapped (as the ternary's own existence
 * test) and once wrapped (as its value), and demanding every occurrence be
 * wrapped would red it.
 *
 * Known ceiling: a side that realpaths inside a HELPER
 * (`const real = (p) => realpathSync(p); real(process.argv[1])`) is not
 * followed — that needs interprocedural analysis. It errs toward a false RED
 * on correct work rather than a false green on broken work, which is the safe
 * direction for a gate, and inlining the call is the fix.
 * ponytail: name-based, one hop; add binding resolution if a helper form ever
 * ships and the false red actually bites. */
function anyWrappedIn(leaves, sideTop, names) {
  for (const leaf of leaves) {
    let node = leaf;
    while (node) {
      if (ts.isCallExpression(node) && calleeNamesOneOf(node, names)) return true;
      if (node === sideTop) break;
      node = node.parent;
    }
  }
  return false;
}

/**
 * Single-assignment aliases for argv0 / `import.meta.url`, as
 * name -> initializer.
 *
 * Load-bearing, not a nicety. `const ENTRY = realpathSync(resolve(process.argv[1]))`
 * followed by `if (ENTRY === SELF)` is the shape EVERY fixed entry guard in
 * this repo uses, and it puts the leaf in a DECLARATION rather than in the
 * comparison. A purely operand-local search therefore sees `ENTRY === SELF`,
 * finds no argv0 and no `import.meta.url`, and classifies no relation at all
 * — reporting "no un-realpath'd entry guard" over a repo in which it can see
 * none of them. That is the vacuous pass this milestone keeps re-shipping, so
 * the alias is followed one hop.
 *
 * A name declared more than once is dropped rather than guessed at: two
 * initializers mean the gate cannot know which one reaches the comparison,
 * and a wrong guess in either direction is worse than the relation floor
 * below noticing the guard went unclassified.
 */
function collectArgvAndMetaAliases(sourceFile) {
  const byName = new Map();
  const walk = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (
        findLeaves(init, isProcessArgv1Node).length > 0 ||
        findLeaves(init, isImportMetaUrlNode).length > 0
      ) {
        const name = node.name.text;
        byName.set(name, byName.has(name) ? null : init);
      }
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);
  for (const [name, init] of byName) if (init === null) byName.delete(name);
  return byName;
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
 *     The narrow silent skip an earlier fix traded a wide one for: still
 *     defeated by a symlinked checkout, just through a smaller set of paths.
 *   "no-realpath"         — neither side is wrapped in `realpathSync` (this
 *     covers a bare compare, a `resolve()`-only compare, and a
 *     `pathToFileURL(...).href`/`fileURLToPath(...)` compare with no
 *     `realpathSync` anywhere).
 *
 * Returns `{ relations, gaps }`, not a bare array, and `relations` is the
 * whole point of the pair: it counts every entry-guard-shaped relation the
 * walk CLASSIFIED, sanctioned ones included. An empty `gaps` means either "no
 * broken guard" or "the walk recognized nothing at all", and those two read
 * identically in a CI log. `scanRepo` sums it and the runner hard-fails on
 * zero, so an AST-shape change, a `typescript` upgrade, or a refactor into an
 * unrecognized form reds instead of reporting the class closed.
 *
 * @param {string} source
 * @param {string} [fileName] drives the script kind, as in `findBareImportMetaMain`.
 */
export function findEntryGuardRealpathGaps(source, fileName = "input.mjs") {
  const kind = SCRIPT_KINDS.get(extname(fileName)) ?? ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);

  const gaps = [];
  let relations = 0;
  const aliases = collectArgvAndMetaAliases(sourceFile);
  /** One hop through a single-assignment alias, so `ENTRY === SELF` is read as
   * the initializers those two names hold. */
  const deref = (node) => (ts.isIdentifier(node) ? aliases.get(node.text) ?? node : node);

  const report = (guardNode, argvSide, metaSide, argvLeaves, metaLeaves) => {
    relations += 1;
    const argvRealpath = anyWrappedIn(argvLeaves, argvSide, REALPATH_CALLEES);
    const metaRealpath = anyWrappedIn(metaLeaves, metaSide, REALPATH_CALLEES);
    const argvBasename = anyWrappedIn(argvLeaves, argvSide, BASENAME_CALLEES);
    const metaBasename = anyWrappedIn(metaLeaves, metaSide, BASENAME_CALLEES);
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

  /** Classify one relation between two operands, each already deref'd through
   * its alias, in whichever order argv0 and `import.meta.url` appear. */
  const relate = (guardNode, a, b) => {
    const aArgv = findLeaves(a, isProcessArgv1Node);
    const bMeta = findLeaves(b, isImportMetaUrlNode);
    if (aArgv.length > 0 && bMeta.length > 0) return report(guardNode, a, b, aArgv, bMeta);
    const aMeta = findLeaves(a, isImportMetaUrlNode);
    const bArgv = findLeaves(b, isProcessArgv1Node);
    if (aMeta.length > 0 && bArgv.length > 0) return report(guardNode, b, a, bArgv, aMeta);
  };

  const visit = (node) => {
    if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
      relate(node, deref(node.left), deref(node.right));
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "endsWith" &&
      node.arguments.length > 0
    ) {
      relate(node, deref(node.expression.expression), deref(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return { relations, gaps };
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
 * the realpath check) and unparseable files (`unparseable`) SEPARATELY — a syntax error
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
      `import-meta-main discovered zero files under ${emptyRoots.join(", ")} — ` +
        "refusing to report a pass having scanned nothing there (was the directory renamed or moved?)"
    );
  }

  const findings = [];
  const unparseable = [];
  const guardGaps = [];
  let filesScanned = 0;
  let guardRelations = 0;
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
      const guards = findEntryGuardRealpathGaps(source, file);
      guardRelations += guards.relations;
      for (const gap of guards.gaps) {
        guardGaps.push({ file: relPath, line: gap.line, kind: gap.kind, snippet: gap.snippet });
      }
    }
  }
  return { filesScanned, findings, unparseable, guardGaps, guardRelations };
}

export default {
  name: "import-meta-main",
  describe: "no bare `import.meta.main`, and every entry guard realpaths both sides",
  // `typescript` is a devDependency: the AST walk needs an installed tree.
  needsInstall: true,
  check(ctx) {
    const { filesScanned, findings, unparseable, guardGaps, guardRelations } = scanRepo(ctx.root);
    const violations = [];

    // A file this rule cannot read is an unchecked file, which must not read as
    // a pass.
    for (const bad of unparseable) {
      violations.push(`${bad.file}: could not be parsed, so it was NOT checked — ${bad.errors.join("; ")}`);
    }

    for (const finding of findings) {
      violations.push(
        `${finding.file}:${finding.line} — bare \`import.meta.main\`: ${finding.snippet}\n` +
          `That property is undefined on Node 24.0.0–24.1.0 (it landed in 24.2) and root ` +
          `\`engines\` allows \`>=24\`, so an entry guard built on it exits 0 having done nothing there.`,
      );
    }

    for (const gap of guardGaps) {
      violations.push(
        `${gap.file}:${gap.line} [${gap.kind}] — entry guard compares process.argv[1] against ` +
          `import.meta.url without realpath'ing both sides: ${gap.snippet}`,
      );
    }

    // The floor on the realpath half, and the counterpart to the per-root
    // file-count floor inside scanRepo. An empty `guardGaps` is ambiguous on its
    // own: it means "every entry guard realpaths both sides" OR "the walk
    // recognized no entry guard at all", and only the first is a pass. The
    // classifier going blind — a `typescript` upgrade changing an AST shape,
    // argv0 read some new way, the guards refactored behind a helper — is
    // exactly the moment this rule's failure mode reports the class closed.
    //
    // PROPORTIONAL, not `> 0`: only one guard in this repo compares argv0 and
    // `import.meta.url` inline, and the rest are found through the
    // single-assignment alias deref, so a regression that broke only the deref
    // would leave the count at 1 and a `> 0` floor would still print a pass.
    if (guardRelations < MIN_ENTRY_GUARD_RELATIONS) {
      violations.push(
        `The entry-guard check classified only ${guardRelations} argv[1]-vs-import.meta.url ` +
          `relation(s) across ${filesScanned} file(s), below the floor of ${MIN_ENTRY_GUARD_RELATIONS}. ` +
          `Every runnable script in this repo has such a guard, so this is the checker having gone ` +
          `(partly) blind, not the repo being clean — refusing to report a pass. If scripts were ` +
          `genuinely removed, lower the floor deliberately.`,
      );
    }

    return {
      violations,
      summary: `${filesScanned} file(s) under ${SCAN_ROOTS.join(", ")}, ${guardRelations} entry-guard comparison(s) realpath both sides`,
      hint:
        "Node resolves symlinks before deriving `import.meta.url`, so a guard missing realpathSync\n" +
        "on either side disagrees with argv0 through any symlinked invocation (a `git worktree`, or\n" +
        "macOS's symlinked `/tmp`) and falls false, reading as a pass having checked nothing. A\n" +
        "`basename()` compare is weaker still — satisfied by any file of that name anywhere on\n" +
        "disk. Realpath BOTH sides: `realpathSync(resolve(process.argv[1]))` vs.\n" +
        "`realpathSync(fileURLToPath(import.meta.url))`, and throw rather than exit 0 on a guard\n" +
        "miss while invoked as the file itself (see scripts/lint.mjs or contract/run.mjs).",
    };
  },
};
