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
//
// F-1476 — `cli/` extension. F-1472 scoped this gate to `packages/*`; `cli/`
// is a root workspace member too (AGENTS.md) and had the identical shape:
// `gate:no-eval`, `gate:no-native`, `gate:recorder-overhead` and `test:e2e`
// declared, only `check:manifest-schema` reached. Same total partition, same
// three-way split (lifecycle / wired / marker), same marker syntax — no
// second mechanism, no exemption list, just a second package.json to read.
//
// `cli/` also has raw executable files under `cli/scripts/*` that are not
// declared as ANY npm script. The motivating instance was
// `cli/scripts/make-unwired-fixture.mjs` (deleted by F-1476, so do not go
// looking for it): broken on `main` — a stale exact-text replacement threw
// before it did anything — reached by nothing, and invisible to a denominator
// built only from npm SCRIPT NAMES. So `cli/`'s denominator is the union of
// (a) `cli/package.json`'s own non-lifecycle scripts, audited exactly like
// `packages/*`, and (b) every file under `cli/scripts/**` that is neither the
// invoked file of a declared `cli/package.json` script NOR imported by a
// sibling file in `cli/scripts/**` — an imported file is a library module,
// covered by whatever imports it, and if THAT importer is itself dead, IT is
// what shows up here, which is the more actionable diagnosis. A file in (b)
// has no script name for the `npm run <name> -w <pkg>` regex to find, so the
// only coverage it can have is being one of (a)'s invoked files (already
// excluded) or being imported by a sibling — anything left is wired via its
// own `pome:unwired-ok(<relpath>): <reason>` marker or it fails, the same
// marker mechanism as everywhere else in this file, keyed by the file's path
// instead of a script name. Note what that does NOT say: a file invoked
// DIRECTLY by a workflow step is not covered either, see the next paragraph.
//
// ONE CALLING CONVENTION, AND IT IS A FALSE RED, NOT A BLIND SPOT. `isWired`
// recognises `npm run <name> ... -w <pkg>` and nothing else. A workflow that
// invokes a declared script's FILE directly — `run: npx tsx
// scripts/overhead-gate.ts` — is a real, running check that this gate reds
// anyway, by name, saying "no workflow reaches it". Verified by hand against
// that exact shape. Three of `agent-trace-overhead-gate.yml`'s steps were
// written that way and F-1476 converted all three to `npm run <name> -w
// @pome-sh/cli` rather than teach the gate a second wiring shape, because one
// detection mechanism is the whole reason the marker path can be trusted.
// The cost is real and is accepted deliberately: the NEXT person who adds a
// direct `tsx <path>` step gets a red whose diagnosis names the fix (declare
// it as a script and call it the standard way), so the failure is loud and
// self-correcting rather than silent. If that ever stops being the right
// trade, the fix is to also scan the corpus for the script's resolved file
// path — not to add an exemption list.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();

