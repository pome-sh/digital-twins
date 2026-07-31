#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1135 — fail PR CI when `cli/package.json`'s `@pome-sh/*` pins disagree with
// the versions in `packages/`. Dependency-free and offline: it reads JSON only,
// so it runs in ci.yml's cheap gate block before `npm ci`.
//
// WHY THIS GATE EXISTS — there are two CLI artifacts and CI only knew one:
//
//   • what CI TESTS      — the workspace build. `scripts/pack-publishable.mjs`
//     packs `packages/*` and `scripts/use-local-pome-tarballs.mjs` rewrites the
//     CLI's `@pome-sh/*` deps to those tarballs.
//   • what USERS INSTALL — the published tarball, whose `@pome-sh/*` deps are
//     `bundleDependencies`, so the pin is baked in at publish time rather than
//     resolved at install. A stale pin ships FROZEN; no later `npm i` fixes it.
//
// The two differ by exactly the pin, and the rewrite is unconditional
// (`use-local-pome-tarballs.mjs`: `if (tarballs[name]) pkg[field][name] = ...`).
// It never reads the declared value, so the pin had no opportunity to be
// compared with anything. At `fbdac32` the CLI pinned twin-github 0.4.0 while
// `packages/twin-github` held 0.5.0 and cli-ci reported SUCCESS — on precisely
// the skew that was refusing every user's `pome checks add` for github, because
// `checksDigest` hashes the whole set so one missing row closes the twin's
// whole door. That was F-1132.
//
// THE RULE — a pin must EQUAL its workspace version. Stated the useful way:
// the tarball rewrite must be a NO-OP. When pin == workspace, rewriting the dep
// to the packed workspace tarball installs the very version the pin declares,
// so the tested artifact and the shipped artifact are the same artifact.
//
// The rewrite itself is load-bearing and must NOT be deleted: when a PR changes
// `packages/twin-github`, that version is not on npm yet, so installing from
// the registry would test the OLD published twin and silently skip the change.
// This gate is the additive half — it makes the rewrite honest instead of
// removing it.
//
// A pin AHEAD of the workspace fails too, and is never a legitimate window:
// the repo cannot pack the version the pin names, so the rewrite silently
// DOWNGRADES the CLI under test.
//
// ESCAPE HATCH — see CLOUD_FIRST_WINDOWS below. F-1075 ratified an ordering in
// which a twin's vocabulary can reach prod before the CLI re-pins, so a lagging
// pin is sometimes correct. Declare it there rather than deleting this gate.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Deliberate cloud-first windows (F-1075's ratified ordering), each pinned to
// the EXACT pair it was written for.
//
// TARGET EMPTY — currently ZERO entries.
//
// An entry is a fingerprint, not a mute button: `pin` and `workspace` must both
// match the tree exactly, so the moment either side moves again the window stops
// applying and this gate re-arms. That is on purpose. `cli-release.yml` used to
// check seven hard-coded version literals; they were true for exactly one day
// (2026-07-20), pins moved six times after, and the step kept passing while
// looking like something was watching. A window that outlives its own versions
// is that same failure, so it cannot be expressed here.
//
// To open one, add:
//   { name: "@pome-sh/twin-github", pin: "0.4.0", workspace: "0.5.0",
//     reason: "F-XXXX — vocabulary deploys to prod ahead of the CLI re-pin" }
// and delete it in the PR that catches the pin up.
const CLOUD_FIRST_WINDOWS = [];

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const SCOPE = "@pome-sh/";

