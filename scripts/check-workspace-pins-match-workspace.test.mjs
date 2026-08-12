#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `check-workspace-pins-match-workspace.mjs` (F-1126,
// extended to `cli/` under F-1231).
//
// F-1231 investigated a 2026-08-03 failure where the CLI's build typechecked
// against a `@pome-sh/shared-types` version behind what `packages/` (and its
// own source) actually used — a pin that had drifted out from under it. That
// specific architecture (`cli-ci.yml`, `use-local-pome-tarballs.mjs`, an exact
// registry pin in `cli/package.json`) was deleted across `6369379` (#237) and
// `a3c9441` (#239) the day AFTER the ticket was filed: every
// internal `@pome-sh/*` dep, cli's included, became a workspace-resolved `"*"`,
// which npm always symlinks — so the specific "stale pin passes CI, breaks on
// publish" shape this gate is named for cannot recur through `cli/` today. What
// CAN recur is the thing #239 fixed being silently undone: nothing stopped
// `cli/package.json` from reintroducing an exact pin, because this gate's
// `packages/` scan never looked at `cli/`. Case 4 below is that regression,
// reproduced against a fixture rather than the real `cli/package.json` so the
// gate is proven to fire on the shape, not just trusted to.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPinViolations } from "./check-workspace-pins-match-workspace.mjs";

/** Build a throwaway repo: packages/<dir>/package.json for each entry, plus an
 * optional cli/package.json. */
function fixture(packageManifests, cliManifest) {
  const root = mkdtempSync(join(tmpdir(), "workspace-pins-"));
  mkdirSync(join(root, "packages"), { recursive: true });
  for (const [dir, manifest] of Object.entries(packageManifests)) {
    const pkgDir = join(root, "packages", dir);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2));
  }
  if (cliManifest) {
    mkdirSync(join(root, "cli"), { recursive: true });
    writeFileSync(join(root, "cli", "package.json"), JSON.stringify(cliManifest, null, 2));
  }
  return root;
}

let failures = 0;
function expectGate(name, root, expected) {
  const violations = findPinViolations(root);
  const got = violations.length === 0 ? "green" : "red";
  if (got !== expected) {
    failures += 1;
    console.error(`✗ ${name}\n  expected ${expected}, got ${got}\n${violations.join("\n")}`);
  } else {
    console.log(`✓ ${name}${violations.length ? "\n  " + violations.join("\n  ") : ""}`);
  }
}

// 1. `"*"` everywhere (this repo's actual shape) is clean, in packages/ and cli/.
expectGate(
  "1. every pin is \"*\" — packages and cli",
  fixture(
    {
      sdk: { name: "@pome-sh/sdk", version: "0.9.0" },
      "twin-github": {
        name: "@pome-sh/twin-github",
        version: "1.2.0",
        dependencies: { "@pome-sh/sdk": "*" },
      },
    },
    { name: "@pome-sh/cli", version: "0.23.19", devDependencies: { "@pome-sh/sdk": "*" } },
  ),
  "green",
);

// 2. An exact pin that matches the sibling's version is still allowed (the
// existing packages/* rule, unchanged by this extension).
expectGate(
  "2. exact pin matching the sibling's version stays green",
  fixture({
    sdk: { name: "@pome-sh/sdk", version: "0.9.0" },
    "twin-github": {
      name: "@pome-sh/twin-github",
      version: "1.2.0",
      dependencies: { "@pome-sh/sdk": "0.9.0" },
    },
  }),
  "green",
);

// 3. The original F-1126 shape: a packages/* sibling pins a stale exact version.
expectGate(
  "3. packages/* pin behind the workspace sibling reds (F-1126's own case)",
  fixture({
    sdk: { name: "@pome-sh/sdk", version: "0.9.0" },
    "twin-slack": {
      name: "@pome-sh/twin-slack",
      version: "1.0.0",
      dependencies: { "@pome-sh/sdk": "0.5.1" },
    },
  }),
  "red",
);

// 4. The F-1231 regression this file exists for: `cli/package.json` pins an
// exact, stale version of a sibling instead of "*" — the exact shape #239
// deleted from `cli/` and that this gate's `packages/`-only scan could not see
// come back. `@pome-sh/wire`'s workspace version carries `parent_event_id`
// (0.14.0); a cli pinned to the pre-F-1200 line (0.13.x) is the 2026-08-03
// incident's own version numbers.
expectGate(
  "4. cli/package.json reintroducing a stale exact pin reds (the F-1231 regression)",
  fixture(
    { wire: { name: "@pome-sh/wire", version: "0.14.0" } },
    { name: "@pome-sh/cli", version: "0.23.19", devDependencies: { "@pome-sh/wire": "0.13.4" } },
  ),
  "red",
);

// 4b. Every other way a pin can be reintroduced is caught by the same rule, in
// every install field. A caret/tilde/range, a `file:`/`link:` path, a `npm:`
// alias, a dist-tag and a git/tarball URL are all "not exact semver" — none of
// them guarantees npm produces a symlink — and `optionalDependencies` resolves
// like `dependencies`, so it is scanned too.
for (const pin of [
  "^0.14.0",
  "~0.14.0",
  ">=0.13.0",
  "file:../packages/wire",
  "link:../packages/wire",
  "npm:@pome-sh/wire@0.13.4",
  "latest",
  "0.14.0-rc.1",
]) {
  expectGate(
    `4b. cli pin "${pin}" reds — only "*" or an exact match guarantees a symlink`,
    fixture(
      { wire: { name: "@pome-sh/wire", version: "0.14.0" } },
      { name: "@pome-sh/cli", version: "0.23.19", devDependencies: { "@pome-sh/wire": pin } },
    ),
    "red",
  );
}
expectGate(
  "4c. a stale pin in optionalDependencies reds like one in dependencies",
  fixture(
    { wire: { name: "@pome-sh/wire", version: "0.14.0" } },
    {
      name: "@pome-sh/cli",
      version: "0.23.19",
      optionalDependencies: { "@pome-sh/wire": "0.13.4" },
    },
  ),
  "red",
);

// 5. A `@pome-sh/*` cli dep with no sibling under packages/ (e.g. a future
// published-only dependency) is out of this gate's scope either way.
expectGate(
  "5. cli dep with no packages/ sibling is out of scope",
  fixture({}, { name: "@pome-sh/cli", version: "0.23.19", devDependencies: { "@pome-sh/other": "1.0.0" } }),
  "green",
);

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nAll cases passed.");
