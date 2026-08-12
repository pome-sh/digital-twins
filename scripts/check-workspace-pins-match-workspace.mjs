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
// made the same argument for `cli/`. That file and
// `scripts/use-local-pome-tarballs.mjs` went in `6369379` (#237), and
// `cli-ci.yml` / `cli-release.yml` in `a3c9441` (#239) — one restructure over
// two PRs the same day. The CLI joined the root workspace and every internal
// `@pome-sh/*` dep in `cli/package.json` became a workspace-resolved `"*"`,
// precisely because an exact pin there had drifted (`shared-types@0.12.0`
// against a local `0.12.2`, two zod schema identities at one runtime — the same
// shape F-1126 above catches in `packages/`). `cli/` itself is not a sibling
// anything else pins against, so it was never in this script's `packages/`
// scan — but nothing stopped `cli/package.json` from reintroducing the exact pin
// that restructure deleted. This scan now covers it too, so that regression is
// caught here rather than rediscovered the hard way again.
//
// NOT in scope: `examples/*`. Those are standalone npm packages with their own
// lockfiles that install from the REGISTRY on purpose (`examples/support-triage`
// is `npx degit`-fetchable as a standalone subtree, so it cannot use a `file:`
// link out of its own directory), so "must resolve to the workspace" is the
// wrong rule for them and applying it here would red a deliberate pin.
//
// THE RULE — a pin must be `"*"` / `workspace:*` (always a workspace link) OR an
// exact semver that EQUALS the sibling's workspace version. Stated the useful
// way: `npm ci` must produce a symlink, never a nested install.
//
// Note that this is one notch LOOSER than the prose rule in AGENTS.md ("Never
// reintroduce an exact version pin between them"), which admits no exact pin at
// all. Every internal pin in the tree is `"*"` today, so the tolerance is unused;
// tightening the gate onto the prose rule would delete the version-comparison
// branch below entirely. That is F-1126's contract to change, not F-1231's.

import { globSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const SCOPE = "@pome-sh/";

// SCOPE IS THE ROOT `workspaces` FIELD, not a list in this file. Every member is
// both a consumer (its pins are checked) and a sibling (it can be pinned AT),
// because npm's resolution makes no distinction: `cli` is a workspace member, so
// a `packages/*` package pinning a stale `@pome-sh/cli` would get a nested
// registry copy exactly as it would for the sdk. A hardcoded `packages/*` + `cli`
// pair silently stops covering its subject the moment root grows a glob or the
// CLI moves directory — which it has done twice (#237, #239). An empty result
// throws rather than reporting a pass over nothing.
// Shared with `scripts/check-example-pins-published.mjs` (F-1483): that gate
// needs the same sibling-name → workspace-version map to know which
// `examples/*` pins have a sibling to compare against, and duplicating this
// walk would let the two derivations disagree about what a "sibling" is.
export function loadWorkspaceMembers(repoRoot) {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const relativePaths = (root.workspaces ?? []).flatMap((pattern) =>
    globSync(join(pattern, "package.json"), { cwd: repoRoot }),
  );
  if (relativePaths.length === 0) {
    throw new Error(
      `no workspace manifests found under ${repoRoot} for workspaces ${JSON.stringify(root.workspaces)}`,
    );
  }
  return relativePaths.map((relativePath) => ({
    manifest: JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")),
    label: dirname(relativePath),
  }));
}

export function findPinViolations(repoRoot) {
  const members = loadWorkspaceMembers(repoRoot);
  const manifests = new Map(members.map((member) => [member.manifest.name, member]));

  const violations = [];
  for (const { manifest, label } of members) {
    // `optionalDependencies` is a real install field, not a comment: npm
    // resolves it exactly like `dependencies` and only tolerates a FAILED
    // install, so a stale exact pin there installs a nested registry copy just
    // as silently as one in `dependencies`.
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const [dep, pin] of Object.entries(manifest[field] ?? {})) {
        if (!dep.startsWith(SCOPE)) continue;
        const sibling = manifests.get(dep);
        // A `@pome-sh/*` dep naming no workspace member is out of scope: nothing
        // in this tree could satisfy it, so npm installing from the registry is
        // the only possible and the correct behaviour.
        if (!sibling) continue;
        // Lane A / workspace unification: `"*"` (and `workspace:*`) always
        // resolves to the local sibling via npm workspaces, so it cannot
        // silently pull a nested registry copy. Exact pins remain required to
        // MATCH the sibling when they are used.
        if (pin === "*" || pin === "workspace:*") continue;
        // EVERY OTHER FORM IS REFUSED ON LEGIBILITY, not because each one would
        // resolve from the registry — some would not. `file:`/`link:` to a
        // sibling directory produce a link and cannot reach a registry at all,
        // and a `^`/`~`/`>=` range that happens to admit the sibling's current
        // version resolves to the workspace today. What none of them do is
        // GUARANTEE it tomorrow: the range stops admitting the sibling on its
        // next bump, and `file:` re-encodes a path npm workspaces already knows,
        // so it drifts on the next directory move. `"*"` is the only form that
        // cannot express a version at all, which is why it is the rule.
        if (!EXACT_VERSION.test(pin)) {
          violations.push(
            `${label} (${manifest.name}): ${field}.${dep} is "${pin}" — @pome-sh/* pins must be exact semver, "*", or "workspace:*"`,
          );
          continue;
        }
        if (pin !== sibling.manifest.version) {
          violations.push(
            `${label} (${manifest.name}): ${field}.${dep} pins ${pin} but ${sibling.label} ` +
              `is ${sibling.manifest.version}. npm will install the PUBLISHED ${pin} as a nested ` +
              `copy, so this package is built and tested against the registry rather than this tree.`,
          );
        }
      }
    }
  }
  return violations;
}

// Realpath'd on both sides — node resolves symlinks before deriving
// `import.meta.url`, so a bare `pathToFileURL(resolve(...))` of argv[1]
// misses through a symlinked checkout (a worktree, or macOS's symlinked
// `/tmp`) in the same silent shape (F-1488), and a guard miss while invoked
// as this file throws rather than exits 0.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("check-workspace-pins-match-workspace.mjs")) {
  throw new Error(
    `check-workspace-pins-match-workspace.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`
  );
}

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
    `✅ workspace pin parity OK: every @pome-sh/* pin across the root workspaces (${(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).workspaces ?? []).join(", ")}) resolves to its sibling.`,
  );
}
