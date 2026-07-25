// SPDX-License-Identifier: Apache-2.0
/**
 * shared-types-inventory — generate an exhaustive export x consumer inventory
 * for `packages/shared-types/src`, used to plan (and audit) the dissolution of
 * `@pome-sh/shared-types` into `@pome-sh/wire`, `@pome-sh/twin-github`, and
 * `cli/src/contract/`.
 *
 * Usage:
 *   node scripts/shared-types-inventory.mjs            # print markdown to stdout
 *   node scripts/shared-types-inventory.mjs --out FILE # write markdown to FILE
 *
 * Method: parse every module under packages/shared-types/src with the
 * TypeScript compiler API to collect its exported symbol names, then parse
 * every in-repo file that imports `@pome-sh/shared-types` (any subpath) and
 * attribute each imported specifier back to its owning leaf module.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "..");
const stRoot = path.join(repoRoot, "packages/shared-types/src");

function gitFiles(...args) {
  return execFileSync("git", ["-C", repoRoot, "ls-files", ...args], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
}

// ---------------------------------------------------------------- exports side

const moduleFiles = gitFiles("packages/shared-types/src").filter((f) => f.endsWith(".ts"));

/** module (repo-relative, without packages/shared-types/src/) -> Set<symbol> */
const exportsByModule = new Map();

function moduleKey(file) {
  return path.relative(stRoot, path.join(repoRoot, file));
}

