// SPDX-License-Identifier: Apache-2.0
//
// The static import graph of this repo's TypeScript sources, read from the
// sources themselves.
//
// Extracted from `twin-chunks.mjs` when a second gate
// needed the same walk: `twin-leaves.mjs` asks which twin
// modules can still be loaded by a runtime without `node:sqlite`. Both ask a
// reachability question about the same graph, and two hand-rolled copies of an
// import lexer would be two chances to disagree about what a type-only import
// is.
//
// Dependency-free and build-free on purpose: it reads TypeScript sources and
// each package's real `exports` map, so it runs in CI's always-on block before
// `npm ci`, and it cannot disagree with the bundler about which subpath
// resolves where.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Workspace `@pome-sh/*` specifiers → source file, read from each package's
 *  own `exports` map so a renamed subpath cannot silently stop being checked. */
export function buildSpecifierMap(root) {
  const map = new Map();
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return map;
  for (const dir of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.name?.startsWith("@pome-sh/")) continue;
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      // `{ types, default }` conditions or a bare string; either way we want the
      // JS target, then map `dist/src/foo.js` (or `dist/foo.js`) back to source.
      const js = typeof target === "string" ? target : target.default;
      if (typeof js !== "string" || !js.endsWith(".js")) continue;
      const sourceRel = js
        .replace(/^\.\//, "")
        .replace(/^dist\/(?:src\/)?/, "src/")
        .replace(/\.js$/, ".ts");
      const sourcePath = join(packagesDir, dir, sourceRel);
      if (!existsSync(sourcePath)) continue;
      const specifier = subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
      map.set(specifier, sourcePath);
    }
  }
  return map;
}

/**
 * Blank out comments and string/template bodies, keeping newlines so the text
 * stays line-addressable.
 *
 * Load-bearing, not hygiene: `cli/src/cli/init-sdk.ts` embeds the scaffolded
 * agent's SOURCE in a template literal, and that source contains
 * `import { query, tool, withPome } from "@pome-sh/adapter-claude-sdk";`. A
 * regex over raw text reads that as a real edge and reports a package the CLI
 * never imports — and by the same mistake would report a twin root as eager
 * because a scaffold string mentions one. Scaffolds are the one place this repo
 * writes import statements it does not execute, and it writes several.
 */
export function stripNonCode(source) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === "`") {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== "`") {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      const stop = Math.min(cursor + 1, source.length);
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      // Copied through VERBATIM rather than blanked — a module specifier lives
      // in one of these, and the callers' patterns read it — but consumed as one
      // unit so nothing inside can open a comment or a template literal.
      //
      // Not cosmetic. `twin-stripe/src/session.ts` mounts middleware at
      // `session.use("/x402/*", …)`, and `twin-stripe/src/errors.ts` (a named
      // cross-runtime leaf) describes a surface as `"Stripe-shaped REST under
      // /v1/*"`. Scanning those character by character reads the `/*` as a
      // block-comment opener and blanks everything up to the next `*/` — 37
      // lines in session.ts, the rest of the file in errors.ts. Every import
      // below the opener then vanishes, so a reachability gate reports the file
      // as clean and a portability gate as safe. A false GREEN, which is the
      // failure mode these gates exist to prevent.
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== char && source[cursor] !== "\n") {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
      // An unterminated string (only reachable in invalid source) stops at the
      // newline, so one bad line can never swallow the rest of the file.
      const stop = source[cursor] === char ? Math.min(cursor + 1, source.length) : cursor;
      out += source.slice(index, stop);
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Runtime static import specifiers in one TypeScript source.
 *
 * Type-only edges are EXCLUDED because they are erased before the bundler sees
 * them — both the `import type` / `export type` form and the form where every
 * named binding is individually marked (`import { type A, type B } from …`).
 * Counting either would fail a gate on an edge that emits no code, which is
 * the failure mode that gets a gate deleted rather than fixed.
 *
 * `import()` is EXCLUDED because a dynamic import is a deferred edge: it is the
 * thing the laziness gate wants, and it is not executed at module load, which
 * is what the portability gate asks about.
 *
 * The clause is matched with the characters an import clause can actually
 * contain (`[\w$*,{}\s]` — identifiers, `as`, `type`, braces, a namespace star)
 * rather than `[\s\S]`. Anything else would let one match span two statements:
 * `export const x = 1;` on one line and a real `import … from …` on the next
 * matched as a SINGLE clause, which both mis-reads the first statement as an
 * edge AND consumes the second, so the real import is never seen. A gate that
 * reports the wrong edge is annoying; one that silently stops seeing a real one
 * is the failure mode these gates exist to prevent.
 */
export function staticImportSpecifiers(rawSource) {
  const source = stripNonCode(rawSource);
  const found = [];
  const pattern =
    /^[ \t]*(?:import|export)\b([\w$*,{}\s]*?)from\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[2] ?? match[3];
    const clause = match[1] ?? "";
    if (/^\s*type\b/.test(clause)) continue;
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      const named = braced[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const hasDefaultOrNamespace = /^\s*(?:[A-Za-z_$][\w$]*\s*,|\*)/.test(clause);
      if (named.length > 0 && !hasDefaultOrNamespace && named.every((n) => /^type\s/.test(n))) {
        continue;
      }
    }
    found.push(specifier);
  }
  return found;
}

/** A specifier → the `.ts` source it resolves to, or null for third-party
 *  packages, node builtins and JSON asset imports. */
export function resolveSpecifier(specifier, fromFile, specifiers) {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(fromFile), specifier);
    const candidates = base.endsWith(".js")
      ? [`${base.slice(0, -3)}.ts`]
      : [base, `${base}.ts`, join(base, "index.ts")];
    return candidates.find((candidate) => existsSync(candidate) && candidate.endsWith(".ts")) ?? null;
  }
  return specifiers.get(specifier) ?? null;
}

/**
 * Every `.ts` file statically reachable from `entries`, each mapped to the file
 * that first pulled it in — so a violation can be reported as a chain a human
 * can follow — plus every specifier that resolved to no file in this repo
 * (node builtins, third-party packages, JSON assets), recorded with the file
 * that imported it.
 *
 * @param entries absolute paths to seed the walk with.
 * @param specifiers the map from {@link buildSpecifierMap}.
 */
export function reachable(entries, specifiers) {
  const importedBy = new Map();
  const external = [];
  const stack = [];
  for (const entry of entries) {
    if (importedBy.has(entry)) continue;
    importedBy.set(entry, null);
    stack.push(entry);
  }
  while (stack.length > 0) {
    const file = stack.pop();
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of staticImportSpecifiers(source)) {
      const target = resolveSpecifier(specifier, file, specifiers);
      if (target === null) {
        external.push({ from: file, specifier });
        continue;
      }
      if (importedBy.has(target)) continue;
      importedBy.set(target, file);
      stack.push(target);
    }
  }
  return { importedBy, external };
}

/** The import chain that first pulled `file` in, root-first, as repo-relative
 *  paths. */
export function chainFor(file, importedBy, relativeTo) {
  const chain = [];
  for (let current = file; current; current = importedBy.get(current)) {
    chain.push(relativeTo(current));
  }
  return chain.reverse();
}