/**
 * The uniform lifecycle scripts, matched by EXACT name. `test`, `start`,
 * `prepare`, `prepack`, `prepublishOnly` and `postinstall` are npm's own;
 * `build`, `dev` and `typecheck` are this repo's convention, not something npm
 * defines, and it is worth saying so rather than claiming npm closes the set.
 *
 * What makes the list safe is not who owns the names but that each is reached
 * WITHOUT the `-w <package>` shape below, uniformly across every workspace:
 * root `typecheck` is `npm run typecheck --workspaces --if-present`, root
 * `test` is a bare `vitest run` against the one root `vitest.config.ts` whose
 * project list is DISCOVERED from `packages/*` (so a new package's tests are
 * picked up without an edit there or here), root `build` is
 * `scripts/build.mjs` over the whole
 * workspace graph, `prepack`/`prepare`/`prepublishOnly`/`postinstall` are npm's
 * own pack/publish/install hooks, and `dev`/`start` are runtime entry points
 * that assert nothing.
 *
 * It is still a list, and that is the residual: a check smuggled in under the
 * exact name `dev` or `typecheck` would be skipped. It is a far smaller and
 * far less load-bearing list than the check-name PREFIX vocabulary it replaced
 * — nine exact names that already exist in every package, versus an open set of
 * every prefix someone might invent for a new check — but it is not zero. The
 * set is shared by `packages/*` and `cli/` (F-1476 widened the denominator to
 * both), so adding `pome` for `cli/`'s sake also exempts that exact name in a
 * `packages/*` member; same accepted residual, one more name.
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
  // `pome` is cli/package.json's own equivalent of npm's `start` — it runs
  // the BUILT tarball entry point (`node dist/src/cli/main.js`) with no
  // assertion, the identical reasoning `dev`/`start` get above. Scoped into
  // this shared set rather than a per-package list because that residual
  // ("a check smuggled in under an exempt name is skipped") is already
  // accepted for the other nine, and this repo has exactly one `cli/`.
  "pome",
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
        pkgKind: "packages",
        pkgDir: entry.name,
        pkgName: pkg.name ?? entry.name,
        scriptName,
        command: String(command),
      });
    }
  }
  return found;
}

/**
 * F-1476 — the same enumeration as `findCheckScripts`, for `cli/`'s own
 * `package.json` instead of every `packages/*` member. `cli/` is a single
 * root workspace member (AGENTS.md), not a directory of them, so this reads
 * one file rather than looping a directory. Returns `[]` if `cli/package.json`
 * is absent — real for this repo's own `cli/` never happens (it is a
 * committed root workspace member), and the "wrong cwd" failure mode this
 * gate must never silently pass on is already caught by `findCheckScripts`'s
 * hard throw on a missing `packages/` dir, which runs from the same root.
 */
