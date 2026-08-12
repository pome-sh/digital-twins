#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1126 — fail CI when one `packages/*` package's `@pome-sh/*` pin disagrees
// with the version of the sibling it names. Dependency-free and offline: it
// reads JSON only, so it runs in ci.yml's cheap gate block before `npm ci`.
//
// WHY THIS GATE EXISTS — npm workspaces only SYMLINK a sibling when the
// declared pin is satisfied by that sibling's version. When it is not, npm
// quietly installs a REAL nested copy from the registry, and every build, test
// and typecheck for that package runs against the published artifact instead of
// the tree in front of you.
//
// That is not hypothetical. At `45b5f06`, `packages/twin-slack` declared
// `@pome-sh/sdk` 0.5.1 against a workspace holding 0.9.0, so
// `packages/twin-slack/node_modules/@pome-sh/sdk` was a real directory
// containing the published 0.5.1 — five minors behind — and had been for months.
// CI was green throughout, because everything it ran for twin-slack genuinely
// passed against a five-month-old sdk. `twin-github`, whose pin matched, had no
// nested copy at all. Nothing compared the two.
//
// It surfaced only when F-1126 imported `@pome-sh/sdk/checks`, a subpath 0.5.1
// does not export. A change that had merely CHANGED behaviour rather than added
// an export would have been tested against the wrong artifact in silence.
//
// This is the sibling of `check-cli-pins-match-workspace.mjs` (F-1135), which
// made the same argument for `cli/`. That file, `cli-ci.yml`, `cli-release.yml`
// and `scripts/use-local-pome-tarballs.mjs` are all gone as of `a3c9441`
// ("replace two release systems with one", #239): the CLI joined the root
// workspace and every internal `@pome-sh/*` dep in `cli/package.json` became a
// workspace-resolved `"*"`, precisely because an exact pin there had drifted
// (`shared-types@0.12.0` against a local `0.12.2`, two zod schema identities
// at one runtime — the same shape F-1126 above catches in `packages/`). `cli/`
// itself is not a sibling anything else pins against, so it was never in this
// script's `packages/` scan — but nothing stopped `cli/package.json` from
// reintroducing the exact pin #239 deleted. This scan now covers it too, so
// that regression is caught here rather than rediscovered the hard way again.
//
// THE RULE — a pin must be `"*"` / `workspace:*` (always a workspace link) OR an
// exact semver that EQUALS the sibling's workspace version. Stated the useful
// way: `npm ci` must produce a symlink, never a nested install.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const SCOPE = "@pome-sh/";

export function findPinViolations(repoRoot) {
  const packagesDir = join(repoRoot, "packages");
  const manifests = new Map();

  for (const entry of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, entry, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifests.set(manifest.name, { manifest, dir: entry });
  }

  // `cli/` is a consumer of these siblings but never one itself — nothing in
  // this workspace pins a `@pome-sh/*` dep against the CLI's own version — so
  // it is scanned for violations without being added to `manifests`.
  const consumers = [...manifests.entries()].map(([name, { manifest, dir }]) => ({
    name,
    manifest,
    label: `packages/${dir}`,
  }));
  const cliManifestPath = join(repoRoot, "cli", "package.json");
  if (existsSync(cliManifestPath)) {
    const cliManifest = JSON.parse(readFileSync(cliManifestPath, "utf8"));
    consumers.push({ name: cliManifest.name, manifest: cliManifest, label: "cli" });
  }

  const violations = [];
  for (const { manifest, label } of consumers) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const [dep, pin] of Object.entries(manifest[field] ?? {})) {
        if (!dep.startsWith(SCOPE)) continue;
        const sibling = manifests.get(dep);
        // A `@pome-sh/*` dep with no sibling in `packages/` is out of scope:
        // nothing in this tree could satisfy it, so npm installing from the
        // registry is the only possible and the correct behaviour.
        if (!sibling) continue;
        // Lane A / workspace unification: `"*"` (and `workspace:*`) always
        // resolves to the local sibling via npm workspaces, so it cannot
        // silently pull a nested registry copy. Exact pins remain required to
        // MATCH the sibling when they are used.
        if (pin === "*" || pin === "workspace:*") continue;
        if (!EXACT_VERSION.test(pin)) {
          violations.push(
            `${label} (${manifest.name}): ${field}.${dep} is "${pin}" — @pome-sh/* pins must be exact semver, "*", or "workspace:*"`,
          );
          continue;
        }
        if (pin !== sibling.manifest.version) {
          violations.push(
            `${label} (${manifest.name}): ${field}.${dep} pins ${pin} but packages/${sibling.dir} ` +
              `is ${sibling.manifest.version}. npm will install the PUBLISHED ${pin} as a nested ` +
              `copy, so this package is built and tested against the registry rather than this tree.`,
          );
        }
      }
    }
  }
  return violations;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = findPinViolations(repoRoot);
  if (violations.length > 0) {
    console.error("❌ workspace pin parity FAILED:\n");
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      "\nSet each pin to \"*\" (or the sibling's exact version in packages/). A mismatched or\n" +
        "unnecessary exact pin does not fail loudly — it silently swaps the workspace tree for\n" +
        "a published tarball.",
    );
    process.exit(1);
  }
  console.log(
    "✅ workspace pin parity OK: every @pome-sh/* pin in packages/ and cli/ matches its sibling.",
  );
}
