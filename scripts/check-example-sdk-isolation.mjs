#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1295: a bundled Claude-Agent-SDK example whose `query()` options omit
// `tools` or `settingSources` is not isolated, however carefully its comments
// say it is.
//
// Two DIFFERENT doors, and shutting one says nothing about the other:
//
//   options.tools           the BUILT-IN base set (Bash, Read, Grep, WebFetch,
//                           …). `[]` replaces the set, so it is complete by
//                           construction. Closed for the hero example by
//                           F-1292.
//   options.settingSources  FILESYSTEM settings — user (~/.claude/settings.json),
//                           project (.claude/settings.json) and local
//                           (.claude/settings.local.json), INCLUDING the
//                           developer's Claude Code plugin MCP servers. The SDK
//                           typedoc: "When omitted, all sources are loaded
//                           (matches CLI defaults). Pass [] to disable
//                           filesystem settings (SDK isolation mode)."
//
// Measured 2026-08-05 (F-1295): a hosted `claude-haiku-4-5` trial of
// support-triage-dedup, launched from a developer shell with `options.tools: []`
// ALREADY SET, called `mcp__plugin_slack_slack__slack_search_channels`,
// `…__slack_search_public` and `…__slack_list_channel_members` — it searched the
// developer's real Slack workspace, made zero twin calls, and would have scored
// as "the agent failed to triage". A verdict about the wrong workspace entirely.
// Those servers arrive as Claude Code PLUGINS (namespaced
// `plugin_<plugin>_<server>`), not from the repo's committed `.mcp.json` and not
// from `~/.claude.json` — which is why no amount of repo hygiene reaches them
// and why only `settingSources: []` does.
//
// This gate is the answer to "an example is not sealed by intention". It PARSES
// rather than greps, for the reason `scripts/lint-no-bare-import-meta-main.mjs`
// gives: a grep for "settingSources" also matches the word in the comment three
// lines above the options object it was deleted from, which is the single most
// likely way this regresses.
//
// [DECISION] F-1295 — central AND per-example, and the central half is NOT here.
// Per-example options are what this gate enforces, and they are load-bearing on
// their own: `agent-examples/support-triage` is `npx degit`-fetchable as a standalone
// subtree, so the options a reader copies out must carry the isolation with
// them. The central half belongs in `@pome-sh/adapter-claude-sdk`'s `query()`
// — the one in-process chokepoint EVERY bundled example already routes through,
// and the only one that holds for all three launchers (`pome run`, the coach's
// `run_task` local-subprocess spawn, and a plain `npm start`). Deliberately not
// the `pome run` path itself: the measured F-1295 trial was launched from a
// developer shell by the coach, so a CLI-side clamp would not have caught the
// very incident this ticket is about, and the obvious mechanism there
// (`CLAUDE_CONFIG_DIR` at an empty dir, which the SDK does honor) also holds
// `.credentials.json` — it would break subscription auth under `pome run`, the
// thing FDRS-667 fixed. The adapter change is a behavior change to a PUBLISHED
// package's documented drop-in contract, so it is its own ticket with its own
// version bump; this gate is what keeps the class closed until then, and stays
// useful after, because the adapter cannot fix an example someone copies out.

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** The two options that must both be present. Order is display order. */
export const REQUIRED_OPTIONS = ["tools", "settingSources"];

/** The dependency that makes an example one of this gate's subjects. */
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * The modules a `query` binding may come from. The adapter re-exports a drop-in
 * wrapper, and every bundled example imports it from there today — but an
 * example importing the raw SDK's `query` is the same agent with the same two
 * doors, so both count. A `query` from anywhere else (a twin's REST client, a
 * database helper) is not this gate's business.
 */
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

/**
 * The floor on how many `query()` call sites the walk must CLASSIFY before a
 * clean verdict means anything — four today, one per bundled SDK example. An
 * empty findings list is ambiguous on its own: it means "every example is
 * isolated" OR "the walk recognized no call site at all", and only the first is
 * a pass. A `typescript` upgrade moving an AST shape, or the examples
 * refactoring `query()` behind a helper, is exactly the moment a gate reports
 * the class closed having read nothing.
 */