export function findCliPackageScripts(root) {
  const pkgJsonPath = join(root, "cli", "package.json");
  if (!existsSync(pkgJsonPath)) return [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  } catch {
    return []; // not this gate's problem — package.json validity is checked elsewhere
  }
  const found = [];
  for (const [scriptName, command] of Object.entries(pkg.scripts ?? {})) {
    if (LIFECYCLE_SCRIPTS.has(scriptName)) continue;
    found.push({
      pkgKind: "cli",
      pkgDir: "cli",
      pkgName: pkg.name ?? "cli",
      scriptName,
      command: String(command),
    });
  }
  return found;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does the ROOT manifest declare `cli` a workspace member? This is what makes
 * the cli/ floor in `run()` derived rather than hardcoded: the same source npm
 * itself reads decides whether cli/ is expected to contribute entries, so a
 * `packages/*`-only repo (and this suite's own cases 1-24, which write no root
 * package.json) is not held to a floor it has no subject for.
 */
function declaresCliWorkspace(root) {
  const rootPkgJson = join(root, "package.json");
  if (!existsSync(rootPkgJson)) return false;
  try {
    const pkg = JSON.parse(readFileSync(rootPkgJson, "utf8"));
    const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
    return workspaces.some((glob) => glob === "cli" || glob === "cli/" || glob === "./cli");
  } catch {
    return false;
  }
}

/**
 * A script is "wired" if some corpus of text (workflow YAML, root
 * package.json, root scripts/) contains `npm run <script> ... -w
 * <package>` on one line — the shape every existing wired check in this
 * repo uses (see ci.yml's `npm run validate:mcp -w @pome-sh/twin-github`).
 */
export function isWired(entry, corpus) {
  const script = escapeRe(entry.scriptName);
  const pkg = escapeRe(entry.pkgName);
  // `(?![\w:.-])`, never `\b`: `-` and `:` are non-word characters, so `\b`
  // after `gate:mcp` matches inside `gate:mcp-fixture`. A package declaring
  // both would have had the longer script's real CI line certify the shorter
  // one as wired while nothing ran it — the F-1354 shape, produced by the gate
  // meant to catch it. Same guard on the package name, so `@pome-sh/twin-slack`
  // is not wired by a line naming `@pome-sh/twin-slack-legacy`.
  const nameEnd = "(?![\\w:.-])";
  const pkgEnd = "(?![\\w:./@-])";
  // `npm run` and `npm run-script` are the same command; the workspace can be
  // `-w X` or `--workspace X` or `--workspace=X`, and can come BEFORE or AFTER
  // the script name. Accepting only one of those six spellings meant a
  // genuinely-wired check went red the first time someone reformatted the line
  // — a false red with a diagnosis pointing at the wrong thing. ci.yml's
  // 180-char five-workspace `fidelity:parity` line is the obvious candidate.
  const ws = `(?:-w|--workspace)[=\\s]+${pkg}${pkgEnd}`;
  // A `--` ends npm's own options: in `npm run x -- -w pkg` the `-w` is passed
  // to the SCRIPT, npm selects no workspace, and the command runs in the root.
  // That is not wiring, so the gap before the workspace must not contain `--`.
  const gap = "(?:(?!--)[^\\n])*";
  const re = new RegExp(
    `npm run(?:-script)? (?:${ws}${gap}${script}${nameEnd}|${script}${nameEnd}${gap}${ws})`,
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
  return readMarkerFromFile(scriptPath, entry.scriptName);
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
    .filter((line) => !/^\s*(#|\/\/|\/\*|\*)/.test(line))
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
  // Whole-token, never a substring. Unanchored, `[\w./-]+\.(?:ts|mjs|js|sh)`
  // matches `tsconfig.js` INSIDE the literal `tsconfig.json`, so
  // `tsx --tsconfig tsconfig.json scripts/x.ts` resolved to a config file
  // instead of the script. Under F-1472 that only cost a missed exemption
  // marker; under F-1476 it also keeps the real script out of
  // `invokedByScript`, so the file reds as an orphan with a diagnosis
  // pointing at the wrong file entirely.
  const fileMatch = entry.command.match(/(?:^|\s)([\w./-]+\.(?:ts|mts|cts|tsx|mjs|cjs|js|sh))(?=\s|$)/);
  if (!fileMatch) return null;
  // F-1476 — `cli/` is a single workspace member at `cli/`, not one of many
  // under `packages/<name>`, so it resolves against a different base.
  const pkgRoot = entry.pkgKind === "cli" ? resolve(root, "cli") : resolve(root, "packages", entry.pkgDir);
  const scriptPath = resolve(pkgRoot, fileMatch[1]);
  if (scriptPath !== pkgRoot && !scriptPath.startsWith(`${pkgRoot}/`)) return null;
  return existsSync(scriptPath) ? scriptPath : null;
}

/**
 * Reads the `pome:unwired-ok(<name>): <reason>` marker straight out of a
 * file's own bytes, shared by both the script-command path
 * (`findExemptionReason`, below) and the raw-file path (F-1476's
 * `cli/scripts/**` entries, which have no command to derive a file from —
 * the file IS the entry).
 */
function readMarkerFromFile(filePath, name) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const marker = content.match(exemptionMarkerFor(name));
  return marker ? marker[1].trim() : null;
}

// `.mts`/`.cts` included deliberately: `lint-no-bare-import-meta-main.mjs`
// next door scans them, and a file this pattern misses is invisible to the
// denominator — the exact class the file-level pass exists to close, so the
// two extension sets must not disagree.
const SCRIPT_FILE_RE = /\.(?:mjs|js|cjs|ts|mts|cts|tsx|sh)$/;
const TEST_FILE_RE = /\.test\.[mc]?[jt]sx?$/;
// All four specifier forms, not just `from "…"`: a side-effect `import "./x"`,
// a dynamic `await import("./x")` and `require("./x")` each make the target a
// live library module just as much as a named import does, and treating one as
// an orphan is a FALSE red whose suggested remedy (add an unwired-ok marker)
// would be a lie recorded in the file.
const RELATIVE_IMPORT_RE =
  /\bfrom\s*["'](\.[^"']+)["']|\b(?:require|import)\(\s*["'](\.[^"']+)["']\s*\)|\bimport\s+["'](\.[^"']+)["']/g;

function listScriptFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listScriptFilesRecursive(abs));
    } else if (SCRIPT_FILE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

/** Resolve a relative import specifier against the extensionless-.ts-behind-.js
 * convention this codebase's scripts use (`import ... from "./overhead-stats.js"`
 * resolving to the committed `overhead-stats.ts`). */
function resolveRelativeImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.(?:js|mjs|cjs)$/, ".ts"),
    base.replace(/\.(?:js|mjs|cjs)$/, ".tsx"),
    base.replace(/\.(?:js|mjs|cjs)$/, ".mts"),
    base.replace(/\.(?:js|mjs|cjs)$/, ".cts"),
    // Extensionless and directory/index specifiers. Without these a live
    // `from "./overhead-stats"` or `from "./lib"` leaves its target looking
    // like a dead entry point — a false red, and the marker it would prompt
    // for would be a false statement in the file.
    ...(/\.[a-z]+$/.test(base)
      ? []
      : [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"].flatMap((ext) => [
          `${base}${ext}`,
          join(base, `index${ext}`),
        ])),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * F-1476 — every file under `cli/scripts/**` that is neither the invoked
 * file of a declared `cli/package.json` script (any of them, including
 * LIFECYCLE ones — `prepublishOnly` reaching `assert-publishable.mjs` counts
 * as reached) nor imported by a sibling file in the same tree. What is left
 * is a candidate entry point exactly like the deleted `make-unwired-fixture.mjs`: no
 * script name names it, so it cannot be "wired" the way a package.json
 * script can — it can only carry its own exemption marker or fail.
 */
