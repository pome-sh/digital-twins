#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Release gate for @pome-sh/checks' tarball (F-1308).
//
// This package exists for exactly one reason: pome-cloud grades every `[code]`
// criterion out of these declarations, and it lives in a different repository.
// Every failure mode below is invisible from inside this workspace and lands in
// the consumer's repo instead.
//
//   1. `private: true` makes `npm publish -w` print a warning and EXIT 0. A
//      one-character regression would produce a fully green release that
//      published nothing — the silence `check-version-bump-required.mjs` exists
//      to abolish.
//   2. Inside this repo every `exports` subpath resolves through npm's workspace
//      symlink to a full source tree, so a subpath pointing at a file `files`
//      does not ship resolves forever here and dies as
//      ERR_PACKAGE_PATH_NOT_EXPORTED on the consumer's first import.
//   3. A leaked `@pome-sh/*` runtime dependency is fatal in a way it is not for
//      the CLI: `@pome-sh/sdk` and the five twins are `private: true` and NOT on
//      any registry at these versions, so the consumer's `npm i` 404s. Bundling
//      via tsup `noExternal` is what makes this package installable at all, and
//      this is the assertion that keeps it that way.
//   4. Bundling zod would be worse than a 404, because it succeeds: two copies
//      of zod means two schema identities, `instanceof` fails and parsed results
//      stop being interchangeable. That is the F-942 bug that dissolved
//      `@pome-sh/shared-types`, and nothing at runtime announces it.
//   5. Bundling the twin ENGINE (hono, node:sqlite, @hono/node-server) would
//      mean a "declarations only" package shipping an HTTP server and a database
//      driver. `packages/twin-stripe/src/seed.ts` reaches one zod schema that
//      `@pome-sh/sdk/server` also re-exports; importing the barrel instead of
//      `@pome-sh/sdk/failure-injection` pulls all 14 of the engine's runtime
//      modules, and nothing else would notice.
//   6. `defineCheck` and the vacuity sentinels must exist ONCE across the whole
//      tarball. Seven entries all reach `@pome-sh/sdk/checks`; without code
//      splitting each would carry its own copy, so `@pome-sh/checks/github`'s
//      `defineCheck` and `@pome-sh/checks/stripe`'s would be different function
//      objects — the same argument as 4, one layer in.
//
// Modes:
//   --manifest-only  Only what is readable from package.json (private, no
//                    publishConfig.registry, no @pome-sh/* runtime deps, zod is
//                    a peer). No build, no `npm pack`, no network — so ci.yml
//                    runs it on every PR and 1 and 3 are caught BEFORE merge.
//   (default)        The above, plus pack and audit the real tarball. Requires a
//                    built `packages/checks/dist`.
//
// Usage: node scripts/ci/check-checks-tarball.mjs [--manifest-only] [--keep]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEEP = process.argv.includes("--keep");
const MANIFEST_ONLY = process.argv.includes("--manifest-only");
const MANIFEST_PATH = join(ROOT, "packages", "checks", "package.json");

/** Bytes that mean the twin engine got inlined. `DatabaseSync` is node:sqlite's export. */
const ENGINE_MARKERS = ["node:sqlite", "DatabaseSync", "@hono/node-server", "hono/jwt"];

/**
 * Bare specifiers a shipped `.d.ts` may name. Everything else is unresolvable for
 * a consumer: `@pome-sh/*` because those packages are `private: true` and on no
 * registry, `hono` because it is not a dependency of this package.
 *
 * NOTE the quote-agnostic pattern. An earlier version of this gate matched only
 * double quotes and reported "no external specifiers" for a `dist/index.d.ts`
 * that was full of single-quoted ones — tsup emits single quotes. The gate was
 * green while the declarations were entirely broken.
 */
const DECLARATION_EXTERNALS_ALLOWED = (specifier) =>
  specifier === "zod" || specifier.startsWith("node:");
