#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Makes the emitted declarations SELF-CONTAINED. Sequenced AFTER tsup by this
// package's `build` script — deliberately not tsup's `onSuccess`, which fires
// when the JS build finishes while the declaration build is still running in a
// separate worker, so it would rewrite files that are then overwritten.
//
// ── The bug this exists to fix ───────────────────────────────────────────────
//
// `noExternal` governs the JS bundle only. tsup's declaration bundler
// (rollup-plugin-dts) keeps bare specifiers external, so `export … from
// "@pome-sh/twin-github/checks"` in src emits that specifier VERBATIM into
// `dist/index.d.ts`. Those packages are `private: true` and on no registry, so
// for an external consumer the specifier resolves nowhere: `tsc` reports
// TS2307 for each one, and — because the DSL arrives through
// `export * from "@pome-sh/sdk/checks"` — every symbol behind it is missing
// entirely, TS2305, even under `skipLibCheck`. `defineCheck`, `renderCheck`,
// `checkPattern`, `checksDigest`, `templateSlots`, `statePath`,
// `childStatePath` and the `Check` type — the surface the README calls the main
// event — were all unreachable. The JS import works fine, so nothing fails
// until a consumer runs `tsc`.
//
// This is the same root cause PR #324 hit for the adapter's `CORRELATION_HEADER`
// re-export. That fix was a local `const` re-export, which works for ONE value
// whose literal type the emitter can widen inline. It does not generalise: this
// package re-exports ~50 symbols, most of them TYPES, and a type alias cannot be
// laundered through a `const`.
//
// `dts: { resolve: … }` is the documented escape hatch and does NOT work here —
// verified with `true`, with a `[/^@pome-sh\//]` regex, and with exact specifier
// strings. All three produced byte-identical output, because the twins expose
// their declarations through an `exports` map subpath (`"./checks"` →
// `"types": "./dist/src/checks.d.ts"`) and rollup-plugin-dts does not follow the
// `types` condition of a subpath export.
//
// ── What it does instead ─────────────────────────────────────────────────────
//
// Vendors the `.d.ts` closure into `dist/_types/<package>/…`, preserving each
// source package's own dist layout so the relative imports BETWEEN those files
// keep resolving untouched, and rewrites every bare `@pome-sh/*` specifier — in
// the entry declarations and in the vendored files — to a relative path.
//
// `zod` and `node:*` are deliberately left external: zod is a peerDependency and
// vendoring its types would reintroduce the two-identities problem
// (`scripts/ci/check-checks-tarball.mjs` asserts it stays external).
//
// This is a build step over generated output, not a second copy of anything
// checked in: `dist/` is gitignored and regenerated from the twins on every
// build, so it cannot drift from them.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_ROOT = resolve(PACKAGE_ROOT, "..");
const DIST = join(PACKAGE_ROOT, "dist");
const VENDOR_DIRECTORY = join(DIST, "_types");
const SCOPE = "@pome-sh/";

/** Bare specifiers that must STAY bare. zod is a peer; node: builtins are builtins. */
const KEEP_EXTERNAL = (specifier) => specifier === "zod" || specifier.startsWith("node:");

/**
 * Every specifier form that can appear in a `.d.ts`: `from "x"`, bare
 * `import "x"`, and — the one the first version of this script missed —
 * INLINE import types, `import("./auth.js").SessionValue`, which tsc emits for
 * inferred types and which carried an unvendored `./auth.js` all the way to the
 * consumer's `tsc`. The optional-paren group is what covers it.
 */
const SPECIFIER_PATTERN = /(\bfrom\s*|\bimport\s*)(\(\s*)?(['"])([^'"]+)\3/g;

/**
 * A same-length copy of `text` with every comment blanked to spaces.
 *
 * Scanning the raw text matches quoted PROSE inside comments — a doc comment
 * reading `could not tell "the path is absent" from "the path holds null"`
 * parsed as `from "the path holds null"` and got reported as an unresolvable
 * specifier. Masking keeps byte offsets identical, so matches found here can be
 * spliced straight into the original.
 */
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
      // Skip over a real string literal so a `//` inside it is not treated as a
      // comment (e.g. a URL in a default value).
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

/** Every specifier match in `text`, ignoring comments, with byte offsets. */
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

/** `@pome-sh/twin-github` → `packages/twin-github`. */
function packageDirectory(packageName) {
  return join(PACKAGES_ROOT, packageName.slice(SCOPE.length));
}

/**
 * Resolve a bare `@pome-sh/*` specifier to the `.d.ts` file it names, through the
 * owning package's own `exports` map — the same `types` condition a consumer's
 * `tsc` would follow, which is precisely what rollup-plugin-dts skipped.
 */
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
        `Add one, or stop re-exporting it from @pome-sh/checks.`,
    );
  }
  const file = resolve(directory, target);
  if (!existsSync(file)) {
    throw new Error(`${specifier} resolves to ${file}, which does not exist — build ${packageName} first.`);
  }
  return { packageName, file, packageDistRoot: resolve(directory, "dist") };
}

