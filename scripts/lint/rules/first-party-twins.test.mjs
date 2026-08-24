#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The old gate shipped with no case table, for a rule that compares twelve
// registration seams against one canonical list. Every case here adds a twin to
// the canonical set and leaves exactly ONE seam behind, which is the drift the
// rule exists to catch: the explicit arrays are easy to update incompletely, and
// a twin missing from any one of them fails at a different, later, quieter place.
//
// Case "a renamed array" is the other half: a seam whose array this rule can no
// longer find must be a hard failure, not a silently uncompared seam.

import { defineCases } from "../harness.mjs";

const TWINS = ["github", "slack"];

/** Every seam, agreeing on `twins`, with `overrides` applied afterwards. */
function tree(twins = TWINS, overrides = {}) {
  const quoted = twins.map((twin) => `"${twin}"`).join(", ");
  const files = {
    "config/first-party-twins.json": JSON.stringify({ twins }),
    "cli/src/contract/sessions.ts": `export const MOUNTED_TWINS = [${quoted}] as const;\n`,
    "packages/wire/src/recorder-events.ts": `export const KNOWN_TWIN_IDS = [${quoted}] as const;\n`,
    "cli/src/twin/registry.ts": `export const TWIN_NAME_LIST = [${quoted}] as const;\n`,
    "packages/checks/src/index.ts": `export const CHECKS_TWIN_NAMES = [${quoted}] as const;\n`,
    "packages/sandbox-domains/src/index.ts": `export const SANDBOX_DOMAIN_NAMES = [${quoted}] as const;\n`,
    "contract/helpers.mjs": twins
      .map((twin) => `  { name: "${twin}", pkg: "packages/twin-${twin}" },`)
      .join("\n"),
    "contract/cli-start.test.mjs": twins.map((twin) => `await cliStart("${twin}");`).join("\n"),
    "cli/package.json": JSON.stringify({
      name: "@pome-sh/cli",
      devDependencies: Object.fromEntries(twins.map((twin) => [`@pome-sh/twin-${twin}`, "*"])),
    }),
    "cli/src/cli/tasks-catalog.ts": twins.map((twin) => `    id: "${twin}",`).join("\n"),
    ".github/workflows/twin-image.yml":
      `# FIRST_PARTY_TWINS: ${twins.join(", ")}\n` +
      twins.map((twin) => `      - "packages/twin-${twin}/**"`).join("\n") +
      "\n",
    ".github/workflows/agent-trace-overhead-gate.yml":
      twins.map((twin) => `      - "packages/twin-${twin}/**"`).join("\n") + "\n",
  };
  return { ...files, ...overrides };
}

/** Every seam updated for a new twin EXCEPT the one named. */
function allButOne(seam) {
  const added = [...TWINS, "linear"];
  return { ...tree(added), [seam]: tree(TWINS)[seam] };
}

defineCases("first-party-twins", [
  {
    name: "every seam agreeing with the canonical list passes",
    files: tree(),
    expect: "green",
    contains: "registrations agree: github, slack",
  },
  {
    name: "a twin missing from the contract session mount is a violation",
    files: allButOne("cli/src/contract/sessions.ts"),
    expect: "red",
    contains: "MOUNTED_TWINS",
  },
  {
    name: "a twin missing from the wire event enum is a violation",
    files: allButOne("packages/wire/src/recorder-events.ts"),
    expect: "red",
    contains: "KNOWN_TWIN_IDS",
  },
  {
    // A criterion that silently never binds is the failure this seam prevents.
    name: "a twin missing from the checks vocabulary is a violation",
    files: allButOne("packages/checks/src/index.ts"),
    expect: "red",
    contains: "CHECKS_TWIN_NAMES",
  },
  {
    // One step worse: it compiles, and the criteria bind against a vocabulary
    // whose runtime pome-cloud cannot construct at all.
    name: "a twin missing from the sandbox domains is a violation",
    files: allButOne("packages/sandbox-domains/src/index.ts"),
    expect: "red",
    contains: "SANDBOX_DOMAIN_NAMES",
  },
  {
    name: "a twin missing from the black-box contract suite is a violation",
    files: allButOne("contract/helpers.mjs"),
    expect: "red",
    contains: "contract/helpers.mjs",
  },
  {
    // A twin missing from the devDependency list would not install, and its
    // registry entry's `import()` would not resolve.
    name: "a twin missing from the CLI's devDependencies is a violation",
    files: allButOne("cli/package.json"),
    expect: "red",
    contains: "cli/package.json devDependencies",
  },
  {
    name: "a twin missing from the image matrix is a violation",
    files: allButOne(".github/workflows/twin-image.yml"),
    expect: "red",
    contains: "twin-image.yml",
  },
  {
    // The path filter is separate from the matrix: a workflow that never triggers
    // for a twin is a workflow that does not cover it.
    name: "a missing workflow path filter is a violation",
    files: allButOne(".github/workflows/agent-trace-overhead-gate.yml"),
    expect: "red",
    contains: "missing packages/twin-linear/** path filter",
  },
  {
    // A seam this rule can no longer find is a seam it stopped comparing.
    name: "an array renamed out from under the rule is red, not silently uncompared",
    files: tree(TWINS, {
      "cli/src/twin/registry.ts": `export const TWIN_NAMES = ["github", "slack"] as const;\n`,
    }),
    expect: "red",
    contains: "could not find array TWIN_NAME_LIST",
  },
]);