for (const file of moduleFiles) {
  const sf = parse(path.join(repoRoot, file));
  const names = new Set();
  const visit = (node) => {
    const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (isExported) {
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) names.add(d.name.text);
        }
      } else if (node.name && ts.isIdentifier(node.name)) {
        names.add(node.name.text);
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      // `export { X } from "..."` / `export { X }`
      for (const el of node.exportClause.elements) names.add(el.name.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  exportsByModule.set(moduleKey(file), names);
}

/** symbol -> owning module(s) (barrels excluded so leaves win) */
const ownerBySymbol = new Map();
const BARRELS = new Set(["index.ts", "otel/index.ts", "otel/fixtures/index.ts"]);
for (const [mod, names] of exportsByModule) {
  if (BARRELS.has(mod)) continue;
  for (const n of names) {
    if (!ownerBySymbol.has(n)) ownerBySymbol.set(n, new Set());
    ownerBySymbol.get(n).add(mod);
  }
}

// -------------------------------------------------------------- consumers side

const candidateFiles = gitFiles().filter(
  (f) =>
    /\.(ts|tsx|mts|mjs|js)$/.test(f) &&
    !f.startsWith("packages/shared-types/") &&
    !f.startsWith("node_modules/"),
);

/** module -> Map<symbol, Set<consumerFile>> */
const usage = new Map();
/** consumerFile -> Set<module> */
const modulesByConsumer = new Map();
/** consumer files that import the package but where we could not attribute a symbol */
const unattributed = [];

function record(mod, symbol, file) {
  if (!usage.has(mod)) usage.set(mod, new Map());
  const m = usage.get(mod);
  if (!m.has(symbol)) m.set(symbol, new Set());
  m.get(symbol).add(file);
  if (!modulesByConsumer.has(file)) modulesByConsumer.set(file, new Set());
  modulesByConsumer.get(file).add(mod);
}

const SUBPATH_TO_MODULE = {
  "recorder-events": "recorder-events.ts",
  run: "run.ts",
  otel: "otel/index.ts",
  "otel/fixtures": "otel/fixtures/index.ts",
  redaction: "redaction.ts",
};

/** files that do `export * from "@pome-sh/shared-types"` — indirect hubs */
const starHubs = new Set();

for (const file of candidateFiles) {
  const abs = path.join(repoRoot, file);
  const text = readFileSync(abs, "utf8");
  if (!text.includes("@pome-sh/shared-types")) continue;
  const sf = parse(abs);
  let sawImport = false;
  const visit = (node) => {
    // `import("@pome-sh/shared-types").Foo` inline type imports
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal) &&
      node.argument.literal.text.startsWith("@pome-sh/shared-types")
    ) {
      sawImport = true;
      const symbol = node.qualifier && ts.isIdentifier(node.qualifier) ? node.qualifier.text : "<namespace>";
      const owner = ownerBySymbol.get(symbol);
      if (owner) for (const o of owner) record(o, symbol, file);
      else record("<UNRESOLVED>", symbol, file);
    }
    const spec =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
    if (spec && spec.startsWith("@pome-sh/shared-types")) {
      sawImport = true;
      const sub = spec.slice("@pome-sh/shared-types".length).replace(/^\//, "");
      const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
      const named = [];
      if (clause) {
        if (ts.isImportDeclaration(node)) {
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements)
              named.push((el.propertyName ?? el.name).text);
          }
          if (clause.name) named.push("<default>");
          if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
            named.push("<namespace>");
        } else if (ts.isNamedExports(clause)) {
          for (const el of clause.elements) named.push((el.propertyName ?? el.name).text);
        }
      }
      for (const symbol of named) {
        // Subpath imports are unambiguous; barrel imports resolve via ownership.
        if (sub && SUBPATH_TO_MODULE[sub]) {
          const target = SUBPATH_TO_MODULE[sub];
          const owner = ownerBySymbol.get(symbol);
          record(owner && owner.size === 1 ? [...owner][0] : target, symbol, file);
        } else {
          const owner = ownerBySymbol.get(symbol);
          if (owner && owner.size >= 1) {
            for (const o of owner) record(o, symbol, file);
          } else {
            record("<UNRESOLVED>", symbol, file);
          }
        }
      }
      if (named.length === 0) {
        if (ts.isExportDeclaration(node) && !node.exportClause) {
          starHubs.add(file);
          record("<star-reexport>", "*", file);
        } else {
          record(SUBPATH_TO_MODULE[sub] ?? "<side-effect>", "<none>", file);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  if (!sawImport) unattributed.push(file);
}

// ------------------------------------------------ indirect consumers via hubs
// `cli/src/types/shared.ts` is `export * from "@pome-sh/shared-types"`, so most
// CLI files consume the contract through it. Attribute those too.
/** module -> Map<symbol, Set<file>> for indirect (hub-mediated) usage */
const indirectUsage = new Map();
function recordIndirect(mod, symbol, file) {
  if (!indirectUsage.has(mod)) indirectUsage.set(mod, new Map());
  const m = indirectUsage.get(mod);
  if (!m.has(symbol)) m.set(symbol, new Set());
  m.get(symbol).add(file);
  if (!modulesByConsumer.has(file)) modulesByConsumer.set(file, new Set());
  modulesByConsumer.get(file).add(mod);
}

const hubAbs = new Set([...starHubs].map((f) => path.join(repoRoot, f).replace(/\.ts$/, "")));
for (const file of candidateFiles) {
  const abs = path.join(repoRoot, file);
  const text = readFileSync(abs, "utf8");
  if (!/types\/shared(\.js)?["']/.test(text)) continue;
  const sf = parse(abs);
  const visit = (node) => {
    const spec =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
    if (spec && spec.startsWith(".")) {
      const resolved = path.resolve(path.dirname(abs), spec).replace(/\.js$/, "");
      if (hubAbs.has(resolved)) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
        const named = [];
        if (clause) {
          if (ts.isImportDeclaration(node)) {
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
              for (const el of clause.namedBindings.elements)
                named.push((el.propertyName ?? el.name).text);
          } else if (ts.isNamedExports(clause)) {
            for (const el of clause.elements) named.push((el.propertyName ?? el.name).text);
          }
        }
        for (const symbol of named) {
          const owner = ownerBySymbol.get(symbol);
          if (owner) for (const o of owner) recordIndirect(o, symbol, file);
          else recordIndirect("<UNRESOLVED>", symbol, file);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
}

// ------------------------------------------------------------------- rendering

/** Destination decided by this lane; asserted against the generated usage. */
const DESTINATION = {
  "recorder-events.ts": "packages/wire",
  "redaction.ts": "packages/wire",
  "otel/event-schema.ts": "packages/wire",
  "otel/index.ts": "packages/wire",
  "otel/legacy-shim.ts": "packages/wire",
  "otel/map-span.ts": "packages/wire",
  "otel/nano.ts": "packages/wire",
  "otel/project.ts": "packages/wire",
  "otel/semconv.ts": "packages/wire",
  "otel/span-event.ts": "packages/wire",
  "otel/fixtures/data.ts": "packages/wire",
  "otel/fixtures/index.ts": "packages/wire",
  "github-access-control.ts": "packages/twin-github/src",
  "identity.ts": "cli/src/contract",
  "sessions.ts": "cli/src/contract",
  "seed-state.ts": "cli/src/contract",
  "seed-envelope.ts": "cli/src/contract",
  "task.ts": "cli/src/contract",
  "task-vocab.ts": "cli/src/contract",
  "rest.ts": "cli/src/contract",
  "run.ts": "cli/src/contract",
  "finalize-shapes.ts": "cli/src/contract",
  "manifest.ts": "cli/src/contract",
  "errors.ts": "DELETED (cloud-only)",
  "index.ts": "DELETED (barrel)",
  "<star-reexport>": "cli/src/types/shared.ts re-export hub (rewired to cli/src/contract + @pome-sh/wire)",
};

function consumerGroup(file) {
  if (file.startsWith("cli/")) return "cli";
  if (file.startsWith("packages/sdk/")) return "sdk";
  if (file.startsWith("packages/adapter-claude-sdk/")) return "adapter";
  const m = /^packages\/(twin-[a-z]+)\//.exec(file);
  if (m) return m[1];
  if (file.startsWith("contract/")) return "contract-suite";
  if (file.startsWith("scripts/")) return "scripts";
  if (file.startsWith("examples/")) return "examples";
  return "other";
}

const lines = [];
lines.push("# `@pome-sh/shared-types` export x consumer inventory");
lines.push("");
lines.push(
  "Generated by `node scripts/shared-types-inventory.mjs`. This file is authoritative " +
    "over prose mappings: every export below is attributed to the module that owns it and " +
    "to every in-repo file that imports it.",
);
lines.push("");
lines.push("## Per-module summary");
lines.push("");
lines.push(
  "| module | exports | used directly | used via `cli/src/types/shared.ts` | consumers | destination |",
);
lines.push("| --- | --- | --- | --- | --- | --- |");
const modKeys = [...exportsByModule.keys()].sort();

function symbolsOf(map, mod) {
  const m = map.get(mod);
  return m ? [...m.keys()].filter((k) => k !== "<none>") : [];
}

for (const mod of modKeys) {
  const total = exportsByModule.get(mod).size;
  const groups = new Set();
  for (const map of [usage, indirectUsage]) {
    const m = map.get(mod);
    if (m) for (const files of m.values()) for (const f of files) groups.add(consumerGroup(f));
  }
  lines.push(
    `| \`${mod}\` | ${total} | ${symbolsOf(usage, mod).length} | ${symbolsOf(indirectUsage, mod).length} | ${groups.size ? [...groups].sort().join(", ") : "**none**"} | ${DESTINATION[mod] ?? "?"} |`,
  );
}

lines.push("");
lines.push("## Per-module detail (export -> consumer files)");
lines.push("");
lines.push("Consumers marked `(hub)` reach the symbol through `cli/src/types/shared.ts`.");
for (const mod of modKeys) {
  lines.push("");
  lines.push(`### \`${mod}\` -> ${DESTINATION[mod] ?? "?"}`);
  const used = usage.get(mod);
  const indirect = indirectUsage.get(mod);
  const names = [...exportsByModule.get(mod)].sort();
  if (!used && !indirect) {
    lines.push("");
    lines.push(`No in-repo consumer imports any of its ${names.length} exports.`);
    continue;
  }
  lines.push("");
  lines.push("| export | consumers |");
  lines.push("| --- | --- |");
  for (const name of names) {
    const direct = [...(used?.get(name) ?? [])].sort().map((f) => `\`${f}\``);
    const via = [...(indirect?.get(name) ?? [])].sort().map((f) => `\`${f}\` (hub)`);
    const all = [...direct, ...via];
    lines.push(`| \`${name}\` | ${all.length ? all.join("<br>") : "_unused in repo_"} |`);
  }
  const declared = exportsByModule.get(mod);
  const extras = [...symbolsOf(usage, mod), ...symbolsOf(indirectUsage, mod)].filter(
    (k) => !declared.has(k),
  );
  if (extras.length > 0) {
    lines.push("");
    lines.push(`Imported but not declared here (re-export chain): ${[...new Set(extras)].join(", ")}`);
  }
}

if (starHubs.size > 0) {
  lines.push("");
  lines.push("## Star re-export hubs");
  lines.push("");
  for (const f of [...starHubs].sort()) {
    lines.push(`- \`${f}\` — \`export * from "@pome-sh/shared-types"\`; ${DESTINATION["<star-reexport>"]}`);
  }
}

if (usage.has("<UNRESOLVED>")) {
  lines.push("");
  lines.push("## UNRESOLVED symbols (no owning module found)");
  lines.push("");
  for (const [sym, files] of [...usage.get("<UNRESOLVED>")].sort()) {
    lines.push(`- \`${sym}\`: ${[...files].sort().join(", ")}`);
  }
}

lines.push("");
lines.push("## Consumers by package");
lines.push("");
const byGroup = new Map();
for (const [file, mods] of modulesByConsumer) {
  const g = consumerGroup(file);
  if (!byGroup.has(g)) byGroup.set(g, new Map());
  byGroup.get(g).set(file, mods);
}
for (const g of [...byGroup.keys()].sort()) {
  const dests = new Set();
  for (const mods of byGroup.get(g).values())
    for (const m of mods) dests.add(DESTINATION[m] ?? "?");
  lines.push(`- **${g}** (${byGroup.get(g).size} files) needs: ${[...dests].sort().join(", ")}`);
}

if (unattributed.length > 0) {
  lines.push("");
  lines.push("## Text-mentions only (no import statement)");
  lines.push("");
  for (const f of unattributed.sort()) lines.push(`- \`${f}\``);
}

const out = lines.join("\n") + "\n";
const outIdx = process.argv.indexOf("--out");
if (outIdx !== -1 && process.argv[outIdx + 1]) {
  writeFileSync(path.resolve(repoRoot, process.argv[outIdx + 1]), out);
} else {
  process.stdout.write(out);
}
