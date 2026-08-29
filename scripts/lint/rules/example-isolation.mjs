// SPDX-License-Identifier: Apache-2.0
//
// Every example must seal its agent with `settingSources: []`. Parses rather than
// greps: a grep for the option name also matches it in a comment beside the object.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLE_ROOTS } from "../../lib/example-roots.mjs";

import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const REQUIRED_OPTIONS = ["tools", "settingSources"];

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

const QUERY_MODULES = new Set([SDK_PACKAGE, "@pome-sh/adapter-claude-sdk"]);

const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".mjs", ".js", ".cjs"]);
const PRUNED_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

const SCRIPT_KINDS = new Map([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
]);

export const MIN_QUERY_CALL_SITES = 4;

export function discoverSdkExamples(repoRoot = REPO_ROOT) {
  const entries = [];
  for (const root of EXAMPLE_ROOTS) {
    const examplesDir = join(repoRoot, root);
    try {
      for (const entry of readdirSync(examplesDir, { withFileTypes: true })) {
        entries.push({ entry, examplesDir });
      }
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
  }
  const found = [];
  for (const { entry, examplesDir } of entries.sort((a, b) => a.entry.name.localeCompare(b.entry.name))) {
    const dir = join(examplesDir, entry.name);
    let stat;
    try {
      stat = statSync(dir);
    } catch (err) {
      if (err.code === "ENOENT") continue; // broken symlink
      throw err;
    }
    if (!stat.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    if (SDK_PACKAGE in declared) found.push({ name: entry.name, dir });
  }
  return found;
}

export function discoverSourceFiles(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (PRUNED_DIRS.has(entry.name)) continue;
      const full = join(current, entry.name);
      let stat;
      try {
        stat = statSync(full);
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

export function parseErrorsIn(source, fileName) {
  const sourceFile = createSourceFile(source, fileName);
  return (sourceFile.parseDiagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

function createSourceFile(source, fileName) {
  const kind = SCRIPT_KINDS.get(extname(fileName)) ?? ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

function collectQueryBindings(sourceFile) {
  const direct = new Set();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!QUERY_MODULES.has(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.isTypeOnly) continue;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (imported === "query") direct.add(element.name.text);
    }
  }
  return { direct, namespaces };
}

function collectResolvables(sourceFile) {
  const byName = new Map();
  const remember = (name, expr) => {
    byName.set(name, byName.has(name) ? null : expr);
  };

  const soleReturn = (body) => {
    if (!body) return undefined;
    if (!ts.isBlock(body)) return body;
    const returns = [];
    const walk = (node) => {
      if (node !== body && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
        return;
      }
      if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(body, walk);
    return returns.length === 1 ? returns[0] : undefined;
  };

  const walk = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      remember(node.name.text, soleReturn(node.body));
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      const isFn = ts.isArrowFunction(init) || ts.isFunctionExpression(init);
      remember(node.name.text, isFn ? soleReturn(init.body) : init);
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sourceFile, walk);

  for (const [name, expr] of byName) if (!expr) byName.delete(name);
  return byName;
}

export function resolveObjectLiteral(expr, resolvables, depth = 0) {
  if (!expr || depth > 8) return null;
  if (ts.isParenthesizedExpression(expr)) return resolveObjectLiteral(expr.expression, resolvables, depth + 1);
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return resolveObjectLiteral(expr.expression, resolvables, depth + 1);
  }
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isIdentifier(expr)) return resolveObjectLiteral(resolvables.get(expr.text), resolvables, depth + 1);
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return resolveObjectLiteral(resolvables.get(expr.expression.text), resolvables, depth + 1);
  }
  return null;
}

export function unconditionalKeys(objectLiteral, resolvables, depth = 0) {
  const keys = new Set();
  if (!objectLiteral || depth > 8) return keys;
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = resolveObjectLiteral(property.expression, resolvables, depth + 1);
      if (spread) for (const key of unconditionalKeys(spread, resolvables, depth + 1)) keys.add(key);
      continue;
    }
    const name = property.name;
    if (!name) continue;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
      keys.add(name.text);
    }
  }
  return keys;
}

