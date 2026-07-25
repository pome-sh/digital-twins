#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Publish guard: refuse to publish a @pome-sh/cli tarball that cannot install.
//
// Every `@pome-sh/*` package except the CLI itself and the Claude adapter is
// `private: true`, so a dependency on one is only satisfiable if it physically
// rides inside the tarball. Two ways that can be true:
//   - the CLI has NO `@pome-sh/*` runtime dependency at all (the bundler
//     inlined them — the end state), or
//   - every `@pome-sh/*` dependency is listed in `bundleDependencies` AND is
//     materialized in `cli/node_modules/` at pack time.
//
// The second is what the pre-restructure layout did, and it silently stopped
// working when `cli/` joined the root npm workspace: npm hoists the workspace
// links to the repo-root `node_modules`, `cli/node_modules/@pome-sh/` is empty,
// and `npm pack` emits a tarball with `bundleDependencies` declared but nothing
// bundled. npm then trusts the declaration and does NOT fetch those deps on
// install, so the failure surfaces as ERR_MODULE_NOT_FOUND on the user's first
// command — not as an install error. Hence this gate.
//
// Runs as cli's `prepublishOnly`. Exits non-zero with the hotfix path spelled
// out; `--quiet` suppresses the explanation (for callers that expect a refusal).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");

const pkg = JSON.parse(readFileSync(join(CLI_ROOT, "package.json"), "utf8"));
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
  (dep) => !existsSync(join(CLI_ROOT, "node_modules", dep, "package.json")),
);

if (undeclared.length === 0 && unmaterialized.length === 0) {
  console.log(
    `publish guard OK: ${internal.length} internal dependency/ies declared in bundleDependencies and present in cli/node_modules.`,
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
      `  - declared bundled but missing from cli/node_modules (npm hoisted the workspace link to the repo root, so there is nothing to bundle): ${unmaterialized.join(", ")}`,
    );
  }
  console.error(
    "\nPublishing is frozen for the packaging restructure. To ship a hotfix,\n" +
      "check out the pre-restructure @pome-sh/cli@0.8.0 tag (exact-pin manifest,\n" +
      "standalone cli/ install), cherry-pick the fix, and publish from there.\n" +
      "The permanent fix is the bundler lane: no @pome-sh/* runtime deps at all.",
  );
}
process.exit(1);