export const MIN_QUERY_CALL_SITES = 4;

/**
 * Every `agent-examples/*` directory whose package.json declares the Claude Agent SDK
 * — DISCOVERED by reading the manifests, never a hand-kept list. A hand-kept
 * list stops covering its subject the day an example is added and nothing
 * notices, which is the enumeration failure this whole ticket family is about.
 *
 * `dependencies` and `devDependencies` both count: which section an example
 * files the SDK under says nothing about whether it launches an agent.
 */
export function discoverSdkExamples(repoRoot = REPO_ROOT) {
  const examplesDir = join(repoRoot, "agent-examples");
  let entries;
  try {
    entries = readdirSync(examplesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
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

/** Every source file under `dir`, recursively, sorted. */
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
      // `isDirectory()`/`isFile()` are both false for a symlink; statSync
      // follows it. A silently skipped file reads as a pass.
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

/** Syntax errors, reported as their own category rather than as fake findings. */
export function parseErrorsIn(source, fileName) {
  const sourceFile = createSourceFile(source, fileName);
  // typescript RECOVERS from syntax errors rather than throwing, so an
  // unreadable file would otherwise scan "clean".
  return (sourceFile.parseDiagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

function createSourceFile(source, fileName) {
  const kind = SCRIPT_KINDS.get(extname(fileName)) ?? ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

/**
 * Local names bound to a `query` import from one of QUERY_MODULES — so
 * `import { query }`, `import { query as ask }` and `import * as sdk` (whose
 * `sdk.query(...)` is matched by the namespace set) are all seen, and a local
 * function that happens to be called `query` is not.
 */
function collectQueryBindings(sourceFile) {
  const direct = new Set();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!QUERY_MODULES.has(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    // `import type { … }` binds no value — a type-only import cannot be called.
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

/**
 * Single-assignment `const X = <expr>` initializers, plus same-file functions'
 * single `return <expr>` expressions, both keyed by name.
 *
 * Load-bearing rather than a nicety. `agent-examples/support-triage` composes its
 * exam surface in `examineeOptions(mcpServers)` and passes the CALL to
 * `query()` — deliberately, so its own test can assert the policy constants are
 * wired in. A resolver that only understood an inline object literal would find
 * no options object there and would have to either red the one example that
 * already got this right, or skip it. Skipping is how a gate passes forever.
 *
 * A name declared twice is dropped rather than guessed at, and a function with
 * more than one `return` is dropped for the same reason: two answers mean the
 * gate cannot know which one reaches `query()`, and an unresolved options
 * object is reported as a finding rather than assumed clean.
 */
function collectResolvables(sourceFile) {
  const byName = new Map();
  const remember = (name, expr) => {
    byName.set(name, byName.has(name) ? null : expr);
  };

  /** The single returned expression of a function body, or undefined. */
  const soleReturn = (body) => {
    if (!body) return undefined;
    // A concise arrow body (`() => ({ … })`) is the expression itself.
    if (!ts.isBlock(body)) return body;
    const returns = [];
    const walk = (node) => {
      // Do not descend into a nested function — its `return` is not this one's.
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

/**
 * Resolve an expression to the object literal it stands for: the literal
 * itself, a `const` bound to one, or a call to a same-file function that
 * returns one. Bounded depth, because a resolver that can loop on
 * `const a = b, b = a` is a hang, not a gate.
 *
 * Anything else — an imported helper, a conditional, a function with two
 * returns — resolves to `null`, which the caller reports as a finding. Failing
 * CLOSED is the whole point: "this gate could not tell" and "this example is
 * isolated" must never print the same way.
 */
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

/**
 * The property names an object literal sets UNCONDITIONALLY, following spreads
 * of resolvable object literals.
 *
 * A conditional spread — `...(MODEL ? { model: MODEL } : {})`, the shape three
 * of the bundled examples already use for `model` — deliberately does NOT
 * contribute. A door that is only shut when some env var is set is a door that
 * is open, and this gate exists because "shut in the case we thought about" is
 * exactly what `tools: []` alone turned out to be.
 */
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

/**
 * Every `query()` call site in `source`, with the options keys it sets.
 *
 * Returns `{ callSites, findings }`. `callSites` counts what was CLASSIFIED,
 * sanctioned ones included — see MIN_QUERY_CALL_SITES for why an empty
 * `findings` alone is not a pass.
 */
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
        // Quoted as well as bare, matching `unconditionalKeys` — a gate that
        // reads `options:` but not `"options":` would report both doors open on
        // a call that shuts them.
        const optionsProperty = params.properties.find(
          (p) =>
            p.name &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
            p.name.text === "options",
        );
        // `query({ prompt, options })` is the same call as `options: options`,
        // and resolving the shorthand through the same table is what keeps it
        // from reading as an unresolvable object — a false RED on correct work,
        // which is how a gate gets deleted rather than obeyed.
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

/**
 * Scan every discovered SDK example. Unparseable files are reported separately
 * from findings — a syntax error is not an open door, and reporting it as one
 * sends the reader looking for an options object that does not exist.
 */
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

// Realpath'd on both sides, and throws rather than exits 0 on a guard miss
// (F-1481 / F-1488) — a gate whose own entry guard silently falls false is the
// failure it exists to catch.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("check-example-sdk-isolation.mjs")) {
  throw new Error(`check-example-sdk-isolation.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  const { examples, filesScanned, callSites, findings, unparseable, silentExamples } = scanExamples();

  if (examples.length === 0) {
    console.error(
      `No agent-examples/* package declares ${SDK_PACKAGE}, so this gate scanned nothing — refusing to report a pass. ` +
        "If the examples moved, move this gate's discovery with them.",
    );
    process.exit(1);
  }
  if (unparseable.length > 0) {
    console.error(`Could not parse ${unparseable.length} file(s), so they were NOT checked:\n`);
    for (const bad of unparseable) console.error(`  ${bad.file} — ${bad.errors.join("; ")}`);
    console.error("\nA file this gate cannot read is an unchecked file, which must not read as a pass.\n");
  }
  if (silentExamples.length > 0) {
    console.error(
      `These examples declare ${SDK_PACKAGE} but this gate found no \`query()\` call in them: ` +
        `${silentExamples.join(", ")}.\nEither they launch no agent, or the call is in a shape this gate cannot ` +
        "see — and the second reads exactly like a pass.\n",
    );
  }
  if (findings.length > 0) {
    console.error(`Claude-Agent-SDK example(s) running without full isolation — ${findings.length} call site(s):\n`);
    for (const finding of findings) {
      console.error(`  ${finding.file}:${finding.line} — ${REASONS[finding.reason](finding.missing)}`);
    }
    console.error(
      "\n`options.tools` and `options.settingSources` close DIFFERENT doors. `tools: []` replaces the built-in " +
        "base set (Bash, Read, WebFetch, …); `settingSources: []` disables filesystem settings — user, project " +
        "and local — INCLUDING the developer's Claude Code plugin MCP servers. Measured 2026-08-05 (F-1295): a " +
        "trial with `tools: []` already set searched the developer's real Slack workspace, made zero twin calls, " +
        "and would have scored as a triage failure. Set BOTH on every `query()` in a bundled example.",
    );
  }
  if (findings.length > 0 || unparseable.length > 0 || silentExamples.length > 0) process.exit(1);
  if (callSites < MIN_QUERY_CALL_SITES) {
    console.error(
      `Classified only ${callSites} \`query()\` call site(s) across ${examples.length} SDK example(s), below the ` +
        `floor of ${MIN_QUERY_CALL_SITES}. Every bundled SDK example launches one, so this is the checker having ` +
        "gone blind, not the examples being clean — refusing to report a pass. If examples were genuinely " +
        "removed, lower the floor deliberately.",
    );
    process.exit(1);
  }
  console.log(
    `All ${callSites} \`query()\` call site(s) in ${examples.length} SDK example(s) ` +
      `(${examples.join(", ")}) set both \`tools\` and \`settingSources\`; ${filesScanned} file(s) scanned.`,
  );
  process.exit(0);
}