export function scanSource(source, fileName = "index.ts") {
  const sourceFile = createSourceFile(source, fileName);
  const { direct, namespaces } = collectQueryBindings(sourceFile);
  const resolvables = collectResolvables(sourceFile);

  const isQueryCallee = (callee) => {
    if (ts.isIdentifier(callee)) return direct.has(callee.text);
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "query" &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text)
    );
  };

  const findings = [];
  let callSites = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node) && isQueryCallee(node.expression)) {
      callSites += 1;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const params = resolveObjectLiteral(node.arguments[0], resolvables);
      if (!params) {
        findings.push({ line, reason: "unresolvable-params", missing: [...REQUIRED_OPTIONS] });
      } else {
        const optionsProperty = params.properties.find(
          (p) =>
            p.name &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
            p.name.text === "options",
        );
        const optionsValue = !optionsProperty
          ? undefined
          : ts.isPropertyAssignment(optionsProperty)
            ? optionsProperty.initializer
            : ts.isShorthandPropertyAssignment(optionsProperty)
              ? optionsProperty.name
              : undefined;
        const options = optionsValue ? resolveObjectLiteral(optionsValue, resolvables) : null;
        if (!options) {
          findings.push({
            line,
            reason: optionsProperty ? "unresolvable-options" : "no-options",
            missing: [...REQUIRED_OPTIONS],
          });
        } else {
          const keys = unconditionalKeys(options, resolvables);
          const missing = REQUIRED_OPTIONS.filter((option) => !keys.has(option));
          if (missing.length > 0) findings.push({ line, reason: "missing-options", missing });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return { callSites, findings };
}

export function scanExamples(repoRoot = REPO_ROOT) {
  const examples = discoverSdkExamples(repoRoot);
  const findings = [];
  const unparseable = [];
  const silentExamples = [];
  let callSites = 0;
  let filesScanned = 0;

  for (const example of examples) {
    let exampleCallSites = 0;
    for (const file of discoverSourceFiles(example.dir)) {
      filesScanned += 1;
      const source = readFileSync(file, "utf8");
      const relPath = relative(repoRoot, file);
      const errors = parseErrorsIn(source, file);
      if (errors.length > 0) {
        unparseable.push({ file: relPath, errors: errors.slice(0, 3) });
        continue;
      }
      const result = scanSource(source, file);
      exampleCallSites += result.callSites;
      for (const finding of result.findings) findings.push({ ...finding, example: example.name, file: relPath });
    }
    callSites += exampleCallSites;
    if (exampleCallSites === 0) silentExamples.push(example.name);
  }

  return { examples: examples.map((e) => e.name), filesScanned, callSites, findings, unparseable, silentExamples };
}

const REASONS = {
  "missing-options": (missing) => `options omit ${missing.map((m) => `\`${m}\``).join(" and ")}`,
  "no-options": () => "the call passes no `options` at all — both doors are wide open",
  "unresolvable-options": () =>
    "this gate could not resolve `options` to an object literal, so it cannot say the doors are shut",
  "unresolvable-params": () =>
    "this gate could not resolve the argument to `query()` to an object literal, so it cannot say the doors are shut",
};

export default {
  name: "example-isolation",
  describe: "every bundled SDK example sets both `tools` and `settingSources` on `query()`",
  needsInstall: true,
  check(ctx) {
    const { examples, filesScanned, callSites, findings, unparseable, silentExamples } = scanExamples(ctx.root);

    if (examples.length === 0) {
      throw new Error(
        `No package under ${EXAMPLE_ROOTS.map((r) => `${r}/*`).join(" or ")} declares ${SDK_PACKAGE}, so ` +
          `this rule scanned nothing — refusing ` +
          `to report a pass. If the examples moved, move this rule's discovery with them.`,
      );
    }

    const violations = [];

    for (const bad of unparseable) {
      violations.push(`${bad.file}: could not be parsed, so it was NOT checked — ${bad.errors.join("; ")}`);
    }

    for (const name of silentExamples) {
      violations.push(
        `${name} declares ${SDK_PACKAGE} but this rule found no \`query()\` call in it.`,
      );
    }

    for (const finding of findings) {
      violations.push(`${finding.file}:${finding.line} — ${REASONS[finding.reason](finding.missing)}`);
    }

    if (violations.length === 0 && callSites < MIN_QUERY_CALL_SITES) {
      violations.push(
        `Classified only ${callSites} \`query()\` call site(s) across ${examples.length} SDK example(s), ` +
          `below the floor of ${MIN_QUERY_CALL_SITES}. Every bundled SDK example launches one, so this is ` +
          `the checker having gone blind, not the examples being clean — refusing to report a pass. If ` +
          `examples were genuinely removed, lower the floor deliberately.`,
      );
    }

    return {
      violations,
      summary: `all ${callSites} \`query()\` call site(s) in ${examples.length} SDK example(s) (${examples.join(", ")}) set both options; ${filesScanned} file(s) scanned`,
      hint:
        "`options.tools` and `options.settingSources` close DIFFERENT doors. `tools: []` replaces the\n" +
        "built-in base set (Bash, Read, WebFetch, …); `settingSources: []` disables filesystem\n" +
        "settings — user, project and local — INCLUDING the developer's Claude Code plugin MCP\n" +
        "servers. Measured 2026-08-05: a trial with `tools: []` already set searched the developer's\n" +
        "real Slack workspace, made zero twin calls, and would have scored as a triage failure. Set\n" +
        "BOTH on every `query()` in a bundled example.",
    };
  },
};
