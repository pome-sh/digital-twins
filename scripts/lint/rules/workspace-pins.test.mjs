#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for workspace-pins. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPinViolations } from "./workspace-pins.mjs";

function fixture(packageManifests, cliManifest) {
  const root = mkdtempSync(join(tmpdir(), "workspace-pins-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*", "cli"] }, null, 2),
  );
  mkdirSync(join(root, "packages"), { recursive: true });
  for (const [dir, manifest] of Object.entries(packageManifests)) {
    const pkgDir = join(root, "packages", dir);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest, null, 2));
  }
  mkdirSync(join(root, "cli"), { recursive: true });
  writeFileSync(
    join(root, "cli", "package.json"),
    JSON.stringify(cliManifest ?? { name: "@pome-sh/cli", version: "0.23.19" }, null, 2),
  );
  return root;
}

let failures = 0;
function fail(name, detail) {
  failures += 1;
  console.error(`✗ ${name}\n  ${detail}`);
}

function expectGate(name, root, expected, mustSay = []) {
  const violations = findPinViolations(root);
  const got = violations.length === 0 ? "green" : "red";
  if (got !== expected) {
    fail(name, `expected ${expected}, got ${got}\n${violations.join("\n")}`);
    return;
  }
  const joined = violations.join("\n");
  const missing = mustSay.filter((needle) => !joined.includes(needle));
  if (missing.length > 0) {
    fail(name, `message omits ${JSON.stringify(missing)}:\n  ${joined}`);
    return;
  }
  console.log(`✓ ${name}${violations.length ? "\n  " + violations.join("\n  ") : ""}`);
}

function expectThrows(name, root) {
  try {
    findPinViolations(root);
  } catch {
    console.log(`✓ ${name}`);
    return;
  }
  fail(name, "returned a verdict instead of throwing");
}

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

expectGate(
  "3. packages/* pin behind the workspace sibling reds (the original case)",
  fixture({
    sdk: { name: "@pome-sh/sdk", version: "0.9.0" },
    "twin-slack": {
      name: "@pome-sh/twin-slack",
      version: "1.0.0",
      dependencies: { "@pome-sh/sdk": "0.5.1" },
    },
  }),
  "red",
  ["packages/twin-slack", "0.5.1", "0.9.0"],
);

expectGate(
  "4. cli/package.json reintroducing a stale exact pin reds (the cli regression)",
  fixture(
    { wire: { name: "@pome-sh/wire", version: "0.14.0" } },
    { name: "@pome-sh/cli", version: "0.23.19", devDependencies: { "@pome-sh/wire": "0.13.4" } },
  ),
  "red",
  ["cli", "0.13.4", "0.14.0"],
);

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
    `4b. cli pin "${pin}" reds — "*" and an exact match are the only two forms`,
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

expectGate(
  "5. cli dep with no packages/ sibling is out of scope",
  fixture({}, { name: "@pome-sh/cli", version: "0.23.19", devDependencies: { "@pome-sh/other": "1.0.0" } }),
  "green",
);

{
  const root = mkdtempSync(join(tmpdir(), "workspace-pins-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*", "cli"] }),
  );
  expectThrows("6. a declared workspace with no manifest anywhere throws", root);
}

expectGate(
  "7. a packages/* package pinning a stale @pome-sh/cli reds — cli is a sibling too",
  fixture(
    {
      "twin-github": {
        name: "@pome-sh/twin-github",
        version: "1.0.0",
        dependencies: { "@pome-sh/cli": "0.23.18" },
      },
    },
    { name: "@pome-sh/cli", version: "0.23.19" },
  ),
  "red",
  ["packages/twin-github", "0.23.18", "0.23.19"],
);

{
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const workspaces = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).workspaces;
  if (!workspaces?.includes("cli")) {
    fail("8. the real root `workspaces` still names `cli`", `got ${JSON.stringify(workspaces)}`);
  } else {
    console.log("8. the real root `workspaces` still names `cli`");
  }
  expectGate("8b. the real repo is clean", repoRoot, "green");
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nAll cases passed.");