/** Where a vendored file lands: dist/_types/<pkg>/<path within that pkg's dist>. */
function vendorPathFor(packageName, file, packageDistRoot) {
  const within = relative(packageDistRoot, file);
  return join(VENDOR_DIRECTORY, packageName.slice(SCOPE.length), within);
}

const vendored = new Map(); // absolute source .d.ts -> absolute vendored path
const queue = [];

/** Register a source `.d.ts` for vendoring; returns its vendored path. */
function enqueueFile(packageName, file, packageDistRoot) {
  if (!vendored.has(file)) {
    const destination = vendorPathFor(packageName, file, packageDistRoot);
    vendored.set(file, destination);
    queue.push({ file, destination, packageDistRoot, packageName });
  }
  return vendored.get(file);
}

/** Register a bare `@pome-sh/*` specifier; returns its vendored path. */
function enqueue(specifier) {
  const { packageName, file, packageDistRoot } = resolveDeclaration(specifier);
  return enqueueFile(packageName, file, packageDistRoot);
}

/**
 * A relative specifier inside a vendored file points at a sibling declaration in
 * the SAME source package. The layout under `_types/<pkg>/` mirrors that
 * package's dist, so the specifier text needs no change — but the file it names
 * has to be vendored too, or the consumer gets TS2307 one level in. Following
 * these is what makes the closure a closure rather than just its first level.
 */
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

/** A relative specifier, POSIX-separated, `.js`-suffixed for NodeNext resolution. */
function relativeSpecifier(fromFile, toFile) {
  let rel = relative(dirname(fromFile), toFile).split(/[\\/]/).join(posix.sep);
  rel = rel.replace(/\.d\.ts$/, ".js");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Rewrite every bare `@pome-sh/*` specifier in `text` to a relative path from
 * `containingFile`, vendoring the target if it is not already queued.
 */
function rewrite(text, containingFile, source) {
  let out = "";
  let cursor = 0;
  for (const m of specifiersIn(text)) {
    const { index, length, keyword, paren, quote, specifier } = m;
    let replacement = text.slice(index, index + length);
    if (specifier.startsWith(".")) {
      // Only meaningful inside a vendored file: an entry declaration's relative
      // imports already point at its own siblings in dist/.
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

// ── Pass 1: the entry declarations tsup emitted ──────────────────────────────
const entryDeclarations = readdirSync(DIST)
  .filter((name) => name.endsWith(".d.ts"))
  .map((name) => join(DIST, name));

if (entryDeclarations.length === 0) {
  throw new Error("no .d.ts files in dist/ — did the dts build run?");
}

for (const file of entryDeclarations) {
  writeFileSync(file, rewrite(readFileSync(file, "utf8"), file, null));
}

// ── Pass 2: drain the closure, rewriting as we copy ──────────────────────────
let copied = 0;
while (queue.length > 0) {
  const item = queue.shift();
  const { file, destination } = item;
  mkdirSync(dirname(destination), { recursive: true });
  // Rewritten relative to the DESTINATION, since that is where it will resolve
  // from. Same-package relative imports keep their text (the layout under
  // `_types/<pkg>/` mirrors that package's dist) but are followed, so the whole
  // closure lands rather than just its first level.
  writeFileSync(destination, rewrite(readFileSync(file, "utf8"), destination, item));
  copied += 1;
}

// ── Assert the result is actually self-contained ─────────────────────────────
// Everything a consumer's `tsc` will try to resolve, checked the way it would.
// Anything but a shipped relative file or an allowlisted external is a build
// failure here rather than a TS2307 in someone else's repo.
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
          // `hono`, `@pome-sh/sdk`, a DOM lib type — none is a dependency of this
          // package, so none can resolve for a consumer.
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
