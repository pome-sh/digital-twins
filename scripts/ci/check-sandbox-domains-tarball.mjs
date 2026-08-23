#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Release gate for @pome-sh/sandbox-domains' tarball.
//
// This package exists for one reason: pome-cloud boots the twin domain layer
// IN-PROCESS as its grading/authoring runtime (`lib/twin-state.ts`), and
// `checks-package-drift.test.ts` compares that runtime's binding surface
// against `@pome-sh/checks`'s vocabulary with no allowlist. Every failure mode
// below is invisible from inside this workspace and lands in the consumer's
// repo instead.
//
// ── Why this is not check-checks-tarball.mjs with a different path ───────────
//
// The two packages are cut from the same twins and ship on the same lane, and
// three of their assertions are deliberately INVERTED. Reading this file as a
// copy of that one will get the inversions wrong:
//
//   - checks FORBIDS engine bytes (`node:sqlite`, `hono`): a declarations-only
//     package shipping a database driver means something reached
//     `@pome-sh/sdk/server` where a narrow subpath would do. This package IS
//     the engine's domain half, so it REQUIRES `node:sqlite` (assertion 6) —
//     a sandbox-domains tarball with no SQLite driver is a second declarations
//     package that silently cannot open a database.
//   - checks forbids `hono` outright. Here hono is a declared, external,
//     ordinary dependency: each domain arrives through its twin's package
//     ROOT, which is also where `defineTwin()` runs at module scope, and
//     `./server` re-exports `toTwinHttpEventRow` from `@pome-sh/sdk/server`.
//     Measured on the real bundle: `hono`, `hono/jwt`, `hono/request`.
//   - checks asserts `defineCheck` exists exactly once. The shared primitive
//     here is the sdk's SQLite layer, so assertion 7 counts that instead.
//
// What is NOT inverted, and is the same fatal shape in both: a leaked
// `@pome-sh/*` runtime dependency (assertion 3). The sdk and the five twins are
// `private: true` and on no registry at these versions, so the consumer's
// `npm i` 404s. Bundling via tsup `noExternal` is what makes this package
// installable at all.
//
// ── Assertions 4 and 5 are the ones that earn their keep ────────────────────
//
// The ticket's own instruction was "do not assume; the tarball gate asserts the
// final dependency set either way". So rather than a hand-kept allowlist of
// permitted externals, this reads every bare specifier out of the SHIPPED bytes
// — JS and `.d.ts` both — and requires each to be a node: builtin, the zod
// peer, or a declared runtime dependency (4). Then it requires the converse:
// every declared dependency is actually imported (5). Without 5 the manifest
// can name a package nothing uses, which a consumer still installs and still
// audits — `@hono/node-server` was exactly that here until this gate said so.
//
// Modes:
//   --manifest-only  Only what is readable from package.json (private, no
//                    publishConfig.registry, no @pome-sh/* runtime deps, zod is
//                    a peer, the upstream anchors match the twins'). No build,
//                    no `npm pack`, no network — so ci.yml runs it on every PR.
//   (default)        The above, plus pack and audit the real tarball. Requires
//                    a built `packages/sandbox-domains/dist`.
//
// Usage: node scripts/ci/check-sandbox-domains-tarball.mjs [--manifest-only] [--keep]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEEP = process.argv.includes("--keep");
const MANIFEST_ONLY = process.argv.includes("--manifest-only");
const PACKAGE_DIRECTORY = join(ROOT, "packages", "sandbox-domains");
const MANIFEST_PATH = join(PACKAGE_DIRECTORY, "package.json");

/**
 * The export spec, measured from pome-cloud's own imports rather than
 * designed fresh: `apps/control-plane/src/lib/twin-state.ts`,
 * `checks-package-drift.test.ts`, `lib/twin-tape-pull.ts` and
 * `apps/mcp/src/lib/capture.ts`. A subpath that stops exporting one of these
 * does not fail to build here — it fails in the consumer's repo, which is the
 * whole reason the list is duplicated into a gate.
 */
