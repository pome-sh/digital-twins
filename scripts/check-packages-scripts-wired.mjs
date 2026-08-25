#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// A packages/* or cli/ script that names itself a check and is invoked by nothing
// produces no verdict, and no verdict reads like a pass. Total partition: lifecycle,
// wired as `npm run <name> -w <pkg>`, or carrying its own `pome:unwired-ok` marker.
// Only that one calling convention is recognised, so a direct `tsx <path>` step is a
// deliberate false red whose fix is to declare it as a script.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();

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
  "pome",
]);

function exemptionMarkerFor(scriptName) {
  return new RegExp(`pome:unwired-ok\\(${escapeRe(scriptName)}\\):[ \\t]*(\\S[^\\n]*)`);
}

export function findCheckScripts(root) {
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

export function isWired(entry, corpus) {
  const script = escapeRe(entry.scriptName);
  const pkg = escapeRe(entry.pkgName);
  const nameEnd = "(?![\\w:.-])";
  const pkgEnd = "(?![\\w:./@-])";
  const ws = `(?:-w|--workspace)[=\\s]+${pkg}${pkgEnd}`;
  const gap = "(?:(?!--)[^\\n])*";
  const re = new RegExp(
    `npm run(?:-script)? (?:${ws}${gap}${script}${nameEnd}|${script}${nameEnd}${gap}${ws})`,
  );
  return re.test(corpus);
}

export function findExemptionReason(entry, root) {
  const scriptPath = invokedFile(entry, root);
  if (!scriptPath) return null;
  return readMarkerFromFile(scriptPath, entry.scriptName);
}

const SELF_EXCLUDED = new Set([
  "check-packages-scripts-wired.mjs",
  "check-packages-scripts-wired.test.mjs",
]);

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

export function invokedFile(entry, root) {
  const fileMatch = entry.command.match(/(?:^|\s)([\w./-]+\.(?:ts|mts|cts|tsx|mjs|cjs|js|sh))(?=\s|$)/);
  if (!fileMatch) return null;
  const pkgRoot = entry.pkgKind === "cli" ? resolve(root, "cli") : resolve(root, "packages", entry.pkgDir);
  const scriptPath = resolve(pkgRoot, fileMatch[1]);
  if (scriptPath !== pkgRoot && !scriptPath.startsWith(`${pkgRoot}/`)) return null;
  return existsSync(scriptPath) ? scriptPath : null;
}

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

const SCRIPT_FILE_RE = /\.(?:mjs|js|cjs|ts|mts|cts|tsx|sh)$/;
const TEST_FILE_RE = /\.test\.[mc]?[jt]sx?$/;
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

function resolveRelativeImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.(?:js|mjs|cjs)$/, ".ts"),
    base.replace(/\.(?:js|mjs|cjs)$/, ".tsx"),
    base.replace(/\.(?:js|mjs|cjs)$/, ".mts"),
    base.replace(/\.(?:js|mjs|cjs)$/, ".cts"),
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
    }
  }

  const importedBySibling = new Set();
  for (const file of files) {
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
  const cliPackageScripts = findCliPackageScripts(root);
  const fileEntries = findCliOrphanFileEntries(root);
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

  const wired = entries.filter((e) => isWired(e, corpus));
  const coveredByWiredSuperset = (entry) =>
    wired.some(
      (w) =>
        w.pkgKind === entry.pkgKind &&
        w.pkgDir === entry.pkgDir &&
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