export function findCliOrphanFileEntries(root) {
  const scriptsDir = join(root, "cli", "scripts");
  if (!existsSync(scriptsDir)) return [];
  const files = listScriptFilesRecursive(scriptsDir);

  const invokedByScript = new Set();
  const pkgJsonPath = join(root, "cli", "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      for (const [scriptName, command] of Object.entries(pkg.scripts ?? {})) {
        const filePath = invokedFile({ pkgKind: "cli", pkgDir: "cli", scriptName, command: String(command) }, root);
        if (filePath) invokedByScript.add(filePath);
      }
    } catch {
      // not this gate's problem — package.json validity is checked elsewhere
    }
  }

  const importedBySibling = new Set();
  for (const file of files) {
    // Same `stripCommentLines` the corpus gets, and for the same reason:
    // commenting a line out is how a thing stops happening, and a plain text
    // scan otherwise counts the dead line as proof it still does. Here the
    // consequence is a file-level exemption — a commented-out
    // `// import { x } from "./dead.js";` would certify `dead.js` as a live
    // library module covered by its importer, which is exactly the
    // no-verdict-reads-as-a-pass shape this gate exists to catch.
    const text = stripCommentLines(readFileSync(file, "utf8"));
    RELATIVE_IMPORT_RE.lastIndex = 0;
    let match;
    while ((match = RELATIVE_IMPORT_RE.exec(text)) !== null) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const resolved = resolveRelativeImport(file, specifier);
      if (resolved) importedBySibling.add(resolved);
    }
  }

  const cliRoot = join(root, "cli");
  const entries = [];
  for (const file of files) {
    if (invokedByScript.has(file)) continue;
    if (importedBySibling.has(file)) continue;
    entries.push({
      isFileEntry: true,
      pkgKind: "cli",
      pkgDir: "cli",
      pkgName: "@pome-sh/cli",
      scriptName: relative(cliRoot, file).replaceAll("\\", "/"),
      filePath: file,
    });
  }
  return entries;
}