const REQUIRED_EXPORTS = {
  "./github": ["GitHubDomain", "openGitHubCloneDatabase", "parseSeed", "GITHUB_CHECKS"],
  "./gmail": ["GmailDomain", "openGmailTwinDatabase", "parseSeed", "GMAIL_CHECKS"],
  "./linear": ["LinearDomain", "openLinearTwinDatabase", "parseSeed", "LINEAR_CHECKS"],
  "./slack": ["SlackDomain", "openSlackTwinDatabase", "parseSeed", "SLACK_CHECKS"],
  "./stripe": [
    "StripeDomain",
    "openTwinStripeDatabase",
    "parseSeed",
    "applySeed",
    "STRIPE_CHECKS",
  ],
  "./server": ["toTwinHttpEventRow"],
};

/**
 * Type-only anchors the twins hold as devDependencies for shape fidelity, which
 * this package must hold as real `dependencies` because they reach its SHIPPED
 * `.d.ts` (`GitHubDomain.pullRequestStack(): PullRequestStack`,
 * `StripeDomain`'s `PaymentIntent[…]` field types). Unlike `@pome-sh/*` these
 * are public and resolvable, so declaring them is correct and vendoring 4.6 MB
 * of generated OpenAPI types into every tarball is not.
 *
 * The specs must EQUAL the twins' own: the declarations shipped here were
 * generated against those versions, so a range that admits a different one is a
 * claim this build never checked.
 */
const UPSTREAM_ANCHORS = {
  "@octokit/openapi-types": "packages/twin-github/package.json",
  stripe: "packages/twin-stripe/package.json",
};

/** node: builtins and the zod peer resolve for any consumer without being declared. */
const ALWAYS_RESOLVABLE = (specifier) => specifier === "zod" || specifier.startsWith("node:");

/** `hono/jwt` is satisfied by a declared `hono`; compare on the package name. */
function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Blank out comments, preserving length, before looking for specifiers. Doc
 * comments contain quoted PROSE, and one of them — `could not tell "the path is
 * absent" from "the path holds null"` — parses as `from "the path holds null"`
 * and reds this gate over an English sentence. Any regex scanner over shipped
 * source needs this; `scripts/bundle-declarations.mjs` carries the same guard.
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

/**
 * Every module specifier in a shipped `.d.ts`. Covers `from "x"`, bare
 * `import "x"`, and inline import types (`import("./auth.js").SessionValue`),
 * which tsc emits for inferred types — the form the first version of
 * `bundle-declarations.mjs` missed and shipped unvendored. A declaration file
 * carries prose only in COMMENTS, which `maskComments` handles, so the loose
 * `\bfrom\s*"…"` form is safe here.
 */
