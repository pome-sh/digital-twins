#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `check-example-pins-published.mjs` (F-1483). Pure
// functions, no network and no `npm ci` needed: `checkExamplePinsPublished`
// takes an injected `npmView`, and `discoverExampleRegistryPins` runs against
// a throwaway fixture tree built the same way
// `check-workspace-pins-match-workspace.test.mjs` builds one, since both
// gates read the same root `workspaces` shape.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkExamplePinsPublished,
  discoverExampleRegistryPins,
} from "./check-example-pins-published.mjs";

let failures = 0;
function fail(name, detail) {
  failures += 1;
  console.error(`✗ ${name}\n  ${detail}`);
}
function pass(name) {
  console.log(`✓ ${name}`);
}

/** A throwaway root with one workspace package and one example, mirroring the
 * real tree's `packages/adapter-claude-sdk` + `examples/support-triage`
 * shape. */
function fixture({ workspaceVersion, examplePin, exampleField = "dependencies", extraExamples = {} }) {
  const root = mkdtempSync(join(tmpdir(), "example-pins-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  mkdirSync(join(root, "packages", "adapter-claude-sdk"), { recursive: true });
  writeFileSync(
    join(root, "packages", "adapter-claude-sdk", "package.json"),
    JSON.stringify({ name: "@pome-sh/adapter-claude-sdk", version: workspaceVersion }),
  );
  mkdirSync(join(root, "examples", "support-triage"), { recursive: true });
  writeFileSync(
    join(root, "examples", "support-triage", "package.json"),
    JSON.stringify({
      name: "support-triage-example",
      [exampleField]: { "@pome-sh/adapter-claude-sdk": examplePin },
    }),
  );
  for (const [name, manifest] of Object.entries(extraExamples)) {
    mkdirSync(join(root, "examples", name), { recursive: true });
    writeFileSync(join(root, "examples", name, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

// 1. Discovery: an exact pin with a matching sibling is picked up, with the
// field it lives in and the workspace version to compare against.
{
  const root = fixture({ workspaceVersion: "0.3.3", examplePin: "0.3.1" });
  const pins = discoverExampleRegistryPins(root);
  if (
    pins.length === 1 &&
    pins[0].example === "support-triage" &&
    pins[0].field === "dependencies" &&
    pins[0].dep === "@pome-sh/adapter-claude-sdk" &&
    pins[0].pin === "0.3.1" &&
    pins[0].workspaceVersion === "0.3.3"
  ) {
    pass("1. discovery finds the exact pin and its sibling workspace version");
  } else {
    fail("1. discovery finds the exact pin and its sibling workspace version", JSON.stringify(pins));
  }
}

// 2. `"*"`, a range, and a `file:` link are not this gate's subject — an
// example consuming its adapter through the workspace (or a range) is a
// different, already-covered concern.
for (const pin of ["*", "^0.3.3", "file:../../packages/adapter-claude-sdk"]) {
  const root = fixture({ workspaceVersion: "0.3.3", examplePin: pin });
  const pins = discoverExampleRegistryPins(root);
  if (pins.length === 0) pass(`2. pin "${pin}" is out of scope (not an exact version)`);
  else fail(`2. pin "${pin}" is out of scope (not an exact version)`, JSON.stringify(pins));
}

// 3. A `@pome-sh/*` dep naming no workspace sibling is out of scope too —
// nothing in the tree to compare it against.
{
  const root = fixture({ workspaceVersion: "0.3.3", examplePin: "0.3.3" });
  writeFileSync(
    join(root, "examples", "support-triage", "package.json"),
    JSON.stringify({ dependencies: { "@pome-sh/nonexistent-sibling": "1.0.0" } }),
  );
  const pins = discoverExampleRegistryPins(root);
  if (pins.length === 0) pass("3. a pin with no workspace sibling is out of scope");
  else fail("3. a pin with no workspace sibling is out of scope", JSON.stringify(pins));
}

// 4. Zero eligible pins anywhere in `examples/*` must throw, not report a
// pass having checked nothing.
{
  const root = mkdtempSync(join(tmpdir(), "example-pins-empty-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  mkdirSync(join(root, "packages"), { recursive: true });
  mkdirSync(join(root, "examples", "no-pins-here"), { recursive: true });
  writeFileSync(join(root, "examples", "no-pins-here", "package.json"), JSON.stringify({ name: "x" }));
  try {
    discoverExampleRegistryPins(root);
    fail("4. zero eligible pins throws", "returned instead of throwing");
  } catch {
    pass("4. zero eligible pins throws");
  }
}

const pin = { example: "support-triage", field: "dependencies", dep: "@pome-sh/adapter-claude-sdk" };

// 5. Published sibling version, pin already matches — green, no skip.
{
  const result = checkExamplePinsPublished(
    [{ ...pin, pin: "0.3.3", workspaceVersion: "0.3.3" }],
    () => ({ status: "published" }),
  );
  if (result.violations.length === 0 && result.skips.length === 0 && result.errors.length === 0) {
    pass("5. matching pin against a published workspace version is clean");
  } else {
    fail("5. matching pin against a published workspace version is clean", JSON.stringify(result));
  }
}

// 6. THE LIVE-DEFECT SHAPE, break-on-purpose: published sibling version, pin
// STALE — must red, naming the example, the pin, and the workspace version.
{
  const result = checkExamplePinsPublished(
    [{ ...pin, pin: "0.3.1", workspaceVersion: "0.3.3" }],
    () => ({ status: "published" }),
  );
  const v = result.violations[0];
  if (
    result.violations.length === 1 &&
    v.example === "support-triage" &&
    v.pin === "0.3.1" &&
    v.workspaceVersion === "0.3.3"
  ) {
    pass("6. a stale pin against a published workspace version reds, naming example/pin/workspace version");
  } else {
    fail(
      "6. a stale pin against a published workspace version reds, naming example/pin/workspace version",
      JSON.stringify(result),
    );
  }
}

// 7. Workspace version NOT published (E404) — a named, counted SKIP, never a
// violation and never folded into "checked clean".
{
  const result = checkExamplePinsPublished(
    [{ ...pin, pin: "0.3.1", workspaceVersion: "9.9.9" }],
    () => ({ status: "unpublished" }),
  );
  if (
    result.violations.length === 0 &&
    result.skips.length === 1 &&
    result.skips[0].workspaceVersion === "9.9.9" &&
    result.errors.length === 0
  ) {
    pass("7. an unpublished workspace version is a counted, named skip, not a violation");
  } else {
    fail("7. an unpublished workspace version is a counted, named skip, not a violation", JSON.stringify(result));
  }
}

// 8. A registry error that is NOT "not found" (401/5xx/timeout) is a HARD
// FAILURE — never downgraded to a skip, even though it also means "cannot
// confirm the pin is current".
{
  const result = checkExamplePinsPublished(
    [{ ...pin, pin: "0.3.1", workspaceVersion: "0.3.3" }],
    () => ({ status: "error", detail: "E401 Unauthorized" }),
  );
  if (result.errors.length === 1 && result.skips.length === 0 && result.violations.length === 0) {
    pass("8. a non-404 registry error is a hard failure, not a skip");
  } else {
    fail("8. a non-404 registry error is a hard failure, not a skip", JSON.stringify(result));
  }
}

// 9. `defaultNpmView`'s own E404 classification, exercised through a mocked
// `npm` on PATH rather than the real registry — same technique
// `decide-publish.test.mjs` uses. A 404 (unpublished) must NOT be confused
// with a 401/5xx (hard error).
{
  const { chmodSync, mkdtempSync: mkdtemp, writeFileSync: write } = await import("node:fs");
  const { defaultNpmView } = await import("./check-example-pins-published.mjs");

  function withMockNpm(script, fn) {
    const dir = mkdtemp(join(tmpdir(), "mock-npm-"));
    const npmPath = join(dir, "npm");
    write(npmPath, `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(npmPath, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath}`;
    try {
      return fn();
    } finally {
      process.env.PATH = originalPath;
    }
  }

  withMockNpm('echo "npm error code E404" >&2; exit 1', () => {
    const result = defaultNpmView("@pome-sh/adapter-claude-sdk", "9.9.9");
    if (result.status === "unpublished") pass("9a. defaultNpmView classifies E404 as unpublished");
    else fail("9a. defaultNpmView classifies E404 as unpublished", JSON.stringify(result));
  });

  withMockNpm('echo "npm error code E401" >&2; exit 1', () => {
    const result = defaultNpmView("@pome-sh/adapter-claude-sdk", "0.3.3");
    if (result.status === "error") pass("9b. defaultNpmView classifies a non-404 error as a hard failure");
    else fail("9b. defaultNpmView classifies a non-404 error as a hard failure", JSON.stringify(result));
  });

  withMockNpm('echo "0.3.3"', () => {
    const result = defaultNpmView("@pome-sh/adapter-claude-sdk", "0.3.3");
    if (result.status === "published") pass("9c. defaultNpmView classifies a clean exit as published");
    else fail("9c. defaultNpmView classifies a clean exit as published", JSON.stringify(result));
  });
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nAll cases passed.");
