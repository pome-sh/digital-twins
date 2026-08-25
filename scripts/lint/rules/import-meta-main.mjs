// SPDX-License-Identifier: Apache-2.0
//
// `import.meta.main` is undefined before Node 24.2 and `engines` allows >=24, so a
// bare guard exits 0 having run nothing. Requires a realpath'd `process.argv[1]`
// compared against `import.meta.url`, on BOTH sides — one-sided is the vacuous pass.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const SOURCE_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts", ".mts", ".cts", ".tsx"]);

const SCAN_ROOTS = ["scripts", "contract", "cli/src", "cli/scripts", "packages", "agent-examples"];

const PRUNED_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".turbo", ".next"]);

const MIN_ENTRY_GUARD_RELATIONS = 12;

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

function isImportMetaNode(node) {
  return (
    !!node &&
    node.kind === ts.SyntaxKind.MetaProperty &&
    node.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name?.text === "meta"
  );
}

function namesMain(node) {
  if (!node) return false;
  if (ts.isComputedPropertyName(node)) return namesMain(node.expression);
  if (ts.isIdentifier(node)) return node.text === "main";
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text === "main";
  return false;
}

function bindsMain(pattern) {
  if (!pattern || !ts.isObjectBindingPattern(pattern)) return false;
  return pattern.elements.some((el) => {
    if (el.dotDotDotToken) return true;
    return namesMain(el.propertyName ?? el.name);
  });
}

function assignsMain(target) {
  if (!target || !ts.isObjectLiteralExpression(target)) return false;
  return target.properties.some((prop) => {
    if (ts.isSpreadAssignment(prop)) return true;
    return namesMain(prop.name);
  });
}

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

const IMPORT_META_SELF_PATH_PROPS = new Set(["url", "filename", "dirname"]);
function isImportMetaUrlNode(node) {
  return (
    !!node &&
    ts.isPropertyAccessExpression(node) &&
    isImportMetaNode(node.expression) &&
    IMPORT_META_SELF_PATH_PROPS.has(node.name?.text)
  );
}

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

function findLeaves(node, pred, out = []) {
  if (pred(node)) out.push(node);
  ts.forEachChild(node, (child) => {
    findLeaves(child, pred, out);
  });
  return out;
}

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

export function findEntryGuardRealpathGaps(source, fileName = "input.mjs") {
  const kind = SCRIPT_KINDS.get(extname(fileName)) ?? ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);

  const gaps = [];
  let relations = 0;
  const aliases = collectArgvAndMetaAliases(sourceFile);
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

export function parseErrorsIn(source, fileName) {
  const kind = SCRIPT_KINDS.get(extname(fileName)) ?? ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  return (sourceFile.parseDiagnostics ?? []).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, " ")
  );
}

export function scanRepo(repoRoot = REPO_ROOT, roots = SCAN_ROOTS) {
  const byRoot = discoverSourceFiles(repoRoot, roots);

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
  needsInstall: true,
  check(ctx) {
    const { filesScanned, findings, unparseable, guardGaps, guardRelations } = scanRepo(ctx.root);
    const violations = [];

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