const DECLARATION_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*)\(?\s*(['"])([^'"]+)\1/g;

/**
 * Every module specifier in a shipped `.js` — and deliberately NOT the pattern
 * above, which cannot be used on bundled JS.
 *
 * `maskComments` blanks comments but only SKIPS string literals (it has to:
 * blanking them would destroy the specifiers themselves). Bundled twin code is
 * full of SQL and English inside strings, and the loose pattern read
 * `m.to_json AS "…"`, `") return contains(document.from);"` and
 * `"…sent to everyone, some of them twice"` as import specifiers — reporting
 * a dozen phantom undeclared "packages" named after fragments of prose.
 *
 * tsup emits ESM with every static `import`/`export … from` at the start of a
 * line, so anchoring to line-start is both precise and complete for this
 * output. Dynamic `import("x")` is matched separately: it needs the literal
 * `import(` prefix, which prose does not produce.
 */
const JS_STATIC_IMPORT_PATTERN = /^\s*(?:import|export)\b[^;\n]*?\bfrom\s*(['"])([^'"]+)\1/gm;
const JS_BARE_IMPORT_PATTERN = /^\s*import\s*(['"])([^'"]+)\1/gm;
const JS_DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

function specifiersIn(text, kind) {
  const masked = maskComments(text);
  const patterns =
    kind === "js"
      ? [JS_STATIC_IMPORT_PATTERN, JS_BARE_IMPORT_PATTERN, JS_DYNAMIC_IMPORT_PATTERN]
      : [DECLARATION_SPECIFIER_PATTERN];
  const found = [];
  for (const pattern of patterns) {
    for (const [, , specifier] of masked.matchAll(pattern)) found.push(specifier);
  }
  return found;
}

const failures = [];
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

// ── Manifest assertions (no build, no network) ───────────────────────────────

// 1 — stricter than npm on purpose: npm publishes a manifest with no `private`
// field quite happily, but the difference between "absent" and "explicitly
// false" is the difference between a silent regression and a loud one.
if (manifest.private !== false) {
  failures.push(
    `packages/sandbox-domains/package.json has \`private: ${JSON.stringify(manifest.private)}\`; it must be exactly \`false\`.\n` +
      "    `private: true` is worse than a publish failure: `npm publish -w` skips a private\n" +
      "    workspace with a warning and EXITS 0, so the release goes green having published nothing.",
  );
}

// 2 — registry is chosen by the publish job, not pinned in the manifest.
if (manifest.publishConfig?.registry !== undefined) {
  failures.push(
    `packages/sandbox-domains/package.json pins \`publishConfig.registry\` to ${JSON.stringify(manifest.publishConfig.registry)}.\n` +
      "    Leave it unset: release.yml's publish job targets registry.npmjs.org, and a pinned\n" +
      "    registry here can only send it somewhere else.",
  );
}

if (manifest.publishConfig?.access !== "public") {
  failures.push(
    'packages/sandbox-domains/package.json needs `publishConfig.access: "public"` — a scoped package\n' +
      "    defaults to restricted, and a restricted publish to a scope without a paid plan fails\n" +
      "    with E402 after the version bump has already merged.",
  );
}

// 3 — the whole point of the bundling strategy, and identical to the checks gate.
for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  const internal = Object.keys(manifest[field] ?? {}).filter((name) => name.startsWith("@pome-sh/"));
  if (internal.length > 0) {
    failures.push(
      `packages/sandbox-domains/package.json declares @pome-sh/* in \`${field}\`: ${internal.join(", ")}.\n` +
        "    @pome-sh/sdk and the five twins are `private: true` and are not on any registry at\n" +
        "    these versions, so a consumer's `npm i` would 404. They must stay devDependencies,\n" +
        "    inlined by tsup `noExternal`.",
    );
  }
}

if (manifest.peerDependencies?.zod === undefined) {
  failures.push(
    "packages/sandbox-domains/package.json must declare `zod` as a peerDependency.\n" +
      "    The seed schemas are zod values and pome-cloud hands `parseSeed` a seed it built with\n" +
      "    its OWN zod. A bundled or duplicated zod means two schema identities in the consumer's\n" +
      "    process — and unlike a 404, it works just well enough to be found later.",
  );
}

// The upstream fidelity anchors must not drift from the twins they were
// generated against.
for (const [name, twinManifestPath] of Object.entries(UPSTREAM_ANCHORS)) {
  const twinManifest = JSON.parse(readFileSync(join(ROOT, twinManifestPath), "utf8"));
  const expected = twinManifest.devDependencies?.[name] ?? twinManifest.dependencies?.[name];
  const actual = manifest.dependencies?.[name];
  if (expected === undefined) {
    failures.push(
      `${twinManifestPath} no longer declares ${name}, so this package's dependency on it is\n` +
        "    describing a type anchor that moved. Re-measure which upstream types reach the shipped\n" +
        "    declarations and update UPSTREAM_ANCHORS.",
    );
  } else if (actual !== expected) {
    failures.push(
      `packages/sandbox-domains/package.json declares ${name} as ${JSON.stringify(actual)} but\n` +
        `    ${twinManifestPath} declares ${JSON.stringify(expected)}. The declarations shipped here\n` +
        "    were generated against the twin's version, so a different range is a claim this build\n" +
        "    never checked.",
    );
  }
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

// Every subpath the export spec names must exist in the manifest at all — a
// missing one is ERR_PACKAGE_PATH_NOT_EXPORTED before any of the tarball
// assertions below get a chance to look at its contents.
for (const subpath of Object.keys(REQUIRED_EXPORTS)) {
  if (manifest.exports?.[subpath] === undefined) {
    failures.push(
      `packages/sandbox-domains/package.json has no \`exports\` entry for "${subpath}", which\n` +
        `    the export spec requires (pome-cloud imports ${REQUIRED_EXPORTS[subpath].join(", ")} from it).`,
    );
  }
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
  const workDirectory = mkdtempSync(join(tmpdir(), "pome-sandbox-domains-tarball-"));
  try {
    // --ignore-scripts: `prepublishOnly` would rebuild, which would hide a
    // "published a stale dist" bug. The caller is expected to have built.
    const packed = execFileSync(
      "npm",
      ["pack", "-w", "@pome-sh/sandbox-domains", "--ignore-scripts", "--pack-destination", workDirectory],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const tarballName = readdirSync(workDirectory).find((file) => file.endsWith(".tgz"));
    if (!tarballName) {
      failures.push(`\`npm pack -w @pome-sh/sandbox-domains\` produced no tarball:\n${packed}`);
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
        "these paths are declared in packages/sandbox-domains/package.json (`exports`/`main`/`types`)\n" +
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
    const extractDirectory = mkdtempSync(join(tmpdir(), "pome-sandbox-domains-extract-"));
    execFileSync("tar", ["-xf", tarball, "-C", extractDirectory], { stdio: "inherit" });
    const packageRoot = join(extractDirectory, "package");

    const packedManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const internal = Object.keys(packedManifest[field] ?? {}).filter((name) =>
        name.startsWith("@pome-sh/"),
      );
      if (internal.length > 0) {
        failures.push(`the PACKED manifest declares @pome-sh/* in \`${field}\`: ${internal.join(", ")}`);
      }
    }

    const distFiles = readdirSync(join(packageRoot, "dist"), { recursive: true }).map(String);
    const jsFiles = distFiles
      .filter((file) => file.endsWith(".js"))
      .map((file) => join(packageRoot, "dist", file));
    const declarationFiles = distFiles
      .filter((file) => file.endsWith(".d.ts"))
      .map((file) => join(packageRoot, "dist", file));
    const sources = new Map(jsFiles.map((file) => [file, readFileSync(file, "utf8")]));

    if (declarationFiles.length === 0) {
      failures.push("the tarball ships no .d.ts at all — the declaration build did not run.");
    }
    if (sources.size === 0) {
      failures.push("the tarball ships no .js at all — the bundle did not build.");
    }

    // 4 — every bare specifier the shipped bytes name is resolvable for a
    // consumer. Measured off the tarball rather than allowlisted, so a new
    // transitive import is named here instead of becoming the consumer's
    // ERR_MODULE_NOT_FOUND (js) or TS2307 (d.ts).
    const declaredRuntime = new Set([
      ...Object.keys(packedManifest.dependencies ?? {}),
      ...Object.keys(packedManifest.peerDependencies ?? {}),
    ]);
    const undeclared = new Map(); // package name -> sample sites
    const importedPackages = new Set();
    const scanned = [
      ...[...sources].map(([file, text]) => [file, text, "js"]),
      ...declarationFiles.map((file) => [file, readFileSync(file, "utf8"), "dts"]),
    ];
    for (const [file, text, kind] of scanned) {
      for (const specifier of specifiersIn(text, kind)) {
        if (specifier.startsWith(".")) continue;
        if (specifier.startsWith("node:")) continue;
        const name = packageNameOf(specifier);
        importedPackages.add(name);
        if (ALWAYS_RESOLVABLE(specifier) || declaredRuntime.has(name)) continue;
        const sites = undeclared.get(name) ?? [];
        if (sites.length < 3) sites.push(`${relative(packageRoot, file)} -> ${specifier}`);
        undeclared.set(name, sites);
      }
    }
    if (undeclared.size > 0) {
      failures.push(
        `${undeclared.size} package(s) are imported by the shipped bytes but declared in neither\n` +
          "    `dependencies` nor `peerDependencies`, so a consumer gets ERR_MODULE_NOT_FOUND (js)\n" +
          "    or TS2307 (d.ts). Declare them, or stop reaching them:\n" +
          [...undeclared]
            .map(([name, sites]) => `      - ${name}\n${sites.map((s) => `          ${s}`).join("\n")}`)
            .join("\n"),
      );
    }

    // 5 — and the converse: a declared dependency nothing imports is a package
    // the consumer installs and audits for no reason. `zod` is exempt because a
    // peer is a CONSTRAINT on the consumer's graph, not a thing this tarball
    // has to reach (it does, but that is not what makes it correct).
    //
    // 4 and 5 are two sides of ONE knob, and getting that backwards costs a
    // build cycle: `noExternal` only forces `@pome-sh/*` inlining, and tsup
    // decides every OTHER third-party package by whether this manifest declares
    // it. Declared ⇒ left external ⇒ must stay declared (hono). Undeclared ⇒
    // inlined into the bundle ⇒ must NOT be declared (graphql, which twin-linear
    // reaches through its package root, and which showed up here only as tsup's
    // `// ../../node_modules/graphql/…` source comments). So the fix for a
    // failure here is never "declare it and move on" — decide which side of the
    // knob the package belongs on first.
    const unusedDeps = Object.keys(packedManifest.dependencies ?? {}).filter(
      (name) => !importedPackages.has(name),
    );
    if (unusedDeps.length > 0) {
      failures.push(
        `${unusedDeps.length} declared runtime dependency(ies) are imported by NOTHING in the\n` +
          "    tarball — every consumer installs and audits them for no reason:\n" +
          unusedDeps.map((name) => `      - ${name}`).join("\n") +
          "\n    Note that declaring a package is also what makes tsup leave it EXTERNAL, so removing\n" +
          "    it here inlines it into the bundle instead. Confirm that is what you want.",
      );
    }

    // 6 — the runtime actually shipped. This is the INVERSE of the checks gate's
    // engine assertion, and it is the difference between this package and a
    // second declarations package: without a SQLite driver every `open*Database`
    // export is a function that cannot open anything, and nothing else notices
    // until a grader boots a twin.
    const sqliteCarriers = [...sources].filter(([, text]) => text.includes("node:sqlite"));
    if (sqliteCarriers.length === 0) {
      failures.push(
        "no shipped module imports `node:sqlite`, so the domain layer's database driver did not\n" +
          "    make it into the bundle. Every `open*Database` export would be unable to open a\n" +
          "    database. (This is deliberately the opposite of check-checks-tarball.mjs, which\n" +
          "    treats the same bytes as an engine LEAK into a declarations-only package.)",
      );
    }

    // 7 — one SQLite layer across the whole tarball. Seven entries all reach the
    // sdk's db module; without `splitting: true` each would carry its own copy,
    // so `@pome-sh/sandbox-domains/github`'s opener and `.../stripe`'s would be
    // different function objects holding different `DatabaseSync` handles. Same
    // argument as zod, one layer in — and the same shape as the checks gate's
    // `defineCheck` count, over this package's own shared primitive.
    if (sqliteCarriers.length > 1) {
      failures.push(
        `\`node:sqlite\` is imported by ${sqliteCarriers.length} shipped modules; it must be exactly one.\n` +
          "    Two copies means the per-twin entries hand out different database layers for the same\n" +
          "    primitive. `splitting: true` in tsup.config.ts is what keeps it to one:\n" +
          sqliteCarriers.map(([file]) => `      - ${relative(packageRoot, file)}`).join("\n"),
      );
    }

    // 8 — zod stays external. A bundled zod shows up as its own internals.
    const zodInlined = [...sources]
      .filter(([, text]) => /\bclass \$?ZodObject\b|\$ZodType\b/.test(text))
      .map(([file]) => file);
    if (zodInlined.length > 0) {
      failures.push(
        "zod appears to be INLINED into the tarball rather than left external:\n" +
          zodInlined.map((file) => `      - ${relative(packageRoot, file)}`).join("\n") +
          "\n    Two zod copies means two schema identities in the consumer's process.",
      );
    }
    const importsZod = [...sources.values()].some((text) => /from\s*['"]zod['"]/.test(text));
    if (!importsZod) {
      failures.push(
        "no shipped module imports `zod`. Either the seed schemas stopped being zod values or zod\n" +
          "    got bundled — both change what the consumer's `parseSeed` returns.",
      );
    }

    // 9 — the export spec, read off the shipped bytes. A re-export that silently
    // stopped resolving is invisible here and fatal in pome-cloud.
    for (const [subpath, symbols] of Object.entries(REQUIRED_EXPORTS)) {
      const target = manifest.exports?.[subpath];
      const file = typeof target === "string" ? target : target?.default;
      if (!file) continue; // already reported by the manifest assertion above
      const text = sources.get(join(packageRoot, file.replace(/^\.\//, "")));
      if (text === undefined) {
        failures.push(`${subpath} points at ${file}, which is not in the tarball's dist.`);
        continue;
      }
      const absent = symbols.filter((symbol) => !new RegExp(`\\b${symbol}\\b`).test(text));
      if (absent.length > 0) {
        failures.push(
          `${subpath} (${file}) does not export ${absent.join(", ")}, which the export spec\n` +
            "    requires because pome-cloud imports them from it.",
        );
      }
    }

    // The declarations must be self-contained apart from resolvable externals.
    // `noExternal` does not cover them: the declaration bundler leaves bare
    // specifiers alone, so `export … from "@pome-sh/twin-github"` lands verbatim
    // in the shipped `.d.ts` and resolves nowhere for a consumer.
    // `scripts/bundle-declarations.mjs` rewrites them; assertion 4 above is the
    // tarball-side check that it ran and covered everything, since an
    // unrewritten `@pome-sh/*` specifier is by definition undeclared.
    //
    // The authoritative test is the consumer COMPILE in
    // scripts/clean-room-pack-test.mjs, which catches type errors this cannot see.

    if (failures.length === 0) {
      console.log(
        `  ✓ ${declaredPaths.size} declared path(s) ship; ${importedPackages.size} imported package(s) all ` +
          "declared and all used; SQLite present exactly once; zod external; export spec intact; " +
          "no hard links, no dangling sourcemaps",
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
  console.error(`\n@pome-sh/sandbox-domains ${MANIFEST_ONLY ? "manifest" : "tarball"} audit FAILED:`);
  for (const failure of failures) console.error(`\n  - ${failure}`);
  process.exit(1);
}

console.log(
  MANIFEST_ONLY
    ? "@pome-sh/sandbox-domains manifest audit passed — private: false, access public, zero @pome-sh/* runtime deps, zod is a peer, upstream anchors match the twins."
    : "@pome-sh/sandbox-domains tarball audit passed — installable with no @pome-sh/* dependency, every import declared and every declaration used, one SQLite layer, one zod, export spec intact.",
);