const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*)\(?\s*(['"])([^'"]+)\1/g;

/**
 * Blank out comments, preserving length, before looking for specifiers. Doc
 * comments contain quoted PROSE, and one of them — `could not tell "the path is
 * absent" from "the path holds null"` — parses as `from "the path holds null"`
 * and reds this gate over an English sentence. Any regex scanner over `.d.ts`
 * needs this; `packages/checks/scripts/bundle-declarations.mjs` carries the same
 * guard for the same reason.
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

const failures = [];
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

// ── Manifest assertions (no build, no network) ───────────────────────────────

// Stricter than npm on purpose: npm publishes a manifest with no `private` field
// quite happily, but the difference between "absent" and "explicitly false" is
// the difference between a silent regression and a loud one.
if (manifest.private !== false) {
  failures.push(
    `packages/checks/package.json has \`private: ${JSON.stringify(manifest.private)}\`; it must be exactly \`false\`.\n` +
      "    `private: true` is worse than a publish failure: `npm publish -w` skips a private\n" +
      "    workspace with a warning and EXITS 0, so the release goes green having published nothing.",
  );
}

// Registry is chosen by the publish job, not pinned in the manifest — this
// package goes to registry.npmjs.org via the OIDC lane, like the CLI and the
// adapter. A `publishConfig.registry` here could only misroute it.
if (manifest.publishConfig?.registry !== undefined) {
  failures.push(
    `packages/checks/package.json pins \`publishConfig.registry\` to ${JSON.stringify(manifest.publishConfig.registry)}.\n` +
      "    Leave it unset: release.yml's publish job targets registry.npmjs.org, and a pinned\n" +
      "    registry here can only send it somewhere else.",
  );
}

if (manifest.publishConfig?.access !== "public") {
  failures.push(
    "packages/checks/package.json needs `publishConfig.access: \"public\"` — a scoped package\n" +
      "    defaults to restricted, and a restricted publish to a scope without a paid plan fails\n" +
      "    with E402 after the version bump has already merged.",
  );
}

// The whole point of the bundling strategy.
for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  const internal = Object.keys(manifest[field] ?? {}).filter((name) =>
    name.startsWith("@pome-sh/"),
  );
  if (internal.length > 0) {
    failures.push(
      `packages/checks/package.json declares @pome-sh/* in \`${field}\`: ${internal.join(", ")}.\n` +
        "    @pome-sh/sdk and the five twins are `private: true` and are not on any registry at\n" +
        "    these versions, so a consumer's `npm i` would 404. They must stay devDependencies,\n" +
        "    inlined by tsup `noExternal`.",
    );
  }
}

if (manifest.peerDependencies?.zod === undefined) {
  failures.push(
    "packages/checks/package.json must declare `zod` as a peerDependency.\n" +
      "    The seed schemas and `defineCheck` are zod values. A bundled or duplicated zod means\n" +
      "    two schema identities in the consumer's process (F-942) — and unlike a 404, it works\n" +
      "    just well enough to be found later.",
  );
}

/** Every file path an `exports` map points at, conditions and subpaths flattened. */
function exportTargets(exportsField) {
  const targets = new Set();
  const walk = (node) => {
    if (typeof node === "string") targets.add(node.replace(/^\.\//, ""));
    else if (node && typeof node === "object") for (const value of Object.values(node)) walk(value);
  };
  walk(exportsField);
  return targets;
}

// `main`/`types` are the pre-`exports` resolution path; older tooling still
// reads them, so they have to ship too.
const declaredPaths = exportTargets(manifest.exports);
for (const field of ["main", "types"]) {
  if (typeof manifest[field] === "string") declaredPaths.add(manifest[field].replace(/^\.\//, ""));
}
declaredPaths.delete("package.json"); // always in the tarball; not a build output

// ── Tarball assertions ──────────────────────────────────────────────────────

function auditTarball() {
  const workDirectory = mkdtempSync(join(tmpdir(), "pome-checks-tarball-"));
  try {
    // --ignore-scripts: `prepublishOnly` would rebuild, which would hide a
    // "published a stale dist" bug. The caller is expected to have built.
    const packed = execFileSync(
      "npm",
      ["pack", "-w", "@pome-sh/checks", "--ignore-scripts", "--pack-destination", workDirectory],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const tarballName = readdirSync(workDirectory).find((file) => file.endsWith(".tgz"));
    if (!tarballName) {
      failures.push(`\`npm pack -w @pome-sh/checks\` produced no tarball:\n${packed}`);
      return;
    }
    const tarball = join(workDirectory, tarballName);
    console.log(`packed ${tarballName}`);

    const hardLinks = execFileSync("tar", ["-tvf", tarball], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.startsWith("h"));
    if (hardLinks.length > 0) {
      failures.push(
        `tarball contains hard links — the registry rejects these (E415):\n${hardLinks.join("\n")}`,
      );
    }

    // npm wraps every tarball entry in a top-level `package/` directory.
    const shipped = new Set(
      execFileSync("tar", ["-tf", tarball], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim().replace(/^package\//, ""))
        .filter(Boolean),
    );

    const missing = [...declaredPaths].filter((path) => !shipped.has(path));
    if (missing.length > 0) {
      failures.push(
        "these paths are declared in packages/checks/package.json (`exports`/`main`/`types`)\n" +
          "    but are NOT in the tarball, so a consumer's import dies with\n" +
          "    ERR_PACKAGE_PATH_NOT_EXPORTED:\n" +
          missing.map((path) => `      - ${path}`).join("\n"),
      );
    }

    const sourcemaps = [...shipped].filter((path) => path.endsWith(".map"));
    if (sourcemaps.length > 0) {
      failures.push(
        `tarball contains ${sourcemaps.length} dangling sourcemap(s) — no \`src/\` ships, so they\n` +
          "    resolve to nothing for a consumer. `files` should keep excluding `!dist/**/*.map`:\n" +
          sourcemaps.map((path) => `      - ${path}`).join("\n"),
      );
    }

    // Read the real shipped bytes, not the workspace's dist: `files` negations
    // and `.npmignore` are exactly the kind of thing that makes the two differ.
    const extractDirectory = mkdtempSync(join(tmpdir(), "pome-checks-extract-"));
    execFileSync("tar", ["-xf", tarball, "-C", extractDirectory], { stdio: "inherit" });
    const packageRoot = join(extractDirectory, "package");

    const packedManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const internal = Object.keys(packedManifest[field] ?? {}).filter((name) =>
        name.startsWith("@pome-sh/"),
      );
      if (internal.length > 0) {
        failures.push(
          `the PACKED manifest declares @pome-sh/* in \`${field}\`: ${internal.join(", ")}`,
        );
      }
    }

    const jsFiles = readdirSync(join(packageRoot, "dist"), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".js"))
      .map((file) => join(packageRoot, "dist", file));
    const sources = new Map(jsFiles.map((file) => [file, readFileSync(file, "utf8")]));

    // 5 — the engine must not be inlined.
    for (const marker of ENGINE_MARKERS) {
      const hits = [...sources].filter(([, text]) => text.includes(marker)).map(([file]) => file);
      if (hits.length > 0) {
        failures.push(
          `the tarball contains \`${marker}\`, so the twin ENGINE was inlined into a\n` +
            "    declarations-only package. Something reached `@pome-sh/sdk/server` (14 runtime\n" +
            "    modules) where `@pome-sh/sdk/failure-injection` (2) would do:\n" +
            hits.map((file) => `      - ${file}`).join("\n"),
        );
      }
    }

    // 4 — zod stays external. A bundled zod shows up as its own internals.
    const zodInlined = [...sources]
      .filter(([, text]) => /\bclass \$?ZodObject\b|\$ZodType\b/.test(text))
      .map(([file]) => file);
    if (zodInlined.length > 0) {
      failures.push(
        "zod appears to be INLINED into the tarball rather than left external:\n" +
          zodInlined.map((file) => `      - ${file}`).join("\n") +
          "\n    Two zod copies means two schema identities in the consumer's process (F-942).",
      );
    }
    const importsZod = [...sources.values()].some((text) => /from\s*['"]zod['"]/.test(text));
    if (!importsZod) {
      failures.push(
        "no shipped module imports `zod`. Either the schemas stopped being zod values or zod\n" +
          "    got bundled — both change what the consumer's `.parse()` returns.",
      );
    }

    // The declarations must be self-contained. `noExternal` does not cover them:
    // the declaration bundler leaves bare specifiers alone, so `export … from
    // "@pome-sh/twin-github/checks"` lands verbatim in the shipped `.d.ts` and
    // resolves nowhere for a consumer. `packages/checks/scripts/
    // bundle-declarations.mjs` rewrites them; this is the tarball-side check that
    // it ran and covered everything.
    //
    // The authoritative test is the consumer COMPILE in
    // scripts/clean-room-pack-test.mjs, which catches type errors this cannot
    // see. This is the cheap string-level half, so a regression is named here
    // even when the heavier gate is not the thing that ran.
    const declarationFiles = readdirSync(join(packageRoot, "dist"), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".d.ts"))
      .map((file) => join(packageRoot, "dist", file));
    const unresolvable = [];
    for (const file of declarationFiles) {
      const text = maskComments(readFileSync(file, "utf8"));
      for (const [, , specifier] of text.matchAll(SPECIFIER_PATTERN)) {
        if (specifier.startsWith(".")) continue;
        if (DECLARATION_EXTERNALS_ALLOWED(specifier)) continue;
        unresolvable.push(`${relative(packageRoot, file)} -> ${specifier}`);
      }
    }
    if (unresolvable.length > 0) {
      failures.push(
        `${unresolvable.length} shipped declaration specifier(s) a consumer cannot resolve ` +
          "(TS2307, and every symbol behind an `export *` from one goes missing too):\n" +
          unresolvable.map((entry) => `      - ${entry}`).join("\n"),
      );
    }
    if (declarationFiles.length === 0) {
      failures.push("the tarball ships no .d.ts at all — the declaration build did not run.");
    }

    // 6 — exactly one copy of the DSL.
    for (const [marker, label] of [
      ["function defineCheck", "defineCheck"],
      ['"pome-vacuity-never"', "VACUITY_SENTINEL"],
    ]) {
      const hits = [...sources].filter(([, text]) => text.includes(marker)).map(([file]) => file);
      if (hits.length > 1) {
        failures.push(
          `${label} is defined in ${hits.length} shipped modules; it must be exactly one.\n` +
            "    Two copies means `@pome-sh/checks/github` and `@pome-sh/checks/stripe` hand out\n" +
            "    different objects for the same declaration primitive. `splitting: true` in\n" +
            "    tsup.config.ts is what keeps it to one:\n" +
            hits.map((file) => `      - ${file}`).join("\n"),
        );
      } else if (hits.length === 0) {
        failures.push(`${label} is in NO shipped module — the DSL did not make it into dist.`);
      }
    }

    if (failures.length === 0) {
      console.log(
        `  ✓ ${declaredPaths.size} declared path(s) ship; no engine bytes, zod external, ` +
          "one copy of the DSL, self-contained declarations, no hard links, no dangling sourcemaps",
      );
    }
    if (!KEEP) rmSync(extractDirectory, { recursive: true, force: true });
    else console.log(`--keep: extracted tarball left at ${extractDirectory}`);
  } finally {
    if (KEEP) console.log(`--keep: left the packed tarball in ${workDirectory}`);
    else rmSync(workDirectory, { recursive: true, force: true });
  }
}

if (!MANIFEST_ONLY) auditTarball();

if (failures.length > 0) {
  console.error(`\n@pome-sh/checks ${MANIFEST_ONLY ? "manifest" : "tarball"} audit FAILED:`);
  for (const failure of failures) console.error(`\n  - ${failure}`);
  process.exit(1);
}

console.log(
  MANIFEST_ONLY
    ? "@pome-sh/checks manifest audit passed — private: false, access public, zero @pome-sh/* runtime deps, zod is a peer."
    : "@pome-sh/checks tarball audit passed — installable with no @pome-sh/* dependency, no engine inlined, one zod, one DSL, declarations resolve without the workspace.",
);
