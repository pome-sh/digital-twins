#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1472 — closes the class F-1354 found one instance of: a `packages/*` npm
// script that names itself a check (`validate:mcp`) declared in a
// package.json and invoked by NOTHING. It went red for weeks with no
// verdict, and no verdict reads exactly like a pass.
//
// The rule is a TOTAL partition, not a prefix list. Every
// `packages/*/package.json` script is either
//
//   (a) an npm LIFECYCLE script (the fixed set below — names npm itself
//       defines, wired uniformly through `--workspaces --if-present` or an
//       explicit `-w` list, a different and already-solved problem), or
//   (b) reachable from a workflow or a root aggregate script — textually, as
//       `npm run <script> ... -w <package-name>`, or
//   (c) carrying a `pome:unwired-ok(<script>): <reason>` marker in the file its
//       command invokes.
//
// Anything else fails this gate by name.
//
// This gate started life (F-1472) as an allowlist of check-NAME prefixes
// (`validate:*`, `check:*`, `lint:*`, `gate:*`, `test:*`, `assert:*`) — the
// vocabulary F-1472 specified. That vocabulary could not see
// `verify:cloud-token`, a real check that had also never run, and the audit
// found it by hand instead. A prefix list of what counts as a check is itself
// a hand-maintained list, which is the exact shape D5 names as the bug: it
// covers its subject until someone names a script something new, and then it
// silently stops, with nothing red. So the partition is inverted — the
// DENOMINATOR is every script, the only fixed list is npm's own lifecycle
// names, and a script that is neither wired nor reasoned-about is a red.
// `smoke`, `review:harness`, `verify:cloud-token` and `preview:drift` are all
// inside the gate's reach under this shape and were all outside it before.
//
// NO CENTRAL ALLOWLIST. A script deliberately exempt from this gate carries
// its own reason inline, in the source file its package.json command invokes
// — a line matching `pome:unwired-ok(<script>): <reason>` — and this gate
// reads that file rather than a list here. A list of which checks are exempt is the same
// shape as the bug the milestone is about.
//
// Textual, not semantic: this reads workflow YAML and root scripts as text
// looking for `npm run <name> ... -w <package>`. A caller that reaches a
// script through a programmatic argv array (`spawnSync("npm", ["run", name,
// "-w", pkg])`) rather than a composed string is invisible to it — no caller
// in this repo does that today, so it is a documented limitation, not a
// silent gap. Same reasoning as the wired-check regex above: literal text,
// not an npm/AST-aware resolver.
//
// Dependency-free, so it runs in ci.yml's always-on block before `npm ci`.
//
// Usage: node scripts/check-packages-scripts-wired.mjs

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();

/**
 * npm's own lifecycle script names. Not a list of things exempt from being a
 * check — a list of names npm assigns meaning to, which every package has and
 * which the root wires uniformly (`--workspaces --if-present`, or an explicit
 * `-w` list). This set is closed by npm, not by us: it does not grow when
 * someone adds a check under a name nobody predicted, which is the failure the
 * old prefix vocabulary had.
 */
const LIFECYCLE_SCRIPTS = new Set([
  "build",
  "dev",
  "start",
  "test",
  "typecheck",
  "prepack",
  "prepare",
  "prepublishOnly",
  "postinstall",
]);

/**
 * A marker NAMES the script it exempts — `pome:unwired-ok(<script>): <reason>`
 * — and the reason must be on the same line and non-blank.
 *
 * Two holes this closes, both found by breaking the first version on purpose:
 *
 * 1. `/pome:unwired-ok:\s*(.+)/` let a marker with NO reason through. `\s`
 *    matches a newline, so a bare `// pome:unwired-ok:` consumed the line
 *    break and captured the next line of the file as its justification — it
 *    reported a stray `import` statement as the reason someone chose not to
 *    run a check. An exemption with no reason is what the milestone forbids.
 *
 * 2. An unnamed marker exempts EVERY script in the package whose command
 *    names that file, and three files here implement two scripts each: a write
 *    mode nothing runs plus a `--check` mode that IS wired
 *    (`fixture:mcp`/`gate:mcp-fixture`, `regenerate:`/`gate:mcp-tool-fixture`,
 *    `emit:`/`check:trace-contract`). One unnamed marker for the write half
 *    would silently pre-authorise the check half going unwired — which is the
 *    original defect, granted in advance.
 */
function exemptionMarkerFor(scriptName) {
  return new RegExp(`pome:unwired-ok\\(${escapeRe(scriptName)}\\):[ \\t]*(\\S[^\\n]*)`);
}