export function run(root) {
  // F-1476 — cli/'s own non-lifecycle scripts join packages/*'s in ONE array,
  // so the derived write/--check coverage below (same `pkgDir`, same command
  // shape) applies to cli/'s `emit:manifest-schema`/`check:manifest-schema`
  // pair with no new code — it is the identical shape three packages/* pairs
  // already use.
  const cliPackageScripts = findCliPackageScripts(root);
  const fileEntries = findCliOrphanFileEntries(root);
  // A FLOOR for the cli/ half, derived from the root manifest rather than
  // assumed. `findCheckScripts` hard-throws on a missing `packages/` because a
  // zero-entry scan exits 0 having asserted nothing; the cli/ half had no
  // equivalent, so renaming `cli/` or `cli/scripts/` would have dropped eight
  // entries and stayed green — coverage silently shrinking, which is the shape
  // this milestone exists to kill and which `lint:import-meta-main` already
  // makes a hard failure PER ROOT. Derived, not listed: if the root
  // `workspaces` array names `cli`, the cli/ denominator must be non-empty. A
  // repo whose workspaces do not name `cli` legitimately contributes nothing.
  if (cliPackageScripts.length + fileEntries.length === 0 && declaresCliWorkspace(root)) {
    throw new Error(
      `root package.json declares "cli" a workspace member, but the cli/ half of this gate's ` +
        `denominator is EMPTY — no non-lifecycle cli/package.json script and no cli/scripts/** ` +
        `entry point. Either cli/ moved (update this gate) or its scripts vanished; a zero-entry ` +
        `scan would exit 0 having asserted nothing about cli/.`,
    );
  }
  const entries = [...findCheckScripts(root), ...cliPackageScripts];
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
  const wired = entries.filter((e) => isWired(e, corpus));
  const coveredByWiredSuperset = (entry) =>
    wired.some(
      (w) =>
        // Same package. `wiredCommands` was flat, and twin-gmail and twin-slack
        // both declare `fixture:mcp = tsx scripts/adopt-upstream-mcp-fixture.ts`
        // — two DIFFERENT files with one command string — so unwiring gmail's
        // `gate:mcp-fixture` left gmail's write half certified by slack's file.
        // `pkgKind` too, not `pkgDir` alone: `cli/` entries carry
        // `pkgDir: "cli"`, so a future `packages/cli` member would collide with
        // it and each one's wired `--check` half would certify the OTHER's
        // write half — the same cross-package certification hole the
        // twin-gmail/twin-slack `fixture:mcp` case put this guard here for.
        w.pkgKind === entry.pkgKind &&
        w.pkgDir === entry.pkgDir &&
        // Exactly `--check`, not "any extra argv". The claim being made is that
        // the verdict mode runs everything the write mode does and then
        // asserts; `startsWith(cmd + " ")` also let a wired
        // `dev:foo = node scripts/foo.mjs --watch` certify an unwired
        // `check:foo`, which asserts nothing.
        w.command === `${entry.command} --check`,
    );

  const failures = [];
  const exemptions = [];
  for (const entry of entries) {
    if (isWired(entry, corpus)) continue;
    if (coveredByWiredSuperset(entry)) {
      exemptions.push({
        entry,
        reason: "write half of a command the same package's wired sibling runs with --check (the verdict half)",
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

  // F-1476 — cli/scripts/** files nothing declares as a script at all
  // (the deleted make-unwired-fixture.mjs's shape). No script name exists for these, so
  // the only way to clear one is the marker, read straight from the file.
  for (const entry of fileEntries) {
    const reason = readMarkerFromFile(entry.filePath, entry.scriptName);
    if (reason) {
      exemptions.push({ entry, reason });
    } else {
      failures.push(entry);
    }
  }

  return { total: entries.length + fileEntries.length, failures, exemptions };
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
      if (entry.isFileEntry) {
        console.error(
          `  - cli/${entry.scriptName} — not the invoked file of any cli/package.json ` +
            `script, not imported by any sibling file under cli/scripts/**, and it carries ` +
            `no \`pome:unwired-ok(${entry.scriptName}): <reason>\` marker.`,
        );
        continue;
      }
      const manifestPath = entry.pkgKind === "cli" ? "cli/package.json" : `packages/${entry.pkgDir}/package.json`;
      console.error(
        `  - ${entry.pkgName} "${entry.scriptName}" (${manifestPath}: ` +
          `"${entry.command}") — no workflow or root aggregate reaches it via ` +
          `\`npm run ${entry.scriptName} ... -w ${entry.pkgName}\`, and its script file carries ` +
          `no \`pome:unwired-ok(${entry.scriptName}): <reason>\` marker.`,
      );
    }
    process.exit(1);
  }
  console.log(
    `check-packages-scripts-wired: OK — ${total} non-lifecycle script(s)/entry point(s) across ` +
      `packages/* and cli/, ${exemptions.length} exempt, all wired or exempted.`,
  );
}