function compare(a, b) {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

/**
 * Compare the CLI's declared pins against the workspace.
 *
 * @param pins       `{ "@pome-sh/twin-github": "0.5.0", ... }` — the CLI's
 *                   dependencies + devDependencies, verbatim.
 * @param workspace  `{ "twin-github": "0.5.0", ... }` — keyed by the package
 *                   name with the `@pome-sh/` scope stripped.
 * @param windows    Declared cloud-first windows (see CLOUD_FIRST_WINDOWS).
 * @returns `{ ok, checked, failures, excused }`
 */
export function evaluate(pins, workspace, windows = CLOUD_FIRST_WINDOWS) {
  const checked = [];
  const failures = [];
  const excused = [];

  for (const [name, pin] of Object.entries(pins)) {
    if (!name.startsWith(SCOPE)) continue;
    const short = name.slice(SCOPE.length);
    // A pin with no package in this workspace is out of scope: there is no
    // workspace version to disagree with, and the rewrite leaves it alone.
    if (!Object.hasOwn(workspace, short)) continue;

    const workspaceVersion = workspace[short];
    checked.push({ name, pin, workspace: workspaceVersion });

    // Fail closed on anything that isn't a plain exact version. A range or tag
    // cannot be compared to the workspace, and `bundleDependencies` freezes
    // whatever it happened to resolve at publish time — so "probably fine" is
    // exactly the state this gate exists to refuse.
    if (!EXACT_VERSION.test(pin)) {
      failures.push({ name, pin, workspace: workspaceVersion, direction: "unpinned" });
      continue;
    }
    if (!EXACT_VERSION.test(workspaceVersion)) {
      failures.push({ name, pin, workspace: workspaceVersion, direction: "unparseable" });
      continue;
    }
    if (pin === workspaceVersion) continue;

    const direction = compare(pin, workspaceVersion) < 0 ? "behind" : "ahead";
    const window = windows.find(
      (w) => w.name === name && w.pin === pin && w.workspace === workspaceVersion,
    );
    // Only a lagging pin can be a cloud-first window; see the header.
    if (window && direction === "behind") {
      excused.push({ name, pin, workspace: workspaceVersion, reason: window.reason });
      continue;
    }
    failures.push({ name, pin, workspace: workspaceVersion, direction });
  }

  return { ok: failures.length === 0, checked, failures, excused };
}

/** The CLI's declared deps + devDeps, verbatim. Shared with the release gate. */
export function readPins(root) {
  const pkg = JSON.parse(readFileSync(join(root, "cli/package.json"), "utf8"));
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

/** `packages/*` versions keyed by name with the `@pome-sh/` scope stripped. */
export function readWorkspace(root) {
  const dir = join(root, "packages");
  const versions = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, entry.name, "package.json"), "utf8"));
    } catch {
      continue; // not a package (no manifest) — nothing to compare against.
    }
    if (typeof manifest.name !== "string" || !manifest.name.startsWith(SCOPE)) continue;
    versions[manifest.name.slice(SCOPE.length)] = manifest.version;
  }
  return versions;
}

function main() {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const result = evaluate(readPins(root), readWorkspace(root));

  for (const w of result.excused) {
    console.log(
      `⚠️  Declared cloud-first window: ${w.name} pin ${w.pin} lags workspace ${w.workspace} — ${w.reason}`,
    );
  }

  if (result.ok) {
    console.log(
      `✅ CLI pin parity OK: ${result.checked.length} @pome-sh/* pin(s) match packages/.`,
    );
    return;
  }

  const lines = result.failures.map((f) => {
    if (f.direction === "unpinned") {
      return `  ${f.name}\n      cli/package.json pin: ${f.pin}  ← not an exact version\n      packages/${f.name.slice(SCOPE.length)}:  ${f.workspace}`;
    }
    if (f.direction === "unparseable") {
      return `  ${f.name}\n      cli/package.json pin: ${f.pin}\n      packages/${f.name.slice(SCOPE.length)}:  ${f.workspace}  ← not a plain x.y.z version`;
    }
    return `  ${f.name}  (pin is ${f.direction} the workspace)\n      cli/package.json pin: ${f.pin}\n      packages/${f.name.slice(SCOPE.length)}:  ${f.workspace}`;
  });

  console.error(`❌ CLI pin parity check failed.

${lines.join("\n")}

CI tests the workspace build: scripts/use-local-pome-tarballs.mjs rewrites these
deps to tarballs packed from packages/, so the version above on the right is
what every test in this repo actually exercised. Users install the published
tarball, where these deps are bundleDependencies — the version on the left,
frozen in at publish time. While they disagree, this repo is green on an
artifact nobody ships.

If you BUMPED A PACKAGE IN THIS PR — the common case — carry the pin along in
the same PR:

  # cli/package.json
  "${result.failures[0].name}": "${result.failures[0].workspace}"

  # then, so the re-pin actually reaches users:
  cd cli && npm run changeset

Pinning a version that is not on npm yet is fine and expected: cli-ci packs it
from packages/, and cli-release.yml waits (ready=false) until the packages-v*
batch publishes.

If the lag is DELIBERATE (F-1075's ratified ordering lets a twin's vocabulary
reach prod before the CLI re-pins), declare it in CLOUD_FIRST_WINDOWS at the top
of scripts/check-cli-pins-match-workspace.mjs — do not delete this gate. The
declaration is pinned to these exact versions, so it expires on its own the next
time either side moves.

Why: F-1132. Prod served 12 GitHub checks, the published CLI knew 11, and every
\`pome checks add --check github.*\` refused with exit 2 for six hours — while
cli-ci was green on the very commit that caused it.`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
