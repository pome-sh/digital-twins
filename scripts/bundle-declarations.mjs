#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Emits bundled `.d.ts` for packages whose types tsup cannot resolve through a
// barrel. `dts.resolve` does not work here; ~50 symbols, most of them types, and a
// type alias cannot be laundered through a const.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const extraExternals = new Set();
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--external") {
    const value = argv[i + 1];
    if (!value) throw new Error("--external needs a specifier");
    extraExternals.add(value);
    i += 1;
  } else positional.push(argv[i]);
}
if (positional.length !== 1) {
  throw new Error(
    "usage: bundle-declarations.mjs <package-root> [--external <specifier>]…\n" +
      "  <package-root> is resolved against the cwd; a workspace `build` script passes `.`.",
  );
}

const PACKAGE_ROOT = resolve(process.cwd(), positional[0]);
const PACKAGES_ROOT = resolve(PACKAGE_ROOT, "..");
const DIST = join(PACKAGE_ROOT, "dist");
const VENDOR_DIRECTORY = join(DIST, "_types");
const SCOPE = "@pome-sh/";

if (!existsSync(DIST)) {
  throw new Error(`${DIST} does not exist — run tsup before this script.`);
}

const KEEP_EXTERNAL = (specifier) =>
  specifier === "zod" ||
  specifier.startsWith("node:") ||
  extraExternals.has(specifier) ||
  [...extraExternals].some((external) => specifier.startsWith(`${external}/`));

const SPECIFIER_PATTERN = /(\bfrom\s*|\bimport\s*)(\(\s*)?(['"])([^'"]+)\3/g;

function maskComments(text) {
  const out = text.split("");
  let index = 0;
  while (index < text.length) {
    const two = text.slice(index, index + 2);
    if (two === "//") {
      while (index < text.length && text[index] !== "\n") out[index++] = " ";
    } else if (two === "/*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      while (index < stop) {
        if (text[index] !== "\n") out[index] = " ";
        index += 1;
      }
    } else if (text[index] === '"' || text[index] === "'") {
      const quote = text[index++];
      while (index < text.length && text[index] !== quote) {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
    } else index += 1;
  }
  return out.join("");
}

function specifiersIn(text) {
  const masked = maskComments(text);
  const found = [];
  for (const match of masked.matchAll(SPECIFIER_PATTERN)) {
    found.push({
      index: match.index,
      length: match[0].length,
      keyword: match[1],
      paren: match[2],
      quote: match[3],
      specifier: match[4],
    });
  }
  return found;
}

function packageDirectory(packageName) {
  return join(PACKAGES_ROOT, packageName.slice(SCOPE.length));
}

function resolveDeclaration(specifier) {
  const segments = specifier.slice(SCOPE.length).split("/");
  const packageName = SCOPE + segments[0];
  const subpath = segments.length > 1 ? `./${segments.slice(1).join("/")}` : ".";
  const directory = packageDirectory(packageName);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

  const entry = manifest.exports?.[subpath];
  let target = typeof entry === "string" ? entry : entry?.types;
  if (!target && subpath === ".") target = manifest.types;
  if (!target) {
    throw new Error(
      `${specifier} names no \`types\` target in ${packageName}'s exports map. ` +
        `Add one, or stop re-exporting it from ${relative(PACKAGES_ROOT, PACKAGE_ROOT)}.`,
    );
  }
  const file = resolve(directory, target);
  if (!existsSync(file)) {
    throw new Error(`${specifier} resolves to ${file}, which does not exist — build ${packageName} first.`);
  }
  return { packageName, file, packageDistRoot: resolve(directory, "dist") };
}

function vendorPathFor(packageName, file, packageDistRoot) {
  const within = relative(packageDistRoot, file);
  return join(VENDOR_DIRECTORY, packageName.slice(SCOPE.length), within);
}

const vendored = new Map(); // absolute source .d.ts -> absolute vendored path
const queue = [];

function enqueueFile(packageName, file, packageDistRoot) {
  if (!vendored.has(file)) {
    const destination = vendorPathFor(packageName, file, packageDistRoot);
    vendored.set(file, destination);
    queue.push({ file, destination, packageDistRoot, packageName });
  }
  return vendored.get(file);
}

function enqueue(specifier) {
  const { packageName, file, packageDistRoot } = resolveDeclaration(specifier);
  return enqueueFile(packageName, file, packageDistRoot);
}

function enqueueRelative(specifier, sourceFile, packageName, packageDistRoot) {
  const base = resolve(dirname(sourceFile), specifier).replace(/\.js$/, "");
  for (const candidate of [`${base}.d.ts`, join(base, "index.d.ts")]) {
    if (existsSync(candidate)) {
      enqueueFile(packageName, candidate, packageDistRoot);
      return;
    }
  }
  throw new Error(
    `${relative(PACKAGES_ROOT, sourceFile)} imports "${specifier}", which resolves to no .d.ts ` +
      `(tried ${base}.d.ts and ${join(base, "index.d.ts")}).`,
  );
}

function relativeSpecifier(fromFile, toFile) {
  let rel = relative(dirname(fromFile), toFile).split(/[\\/]/).join(posix.sep);
  rel = rel.replace(/\.d\.ts$/, ".js");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function rewrite(text, containingFile, source) {
  let out = "";
  let cursor = 0;
  for (const m of specifiersIn(text)) {
    const { index, length, keyword, paren, quote, specifier } = m;
    let replacement = text.slice(index, index + length);
    if (specifier.startsWith(".")) {
      if (source) {
        enqueueRelative(specifier, source.file, source.packageName, source.packageDistRoot);
      }
    } else if (specifier.startsWith(SCOPE) && !KEEP_EXTERNAL(specifier)) {
      const target = enqueue(specifier);
      replacement = `${keyword}${paren ?? ""}${quote}${relativeSpecifier(containingFile, target)}${quote}`;
    }
    out += text.slice(cursor, index) + replacement;
    cursor = index + length;
  }
  return out + text.slice(cursor);
}

const entryDeclarations = readdirSync(DIST)
  .filter((name) => name.endsWith(".d.ts"))
  .map((name) => join(DIST, name));

if (entryDeclarations.length === 0) {
  throw new Error("no .d.ts files in dist/ — did the dts build run?");
}

for (const file of entryDeclarations) {
  writeFileSync(file, rewrite(readFileSync(file, "utf8"), file, null));
}

let copied = 0;
while (queue.length > 0) {
  const item = queue.shift();
  const { file, destination } = item;
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, rewrite(readFileSync(file, "utf8"), destination, item));
  copied += 1;
}

const leaked = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".d.ts")) {
      const text = readFileSync(path, "utf8");
      for (const { specifier } of specifiersIn(text)) {
        if (specifier.startsWith(".")) {
          const base = resolve(dirname(path), specifier).replace(/\.js$/, "");
          const found = [`${base}.d.ts`, join(base, "index.d.ts")].some((c) => existsSync(c));
          if (!found) leaked.push(`${relative(DIST, path)} -> ${specifier} (not shipped)`);
        } else if (!KEEP_EXTERNAL(specifier)) {
          leaked.push(`${relative(DIST, path)} -> ${specifier} (not an allowed external)`);
        }
      }
    }
  }
};
walk(DIST);
if (leaked.length > 0) {
  throw new Error(
    `declarations are NOT self-contained — ${leaked.length} specifier(s) a consumer cannot resolve:\n  ` +
      leaked.join("\n  "),
  );
}

console.log(
  `declarations are self-contained: ${entryDeclarations.length} entry file(s), ` +
    `${copied} vendored into dist/_types/`,
);
