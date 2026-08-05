#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The CLI bundles every internal `@pome-sh/*` package into its own dist
// (`noExternal: [/^@pome-sh\//]`), so those packages' own `dependencies` stop
// being installed for them: whatever they `import` has to resolve from the
// PUBLISHED CLI's dependency tree instead. Nothing in the type system or the
// bundler notices when it cannot — esbuild happily leaves an unresolvable bare
// import in a lazily-loaded chunk, and the failure lands on a user running
// `pome twin start linear` with ERR_MODULE_NOT_FOUND.
//
// That is exactly how `graphql` (twin-linear's GraphQL executor) slipped
// through. This gate unions the third-party runtime dependencies of every
// internal package the CLI inlines and asserts each one is satisfiable from the
// published CLI manifest — either declared in cli `dependencies`, or inlined by
// the bundler (`noExternal`).
//
// Run standalone (`node scripts/check-bundled-runtime-deps.mjs`) or against a
// packed tarball's manifest (`--manifest <path/to/package.json>`).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// Every workspace package the CLI inlines. Kept explicit rather than globbed:
// a new internal package must be a deliberate addition here, and
// adapter-claude-sdk is NOT in the CLI's graph (it is published separately).
const BUNDLED_PACKAGES = [
  "packages/sdk",
  "packages/shared-types",
  "packages/wire",
  "packages/twin-github",
  "packages/twin-slack",
  "packages/twin-stripe",
  "packages/twin-gmail",
  "packages/twin-linear",
];

const manifestFlag = process.argv.indexOf("--manifest");
const cliManifestPath =
  manifestFlag === -1 ? join(ROOT, "cli", "package.json") : resolve(process.argv[manifestFlag + 1]);
const cliManifest = readJson(cliManifestPath);

// Bare specifiers the bundler inlines rather than leaves as imports. Mirrors
// cli/tsup.config.ts `noExternal`.
const INLINED = [/^@pome-sh\//];

/** Third-party runtime specifiers each bundled package needs at runtime.
 *  `peerDependencies` count: the sdk's optional `@hono/node-server` peer is a
 *  real runtime import on the server path. */
function requiredSpecifiers() {
  const required = new Map(); // specifier -> [packages needing it]
  for (const dir of BUNDLED_PACKAGES) {
    const manifest = readJson(join(ROOT, dir, "package.json"));
    for (const field of ["dependencies", "peerDependencies"]) {
      for (const spec of Object.keys(manifest[field] ?? {})) {
        if (INLINED.some((pattern) => pattern.test(spec))) continue;
        required.set(spec, [...(required.get(spec) ?? []), manifest.name]);
      }
    }
  }
  return required;
}

const declared = new Set(Object.keys(cliManifest.dependencies ?? {}));
const missing = [];
for (const [spec, needers] of requiredSpecifiers()) {
  if (!declared.has(spec)) missing.push(`${spec} (needed by ${needers.join(", ")})`);
}

if (missing.length > 0) {
  console.error(
    `Bundled-runtime-dependency gate FAILED for ${cliManifest.name}@${cliManifest.version}.`,
  );
  console.error(
    "\nThese specifiers are imported by packages inlined into the CLI bundle but are\n" +
      "neither in cli `dependencies` nor inlined by the bundler. A lazily-loaded twin\n" +
      "chunk would die with ERR_MODULE_NOT_FOUND at runtime:\n",
  );
  for (const entry of missing) console.error(`  - ${entry}`);
  console.error(
    "\nFix: add the package to cli/package.json `dependencies` (preferred for large\n" +
      "or CJS-heavy libraries such as graphql), or add it to `noExternal` in\n" +
      "cli/tsup.config.ts so the bundler inlines it.",
  );
  process.exit(1);
}

// Also flag @pome-sh/* left in the published runtime deps: those packages are
// `private: true`, so a leaked spec would be unresolvable on install.
const leakedInternal = [...declared].filter((spec) => spec.startsWith("@pome-sh/"));
if (leakedInternal.length > 0) {
  console.error(
    `Bundled-runtime-dependency gate FAILED: ${cliManifest.name} declares private internal packages as runtime dependencies: ${leakedInternal.join(", ")}`,
  );
  console.error("They are `private: true` and would be unresolvable from the registry.");
  process.exit(1);
}

console.log(
  `Bundled-runtime-dependency gate passed — ${requiredSpecifiers().size} third-party specifier(s) from ${BUNDLED_PACKAGES.length} inlined packages all satisfiable from ${cliManifest.name}.`,
);