/** Every `packages/*` script that is not an npm lifecycle script. */
export function findCheckScripts(root) {
  // Never `return []` on a missing packages/ — this gate runs from the repo
  // root in ci.yml, and a wrong cwd would otherwise print `OK — 0 scripts` and
  // exit 0, asserting nothing. Same reasoning as contract/run.mjs, which
  // throws on an empty discovery rather than exiting 0 having found no tests.
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) {
    throw new Error(
      `no packages/ directory under ${root} — this gate must run from the repo root; ` +
        `an empty scan would exit 0 having asserted nothing.`,
    );
  }
  const found = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch {
      continue; // not this gate's problem — package.json validity is checked elsewhere
    }
    for (const [scriptName, command] of Object.entries(pkg.scripts ?? {})) {
      if (LIFECYCLE_SCRIPTS.has(scriptName)) continue;
      found.push({
        pkgDir: entry.name,
        pkgName: pkg.name ?? entry.name,
        scriptName,
        command: String(command),
      });
    }
  }
  return found;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A script is "wired" if some corpus of text (workflow YAML, root
 * package.json, root scripts/) contains `npm run <script> ... -w
 * <package>` on one line — the shape every existing wired check in this
 * repo uses (see ci.yml's `npm run validate:mcp -w @pome-sh/twin-github`).
 */
export function isWired(entry, corpus) {
  // `(?![\w:.-])`, never `\b`: `-` and `:` are non-word characters, so `\b`
  // after `gate:mcp` matches inside `gate:mcp-fixture`. A package declaring
  // both would have had the longer script's real CI line certify the shorter
  // one as wired while nothing ran it — the F-1354 shape, produced by the gate
  // meant to catch it.
  const re = new RegExp(
    `npm run ${escapeRe(entry.scriptName)}(?![\\w:.-])[^\\n]*-w\\s+${escapeRe(entry.pkgName)}(?![\\w:./@-])`,
  );
  return re.test(corpus);
}

/**
 * Reads the exemption reason straight from the file the script's own command
 * invokes, never from a list here. Returns null if the command names no
 * resolvable file, the file doesn't exist, or it carries no marker.
 *
 * The resolved path must stay INSIDE the script's own package. `[\w./-]+`
 * matches `..`, so a command whose first file token escaped the package
 * (`node ../beta/scripts/other.mjs && node scripts/foo.mjs`) let an unrelated
 * file's marker exempt this script — an exemption satisfied by a reason
 * written about something else.
 */
export function findExemptionReason(entry, root) {
  const scriptPath = invokedFile(entry, root);
  if (!scriptPath) return null;
  let content;
  try {
    content = readFileSync(scriptPath, "utf8");
  } catch {
    return null;
  }
  const marker = content.match(exemptionMarkerFor(entry.scriptName));
  return marker ? marker[1].trim() : null;
}

const SELF_EXCLUDED = new Set([
  "check-packages-scripts-wired.mjs",
  "check-packages-scripts-wired.test.mjs",
]);

/**
 * Drops whole-line comments before the corpus is searched. Commenting a check
 * out — "# disabled, flaky" — is the single most common way a check stops
 * producing a verdict, and a plain text scan counted the dead line as proof it
 * still ran. Handles the three comment leaders in this corpus: `#` (YAML, sh)
 * and `//` (mjs/js). Deliberately whole-line only: a trailing comment after a
 * real command does not make the command not run, and a block-comment-aware
 * parser is a JS/YAML parser, which this dependency-free gate is not.
 */
function stripCommentLines(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");
}

function readCorpus(root) {
  const parts = [];
  const workflowsDir = join(root, ".github/workflows");
  if (existsSync(workflowsDir)) {
    for (const file of readdirSync(workflowsDir)) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      parts.push(readFileSync(join(workflowsDir, file), "utf8"));
    }
  }
  const rootPkgJson = join(root, "package.json");
  if (existsSync(rootPkgJson)) parts.push(readFileSync(rootPkgJson, "utf8"));
  const scriptsDir = join(root, "scripts");
  if (existsSync(scriptsDir)) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        // This gate and its own regression suite are NOT wiring. Both are
        // inside the corpus they scan and both quote `npm run <name> -w <pkg>`
        // strings — this file in its docstrings, the suite in its fixtures. A
        // gate that accepts its own prose as proof a check runs is the bug it
        // exists to catch, and a future fixture that used a REAL package name
        // instead of `@pome-sh/alpha` would silently wire that package's
        // script. Excluded by name so it cannot happen by accident.
        if (SELF_EXCLUDED.has(entry.name)) continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else if (/\.(mjs|js|sh)$/.test(entry.name)) {
          parts.push(readFileSync(abs, "utf8"));
        }
      }
    };
    walk(scriptsDir);
  }
  const contractDir = join(root, "contract");
  if (existsSync(contractDir)) {
    for (const file of readdirSync(contractDir)) {
      if (file.endsWith(".mjs")) parts.push(readFileSync(join(contractDir, file), "utf8"));
    }
  }
  return stripCommentLines(parts.join("\n"));
}

