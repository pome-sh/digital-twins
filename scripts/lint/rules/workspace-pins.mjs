// SPDX-License-Identifier: Apache-2.0
//
// One workspace member's `@pome-sh/*` pin must not disagree with the version of
// the sibling it names.
//
// npm workspaces only SYMLINK a sibling when the declared pin is satisfied by
// that sibling's version. When it is not, npm quietly installs a REAL nested
// copy from the registry, and every build, test and typecheck for that package
// runs against the published artifact instead of the tree in front of you.
//
// That is not hypothetical. At `45b5f06`, `packages/twin-slack` declared
// `@pome-sh/sdk` 0.5.1 against a workspace holding 0.9.0, so
// `packages/twin-slack/node_modules/@pome-sh/sdk` was a real directory
// containing the published 0.5.1 — five minors behind — and had been for months.
// CI was green throughout, because everything it ran for twin-slack genuinely
// passed against a five-month-old sdk. `twin-github`, whose pin matched, had no
// nested copy at all. Nothing compared the two. It surfaced only when a caller
// imported a subpath 0.5.1 does not export; a change that had merely CHANGED
// behaviour rather than added an export would have been tested against the wrong
// artifact in silence.
//
// NOT in scope: `agent-examples/*`. Those are standalone npm packages with their
// own lockfiles that install from the REGISTRY on purpose, so "must resolve to
// the workspace" is the wrong rule for them and applying it here would red a
// deliberate pin. `check-example-pins-published.mjs` is their half.
//
// THE RULE — a pin must be `"*"` / `workspace:*` (always a workspace link) OR an
// exact semver that EQUALS the sibling's workspace version. Stated the useful
// way: `npm ci` must produce a symlink, never a nested install.
//
// This is one notch LOOSER than the prose rule in AGENTS.md ("Never reintroduce
// an exact version pin between them"), which admits no exact pin at all. Every
// internal pin in the tree is `"*"` today, so the tolerance is unused;
// tightening onto the prose rule would delete the version-comparison branch
// below entirely. That is the packages-sibling contract to change, not this one.

import { loadWorkspaceMembers } from "../../lib/workspace-members.mjs";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const SCOPE = "@pome-sh/";

// `optionalDependencies` is a real install field, not a comment: npm resolves it
// exactly like `dependencies` and only tolerates a FAILED install, so a stale
// exact pin there installs a nested registry copy just as silently.
const PIN_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

export function findPinViolations(repoRoot) {
  const members = loadWorkspaceMembers(repoRoot);
  const manifests = new Map(members.map((member) => [member.manifest.name, member]));

  const violations = [];
  for (const { manifest, label } of members) {
    for (const field of PIN_FIELDS) {
      for (const [dep, pin] of Object.entries(manifest[field] ?? {})) {
        if (!dep.startsWith(SCOPE)) continue;
        const sibling = manifests.get(dep);
        // A `@pome-sh/*` dep naming no workspace member is out of scope: nothing
        // in this tree could satisfy it, so npm installing from the registry is
        // the only possible and the correct behaviour.
        if (!sibling) continue;
        // `"*"` (and `workspace:*`) always resolves to the local sibling via npm
        // workspaces, so it cannot silently pull a nested registry copy.
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

export default {
  name: "workspace-pins",
  describe: "every @pome-sh/* pin resolves to its workspace sibling, never a nested registry copy",
  check(ctx) {
    const violations = findPinViolations(ctx.root);
    return {
      violations,
      summary: `every @pome-sh/* pin across ${(ctx.json("package.json").workspaces ?? []).join(", ")} resolves to its sibling`,
      hint:
        'Set each pin to "*" (or the sibling\'s exact version in packages/). A mismatched or\n' +
        "unnecessary exact pin does not fail loudly — it silently swaps the workspace tree for\n" +
        "a published tarball.",
    };
  },
};
