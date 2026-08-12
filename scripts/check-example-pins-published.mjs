// SPDX-License-Identifier: Apache-2.0
//
// F-1483 — `examples/*` pins a PUBLISHED `@pome-sh/*` version on purpose
// (`examples/support-triage` documents why in `typecheck-examples.mjs`'s
// header: it is `npx degit`-fetchable as a standalone subtree, so a `file:`
// link out of its own directory would break its `npm install`). Nothing
// watched that pin drift out from under the sibling workspace version twice
// (#308 off 0.2.5, then off 0.3.1 — the second time dragging the retired
// `@pome-sh/shared-types` back into the example's install graph as a runtime
// dependency, F-942 instantiated in the one example that exists to demonstrate
// a correctly-joined trace).
//
// `check-workspace-pins-match-workspace.mjs` cannot own this: it runs OFFLINE
// before `npm ci`, and its rule ("a `@pome-sh/*` dep must resolve to the
// workspace") is the wrong rule for a pin that is published on purpose. This
// gate needs the registry, so it lives where `examples/*` are already
// installed — `typecheck-examples.mjs` already runs `npm ci` per example in
// CI's heavy (networked) job — rather than standing up a second CI mechanism.
//
// THE RULE, in two parts:
//   1. If the sibling WORKSPACE version is published to the registry, the
//      example's pin must equal it exactly. A published sibling version is
//      the only artifact anyone could have meant to pin, so any other exact
//      value is drift.
//   2. If the workspace version is NOT yet published (the ordinary cloud-first
//      state — `packages/` bumps and merges before its release job runs),
//      that is a named, counted SKIP, never a silent pass and never treated as
//      a violation.
//
// A registry answer that is neither "found" nor "genuinely unpublished" (a
// 401, a 5xx, a timeout, a rate limit) is a HARD FAILURE, not a skip — treating
// it as unpublished would let a transient registry outage wave through a real
// drift. This mirrors `scripts/ci/decide-publish.sh`'s own stance: `npm view`
// exiting non-zero with `E404` in its stderr means "not found", anything else
// means "ask again", and only the former may stand in for "unpublished".
//
// Only EXACT semver pins are this gate's subject. A `@pome-sh/*` dep with no
// workspace sibling, or pinned `"*"`/`file:`/a range, is out of scope the same
// way `check-workspace-pins-match-workspace.mjs` documents for `examples/*` as
// a whole — those forms cannot silently swap in a stale published artifact the
// way an exact pin can, so there is nothing here for this gate to compare.
//
// Discovery, not a list: every `examples/*/package.json`, walked fresh each
// run, is the corpus — so a new example shipping its own published pin is
// covered with no edit here.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadWorkspaceMembers } from "./check-workspace-pins-match-workspace.mjs";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const SCOPE = "@pome-sh/";
const INSTALL_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * Every `@pome-sh/*` pin under `examples/*` that names an exact semver AND has
 * a same-named sibling among the root workspace members — the population this
 * gate's rule applies to. Discovered fresh each run, never a hand-kept list of
 * examples or packages.
 */
export function discoverExampleRegistryPins(repoRoot) {
  const examplesDir = join(repoRoot, "examples");
  const siblingsByName = new Map(
    loadWorkspaceMembers(repoRoot).map((member) => [member.manifest.name, member]),
  );

  const pins = [];
  for (const name of readdirSync(examplesDir).sort()) {
    const pkgPath = join(examplesDir, name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const field of INSTALL_FIELDS) {
      for (const [dep, pin] of Object.entries(pkg[field] ?? {})) {
        if (!dep.startsWith(SCOPE)) continue;
        const sibling = siblingsByName.get(dep);
        if (!sibling) continue; // no workspace sibling to compare a published pin against
        if (!EXACT_VERSION.test(pin)) continue; // "*"/file:/range — not this gate's subject
        pins.push({ example: name, field, dep, pin, workspaceVersion: sibling.manifest.version });
      }
    }
  }
  return pins;
}

