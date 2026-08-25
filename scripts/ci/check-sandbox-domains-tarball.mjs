#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Release gate for @pome-sh/sandbox-domains' tarball. NOT a copy of
// check-checks-tarball.mjs: three assertions are deliberately inverted, because
// this package IS the engine's domain half. It REQUIRES `node:sqlite` and treats
// hono as an ordinary declared external, where checks forbids both.
//
// The dependency set is read from the shipped bytes, both directions — every
// bare specifier declared, every declared dep imported.

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

const UPSTREAM_ANCHORS = {
  "@octokit/openapi-types": "packages/twin-github/package.json",
  stripe: "packages/twin-stripe/package.json",
};

const ALWAYS_RESOLVABLE = (specifier) => specifier === "zod" || specifier.startsWith("node:");

function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

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

const DECLARATION_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*)\(?\s*(['"])([^'"]+)\1/g;

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

if (manifest.private !== false) {
  failures.push(
    `packages/sandbox-domains/package.json has \`private: ${JSON.stringify(manifest.private)}\`; it must be exactly \`false\`.\n` +
      "    `private: true` is worse than a publish failure: `npm publish -w` skips a private\n" +
      "    workspace with a warning and EXITS 0, so the release goes green having published nothing.",
  );
}

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

function exportTargets(exportsField) {
  const targets = new Set();
  const walk = (node) => {
    if (typeof node === "string") targets.add(node.replace(/^\.\//, ""));
    else if (node && typeof node === "object") for (const value of Object.values(node)) walk(value);
  };
  walk(exportsField);
  return targets;
}

for (const subpath of Object.keys(REQUIRED_EXPORTS)) {
  if (manifest.exports?.[subpath] === undefined) {
    failures.push(
      `packages/sandbox-domains/package.json has no \`exports\` entry for "${subpath}", which\n` +
        `    the export spec requires (pome-cloud imports ${REQUIRED_EXPORTS[subpath].join(", ")} from it).`,
    );
  }
}

const declaredPaths = exportTargets(manifest.exports);
for (const field of ["main", "types"]) {
  if (typeof manifest[field] === "string") declaredPaths.add(manifest[field].replace(/^\.\//, ""));
}
declaredPaths.delete("package.json"); // always in the tarball; not a build output

function auditTarball() {
  const workDirectory = mkdtempSync(join(tmpdir(), "pome-sandbox-domains-tarball-"));
  try {
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

    const sqliteCarriers = [...sources].filter(([, text]) => text.includes("node:sqlite"));
    if (sqliteCarriers.length === 0) {
      failures.push(
        "no shipped module imports `node:sqlite`, so the domain layer's database driver did not\n" +
          "    make it into the bundle. Every `open*Database` export would be unable to open a\n" +
          "    database. (This is deliberately the opposite of check-checks-tarball.mjs, which\n" +
          "    treats the same bytes as an engine LEAK into a declarations-only package.)",
      );
    }

    if (sqliteCarriers.length > 1) {
      failures.push(
        `\`node:sqlite\` is imported by ${sqliteCarriers.length} shipped modules; it must be exactly one.\n` +
          "    Two copies means the per-twin entries hand out different database layers for the same\n" +
          "    primitive. `splitting: true` in tsup.config.ts is what keeps it to one:\n" +
          sqliteCarriers.map(([file]) => `      - ${relative(packageRoot, file)}`).join("\n"),
      );
    }

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