/**
 * The file a script's command invokes, resolved inside its own package, or
 * null. Shared with the exemption reader so the two agree on what file a
 * script means.
 */
export function invokedFile(entry, root) {
  const fileMatch = entry.command.match(/([\w./-]+\.(?:ts|mjs|js|sh))/);
  if (!fileMatch) return null;
  const pkgRoot = resolve(root, "packages", entry.pkgDir);
  const scriptPath = resolve(pkgRoot, fileMatch[1]);
  if (scriptPath !== pkgRoot && !scriptPath.startsWith(`${pkgRoot}/`)) return null;
  return existsSync(scriptPath) ? scriptPath : null;
}

export function run(root) {
  const entries = findCheckScripts(root);
  const corpus = readCorpus(root);

  // A write mode whose WIRED sibling runs the same command PLUS more is
  // covered by derivation, not by a hand-written reason. Three files here have
  // exactly that shape — `tsx scripts/adopt-upstream-mcp-fixture.ts` versus
  // `... --check`, and the same for regenerate-mcp-tool-fixture and
  // emit-trace-contract — so the write half's coverage is a fact this gate can
  // read off the manifest plus the corpus, rather than a sentence someone has
  // to keep true by hand. Deriving it also keeps the marker out of
  // `packages/wire/scripts/` and `packages/sdk/scripts/`, which unlike
  // `packages/twin-*/scripts/` are publish-relevant paths: a comment there
  // would demand version-only bumps of three published packages for a
  // byte-identical republish.
  //
  // DIRECTIONAL on purpose. Only the strict-superset direction holds: the
  // `--check` mode runs everything the write mode does and then asserts, so a
  // wired `--check` covers the write half's file. The reverse is false — a
  // wired WRITE mode regenerates the artifact and asserts nothing, so it must
  // never certify the `--check` verdict as covered. Sharing a file alone is
  // not enough; the argv is the difference between a verdict and a rewrite.
  const wiredCommands = entries.filter((e) => isWired(e, corpus)).map((e) => e.command);
  const coveredByWiredSuperset = (entry) =>
    wiredCommands.some((wired) => wired.startsWith(`${entry.command} `));

  const failures = [];
  const exemptions = [];
  for (const entry of entries) {
    if (isWired(entry, corpus)) continue;
    if (coveredByWiredSuperset(entry)) {
      exemptions.push({
        entry,
        reason: "write half of a command a wired sibling runs with more arguments (the --check verdict)",
        derived: true,
      });
      continue;
    }
    const reason = findExemptionReason(entry, root);
    if (reason) {
      exemptions.push({ entry, reason });
      continue;
    }
    failures.push(entry);
  }
  return { total: entries.length, failures, exemptions };
}

// Never `import.meta.main` (Node 24.2+; `undefined` on an earlier permitted
// `engines` version silently disables this whole gate) and never a bare
// `process.argv[1] === import.meta.url` string compare — node resolves
// symlinks before deriving `import.meta.url`, so an unresolved argv misses
// through a symlinked checkout. Both sides realpath'd.
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  const { total, failures, exemptions } = run(ROOT);
  for (const { entry, reason, derived } of exemptions) {
    console.log(`[${derived ? "covered" : "exempt"}] ${entry.pkgName} "${entry.scriptName}": ${reason}`);
  }
  if (failures.length > 0) {
    console.error(`${failures.length} package check script(s) are invoked by nothing:`);
    for (const entry of failures) {
      console.error(
        `  - ${entry.pkgName} "${entry.scriptName}" (packages/${entry.pkgDir}/package.json: ` +
          `"${entry.command}") — no workflow or root aggregate reaches it via ` +
          `\`npm run ${entry.scriptName} ... -w ${entry.pkgName}\`, and its script file carries ` +
          `no \`pome:unwired-ok(${entry.scriptName}): <reason>\` marker.`,
      );
    }
    process.exit(1);
  }
  console.log(
    `check-packages-scripts-wired: OK — ${total} non-lifecycle script(s) across packages/*, ` +
      `${exemptions.length} exempt, all wired or exempted.`,
  );
}
