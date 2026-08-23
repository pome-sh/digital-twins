// SPDX-License-Identifier: Apache-2.0
//
// The `agent-examples/*` gate: typecheck, then test, each example in its own install.
//
// The bundled `agent-examples/*` projects are standalone npm packages (each with its
// own lockfile), NOT workspaces, so neither the root `npm run typecheck` nor the
// root `npm test` covers them. That gap is how a zod-4 / Claude Agent SDK
// `tool()` typing regression sat latent until this gate existed.
//
// The same gap had swallowed the examples' own TESTS for as long as they have
// existed. Four examples declare `"test": "vitest run"` and 49 test cases across
// five of those files ran nowhere at all: `npm test --workspaces` skips a
// non-workspace, no workflow invoked them, and
// `check-packages-scripts-wired.mjs` -- the gate whose whole subject is a
// declared check nothing runs -- scopes itself to `packages/*` and `cli/`, so it
// could not see them. (`agent-examples/triage-agent` is the exception: quickstart-
// smoke.yml runs its 4 tests, but only behind that workflow's path filter.)
//
// So the loop below runs `npm test --if-present` beside the typecheck it already
// ran, inside an `npm ci` it was already paying for. Discovery stays keyed on
// the `typecheck` script, so an example that adds tests later is covered with no
// edit here.
//
// Three of the four Claude-Agent-SDK examples consume
// `@pome-sh/adapter-claude-sdk` through a local `file:` link, so the adapter's
// `dist/` must be current before they can resolve its types. The gate rebuilds
// the adapter first (a fast incremental tsc) so it always reflects the adapter
// source in the working tree — a prior root `npm ci`/`npm install` must have
// populated node_modules.
//
// `agent-examples/support-triage` is the fourth and the exception: it pins the
// PUBLISHED adapter by exact version (#308), because its README documents it as
// standalone-fetchable via `npx degit`, which copies that subtree and nothing
// above it, so a `file:` path out of the tree breaks its `npm install`. So this
// gate typechecks that example against the registry artifact, NOT against the
// adapter source next to it — and nothing compared the two until this gate. It had
// drifted twice already (#308 off 0.2.5, then 0.3.1 against a workspace 0.3.3,
// which also dragged the retired `@pome-sh/shared-types` back into the
// example's install graph as 0.3.1's declared runtime dep) before anything
// watched it. `check-workspace-pins-match-workspace.mjs` cannot own that watch:
// it runs OFFLINE before `npm ci`, and "resolve to the workspace" is the wrong
// rule for a deliberately-published pin. The right rule — re-pin once the
// workspace version publishes, skip while it has not — needs the registry, so
// it runs here, in `check-example-pins-published.mjs`'s
// `reportExamplePinParity()`, right where every example is already `npm ci`'d
// against that same registry.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { reportExamplePinParity } from "./check-example-pins-published.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(repoRoot, "agent-examples");

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function discoverExamples() {
  const found = [];
  for (const name of readdirSync(examplesDir).sort()) {
    const pkgPath = join(examplesDir, name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.scripts?.typecheck || pkg.scripts?.test) found.push(name);
  }
  return found;
}

const examples = discoverExamples();
if (examples.length === 0) {
  console.error("No examples with a `typecheck` or `test` script found.");
  process.exit(1);
}

// Build the adapter so the file:-linked examples typecheck against current source.
console.log("Building @pome-sh/adapter-claude-sdk…");
try {
  run("npm", ["run", "build", "-w", "@pome-sh/adapter-claude-sdk"], repoRoot);
} catch {
  console.error(
    "Failed to build @pome-sh/adapter-claude-sdk. Run `npm ci` at the repo root first.",
  );
  process.exit(1);
}

const failures = [];
for (const name of examples) {
  const cwd = join(examplesDir, name);
  console.log(`\n=== agent-examples/${name} ===`);
  try {
    run("npm", ["ci"], cwd);
  } catch {
    failures.push(`${name} (install)`);
    console.error(`agent-examples/${name}: FAILED (install)`);
    continue;
  }
  // One try PER LEG, not one around both. With both in a single try a tsc error
  // stopped that example's tests from running at all, so a type error and a test
  // regression in the same commit took two CI rounds to see — and "a check that
  // silently stops running behind another check's failure" is the exact shape the
  // pin-parity note below calls this milestone's whole subject. Putting the test
  // leg behind the typecheck leg would have re-armed it one directory over.
  const broke = [];
  for (const [leg, args] of [
    ["typecheck", ["run", "typecheck"]],
    // --if-present: only four of the eight examples ship a test script, and an
    // example without one is not a failure.
    ["test", ["test", "--if-present"]],
  ]) {
    try {
      run("npm", args, cwd);
    } catch {
      broke.push(leg);
    }
  }
  if (broke.length === 0) {
    console.log(`agent-examples/${name}: OK`);
  } else {
    failures.push(`${name} (${broke.join(" + ")})`);
    console.error(`agent-examples/${name}: FAILED (${broke.join(" + ")})`);
  }
}

if (failures.length > 0) {
  console.error(`\nExamples failing: ${failures.join(", ")}`);
} else {
  console.log(`\nAll ${examples.length} examples typechecked and tested clean.`);
}

// Confirm each bundled example's exact `@pome-sh/*` pin still equals
// the sibling workspace version wherever that version is published.
//
// Deliberately NOT behind the typecheck exit above. It used to be, and that
// made an unrelated tsc error in ANY example (say `agent-examples/merge-agent`) hide a
// real published-pin drift until someone fixed the typecheck and CI came round
// again — a check that silently stops running behind another check's failure is
// this milestone's whole subject. It reads manifests and calls the registry, so
// it needs none of the installs above to have succeeded.
console.log("\n=== agent-examples/* pin↔registry parity ===");
const parityOk = reportExamplePinParity(repoRoot);
if (!parityOk) {
  console.error(
    "\nA pin drifted from a workspace version that is already published, a pin has no single version " +
      "to watch at all, or the registry could not be read for a reason other than 'unpublished'. See above.",
  );
}

if (failures.length > 0 || !parityOk) process.exit(1);