/**
 * `npm view <name>@<version> version` against the real registry. Returns
 * `{ status: "published" }`, `{ status: "unpublished" }` (E404 — genuinely no
 * such version), or `{ status: "error", detail }` for anything else (auth,
 * network, rate-limit, 5xx) — the same three-way split
 * `scripts/ci/decide-publish.sh` draws, because only an E404 may stand in for
 * "not published yet".
 */
export function defaultNpmView(name, version) {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { status: "published" };
  } catch (err) {
    const stderr = String(err.stderr ?? err.message ?? "");
    if (/\bE404\b/.test(stderr)) return { status: "unpublished" };
    return { status: "error", detail: stderr.trim() || String(err) };
  }
}

/**
 * Apply the rule to a discovered pin list. `npmView` is injectable so the
 * regression suite can exercise all three registry outcomes without a
 * network.
 *
 * Returns:
 *   - `violations`: pin !== workspace version, where the workspace version IS
 *     published — a real drift, naming the example, the pin, and the
 *     workspace version.
 *   - `skips`: workspace version is not (yet) published — the legitimate
 *     cloud-first ordering, counted and named, never rendered as a pass.
 *   - `errors`: the registry answered something other than found/E404 — a
 *     hard failure, never downgraded to a skip.
 */
export function checkExamplePinsPublished(pins, npmView = defaultNpmView) {
  const violations = [];
  const skips = [];
  const errors = [];
  for (const pin of pins) {
    const result = npmView(pin.dep, pin.workspaceVersion);
    if (result.status === "error") {
      errors.push({ ...pin, detail: result.detail });
    } else if (result.status === "unpublished") {
      skips.push(pin);
    } else if (pin.pin !== pin.workspaceVersion) {
      violations.push(pin);
    }
  }
  return { checked: pins.length, violations, skips, errors };
}

/**
 * Run discovery + the registry check and print a report in the shape
 * `typecheck-examples.mjs` expects: throws on zero eligible pins (a check
 * examining nothing must not report a pass), prints the skip count even when
 * everything else is green, and returns `true`/`false` for the caller to fold
 * into its own exit code.
 */
export function reportExamplePinParity(repoRoot, npmView = defaultNpmView) {
  const pins = discoverExampleRegistryPins(repoRoot);
  if (pins.length === 0) {
    throw new Error(
      "check-example-pins-published found zero @pome-sh/* exact-version pins under examples/* — " +
        "refusing to report a pass having checked nothing (was support-triage's pin moved to a range or a file: link?)",
    );
  }

  const { checked, violations, skips, errors } = checkExamplePinsPublished(pins, npmView);

  if (errors.length > 0) {
    console.error(`\n❌ registry lookup FAILED for ${errors.length} pin(s) (not a skip — a real error):\n`);
    for (const e of errors) {
      console.error(`  examples/${e.example} (${e.field}.${e.dep}@${e.workspaceVersion}): ${e.detail}`);
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ published pin DRIFT in ${violations.length} example(s):\n`);
    for (const v of violations) {
      console.error(
        `  examples/${v.example} (${v.field}.${v.dep}): pins ${v.pin}, but the workspace sibling is ` +
          `${v.workspaceVersion} and ${v.workspaceVersion} is published. Re-pin to ${v.workspaceVersion}.`,
      );
    }
  }

  if (skips.length > 0) {
    console.log(`\n⚠️  skipped ${skips.length} pin(s) — sibling workspace version not yet published:`);
    for (const s of skips) {
      console.log(`  examples/${s.example} (${s.field}.${s.dep}): workspace is ${s.workspaceVersion}, pin is ${s.pin}`);
    }
  }

  const ok = violations.length === 0 && errors.length === 0;
  const passed = checked - violations.length - skips.length - errors.length;
  console.log(
    `\nexample pin↔registry parity: ${passed} matched, ${skips.length} skipped (unpublished), ` +
      `${violations.length} drifted, ${errors.length} errored (of ${checked} checked).`,
  );
  return ok;
}
