#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Publish guard: refuse to publish a @pome-sh/adapter-claude-sdk tarball that
// cannot install.
//
// Every `@pome-sh/*` package except the CLI and this adapter is `private:
// true`, so a dependency on one is only satisfiable if it physically rides
// inside the tarball. Two ways that can be true:
//   - the adapter has NO `@pome-sh/*` runtime dependency at all (the bundler
//     inlined them — the end state), or
//   - every `@pome-sh/*` dependency is listed in `bundleDependencies` AND is
//     materialized in this package's own `node_modules/` at pack time.
//
// The second silently stops working once a package joins the root npm
// workspace: npm hoists the workspace links to the repo-root `node_modules`,
// this package's own `node_modules/@pome-sh/` is empty, and `npm pack` emits
// a tarball with `bundleDependencies` declared but nothing bundled. npm then
// trusts the declaration and does NOT fetch those deps on install, so the
// failure surfaces as ERR_MODULE_NOT_FOUND on the consumer's first import —
// not as an install error. Hence this gate. See cli/scripts/assert-publishable.mjs
// for the sibling guard this one mirrors.
//
// Runs as this package's `prepublishOnly`. Exits non-zero with the hotfix
// path spelled out; `--quiet` suppresses the explanation (for callers that
// expect a refusal).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
const internal = Object.keys(pkg.dependencies ?? {}).filter((dep) =>
  dep.startsWith("@pome-sh/"),
);

if (internal.length === 0) {
  console.log("publish guard OK: no @pome-sh/* runtime dependencies to bundle.");
  process.exit(0);
}

const declared = new Set(pkg.bundleDependencies ?? []);
const undeclared = internal.filter((dep) => !declared.has(dep));
const unmaterialized = internal.filter(
  (dep) => !existsSync(join(PKG_ROOT, "node_modules", dep, "package.json")),
);

if (undeclared.length === 0 && unmaterialized.length === 0) {
  console.log(
    `publish guard OK: ${internal.length} internal dependency/ies declared in bundleDependencies and present in node_modules.`,
  );
  process.exit(0);
}

if (!quiet) {
  console.error("publish guard REFUSED: this tarball would not install.");
  if (undeclared.length > 0) {
    console.error(
      `  - depended on but not in bundleDependencies: ${undeclared.join(", ")}`,
    );
  }
  if (unmaterialized.length > 0) {
    console.error(
      `  - declared bundled but missing from node_modules (npm hoisted the workspace link to the repo root, so there is nothing to bundle): ${unmaterialized.join(", ")}`,
    );
  }
  console.error(
    "\nPublishing is frozen for the packaging restructure. To ship a hotfix,\n" +
      "check out the pre-restructure tag, cherry-pick the fix, and publish from\n" +
      "there. The permanent fix is the bundler lane: no @pome-sh/* runtime deps at all.",
  );
}
process.exit(1);
