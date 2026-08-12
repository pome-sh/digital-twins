#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1472 — closes the class F-1354 found one instance of: a `packages/*` npm
// script that names itself a check (`validate:mcp`) declared in a
// package.json and invoked by NOTHING. It went red for weeks with no
// verdict, and no verdict reads exactly like a pass.
//
// The rule: every `packages/*/package.json` script whose name matches the
// check vocabulary below (`validate:*`, `check:*`, `lint:*`, `gate:*`,
// `test:*`, `assert:*`) must be reachable from a workflow or a root aggregate
// script — textually, as `npm run <script> ... -w <package-name>` — or it
// fails this gate by name. Deliberately NOT a bare "test"/"typecheck"/"build":
// those are the standard lifecycle scripts every package has, wired uniformly
// through `--workspaces --if-present` or an explicit `-w` list, and are a
// different, already-solved problem from the ad hoc `verb:noun` checks this
// ticket is about.
//
// NO CENTRAL ALLOWLIST. A script deliberately exempt from this gate carries
// its own reason inline, in the source file its package.json command invokes
// — a line matching `pome:unwired-ok: <reason>` — and this gate reads that
// file rather than a list here. A list of which checks are exempt is the same
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

const CHECK_VOCAB = /^(?:validate|check|lint|gate|test|assert):/;
const EXEMPTION_MARKER = /pome:unwired-ok:\s*(.+)/;

/** Every `packages/*` script whose name matches the check vocabulary. */
export function findCheckScripts(root) {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];
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
      if (!CHECK_VOCAB.test(scriptName)) continue;
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
  const re = new RegExp(
    `npm run ${escapeRe(entry.scriptName)}\\b[^\\n]*-w\\s+${escapeRe(entry.pkgName)}(\\s|$)`,
  );
  return re.test(corpus);
}

/**
 * Reads the exemption reason straight from the file the script's own command
 * invokes, never from a list here. Returns null if the command names no
 * resolvable file, the file doesn't exist, or it carries no marker.
 */
export function findExemptionReason(entry, root) {
  const fileMatch = entry.command.match(/([\w./-]+\.(?:ts|mjs|js|sh))/);
  if (!fileMatch) return null;
  const scriptPath = resolve(root, "packages", entry.pkgDir, fileMatch[1]);
  if (!existsSync(scriptPath)) return null;
  let content;
  try {
    content = readFileSync(scriptPath, "utf8");
  } catch {
    return null;
  }
  const marker = content.match(EXEMPTION_MARKER);
  return marker ? marker[1].trim() : null;
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
  return parts.join("\n");
}

export function run(root) {
  const entries = findCheckScripts(root);
  const corpus = readCorpus(root);
  const failures = [];
  const exemptions = [];
  for (const entry of entries) {
    if (isWired(entry, corpus)) continue;
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
  for (const { entry, reason } of exemptions) {
    console.log(`[exempt] ${entry.pkgName} "${entry.scriptName}": ${reason}`);
  }
  if (failures.length > 0) {
    console.error(`${failures.length} package check script(s) matched the check vocabulary but are invoked by nothing:`);
    for (const entry of failures) {
      console.error(
        `  - ${entry.pkgName} "${entry.scriptName}" (packages/${entry.pkgDir}/package.json: ` +
          `"${entry.command}") — no workflow or root aggregate reaches it via ` +
          `\`npm run ${entry.scriptName} ... -w ${entry.pkgName}\`, and its script file carries ` +
          `no "pome:unwired-ok:" exemption.`,
      );
    }
    process.exit(1);
  }
  console.log(
    `check-packages-scripts-wired: OK — ${total} check-vocabulary script(s) across packages/*, ` +
      `${exemptions.length} exempt, all wired or exempted.`,
  );
}
