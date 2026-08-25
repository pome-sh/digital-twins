// SPDX-License-Identifier: Apache-2.0
//
// Internal `@pome-sh/*` deps are `"*"`; an exact pin between siblings installs a
// second registry copy and you get two zod identities. Reads the root `workspaces`
// field rather than its own package list, so `cli/` cannot fall out of scope.

import { loadWorkspaceMembers } from "../../lib/workspace-members.mjs";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const SCOPE = "@pome-sh/";

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
        if (!sibling) continue;
        if (pin === "*" || pin === "workspace:*") continue;
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
