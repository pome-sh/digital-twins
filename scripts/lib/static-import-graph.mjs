// SPDX-License-Identifier: Apache-2.0
//
// Static import graph over a source tree, for rules that need reachability.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== char && source[cursor] !== "\n") {
        cursor += source[cursor] === "\\" ? 2 : 1;
      }
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

export function chainFor(file, importedBy, relativeTo) {
  const chain = [];
  for (let current = file; current; current = importedBy.get(current)) {
    chain.push(relativeTo(current));
  }
  return chain.reverse();
}
