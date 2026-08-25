// SPDX-License-Identifier: Apache-2.0
//
// Typechecks and tests every example in its own install. The pin-parity leg is
// deliberately NOT behind the typecheck exit: a check that stops running behind
// another check's failure is the shape this file exists to avoid.
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
  const broke = [];
  for (const [leg, args] of [
    ["typecheck", ["run", "typecheck"]],
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

console.log("\n=== agent-examples/* pin↔registry parity ===");
const parityOk = reportExamplePinParity(repoRoot);
if (!parityOk) {
  console.error(
    "\nA pin drifted from a workspace version that is already published, a pin has no single version " +
      "to watch at all, or the registry could not be read for a reason other than 'unpublished'. See above.",
  );
}

if (failures.length > 0 || !parityOk) process.exit(1);
