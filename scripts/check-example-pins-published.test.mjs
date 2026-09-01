#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for check-example-pins-published. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkExamplePinsPublished,
  discoverExampleSiblingDeps,
  planExampleRepins,
  reportExamplePinParity,
} from "./check-example-pins-published.mjs";

let failures = 0;
function fail(name, detail) {
  failures += 1;
  console.error(`✗ ${name}\n  ${detail}`);
}
function pass(name) {
  console.log(`✓ ${name}`);
}

function fixture({ workspaceVersion, examplePin, exampleField = "dependencies", extraExamples = {} }) {
  const root = mkdtempSync(join(tmpdir(), "example-pins-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  mkdirSync(join(root, "packages", "adapter-claude-sdk"), { recursive: true });
  writeFileSync(
    join(root, "packages", "adapter-claude-sdk", "package.json"),
    JSON.stringify({ name: "@pome-sh/adapter-claude-sdk", version: workspaceVersion }),
  );
  mkdirSync(join(root, "agent-examples", "support-triage"), { recursive: true });
  writeFileSync(
    join(root, "agent-examples", "support-triage", "package.json"),
    JSON.stringify({
      name: "support-triage-example",
      [exampleField]: { "@pome-sh/adapter-claude-sdk": examplePin },
    }),
  );
  for (const [name, manifest] of Object.entries(extraExamples)) {
    mkdirSync(join(root, "agent-examples", name), { recursive: true });
    writeFileSync(join(root, "agent-examples", name, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

{
  const root = fixture({ workspaceVersion: "0.3.3", examplePin: "0.3.1" });
  const { exact } = discoverExampleSiblingDeps(root);
  if (
    exact.length === 1 &&
    exact[0].example === "support-triage" &&
    exact[0].field === "dependencies" &&
    exact[0].dep === "@pome-sh/adapter-claude-sdk" &&
    exact[0].pin === "0.3.1" &&
    exact[0].workspaceVersion === "0.3.3"
  ) {
    pass("1. discovery finds the exact pin and its sibling workspace version");
  } else {
    fail("1. discovery finds the exact pin and its sibling workspace version", JSON.stringify(exact));
  }
}

for (const pin of ["file:../../packages/adapter-claude-sdk", "link:../../packages/adapter-claude-sdk"]) {
  const root = fixture({ workspaceVersion: "0.3.3", examplePin: pin });
  const { exact, linked, unwatchable } = discoverExampleSiblingDeps(root);
  if (exact.length === 0 && linked.length === 1 && unwatchable.length === 0) {
    pass(`2. pin "${pin}" is counted as a workspace link, not an exact pin`);
  } else {
    fail(`2. pin "${pin}" is counted as a workspace link, not an exact pin`, JSON.stringify({ exact, linked, unwatchable }));
  }
}

for (const pin of ["*", "^0.3.3", "~0.3.1", "0.3.x", ">=0.3.0", "latest", "npm:@pome-sh/adapter-claude-sdk@0.3.3"]) {
  const root = fixture({ workspaceVersion: "0.3.3", examplePin: pin });
  const { exact, linked, unwatchable } = discoverExampleSiblingDeps(root);
  if (exact.length === 0 && linked.length === 0 && unwatchable.length === 1) {
    pass(`3. pin "${pin}" is reported as unwatchable, not skipped`);
  } else {
    fail(`3. pin "${pin}" is reported as unwatchable, not skipped`, JSON.stringify({ exact, linked, unwatchable }));
  }
}

{
  const root = fixture({
    workspaceVersion: "0.3.3",
    examplePin: "^0.3.3",
    extraExamples: {
      "other-example": { name: "other", dependencies: { "@pome-sh/adapter-claude-sdk": "0.3.3" } },
    },
  });
  const ok = reportExamplePinParity(root, () => ({ status: "published" }));
  if (ok === false) pass("3b. an unwatchable pin reds even when another exact pin matches cleanly");
  else fail("3b. an unwatchable pin reds even when another exact pin matches cleanly", `returned ${ok}`);
}

{
  const root = fixture({
    workspaceVersion: "0.3.3",
    examplePin: "file:../../packages/adapter-claude-sdk",
    extraExamples: { "no-pins-here": { name: "x" } },
  });
  let calls = 0;
  try {
    const ok = reportExamplePinParity(root, () => {
      calls += 1;
      return { status: "published" };
    });
    fail("4. zero exact pins throws", `returned ${ok} after ${calls} registry call(s) instead of throwing`);
  } catch (err) {
    if (/zero exact-version/.test(err.message)) pass("4. zero exact pins throws, naming the floor it hit");
    else fail("4. zero exact pins throws, naming the floor it hit", `threw for another reason: ${err.message}`);
  }
}

{
  const root = fixture({ workspaceVersion: "0.3.3", examplePin: "0.3.3" });
  writeFileSync(
    join(root, "agent-examples", "support-triage", "package.json"),
    JSON.stringify({ dependencies: { "@pome-sh/nonexistent-sibling": "1.0.0" } }),
  );
  const { exact, linked, unwatchable } = discoverExampleSiblingDeps(root);
  if (exact.length === 0 && linked.length === 0 && unwatchable.length === 0) {
    pass("4b. a pin with no workspace sibling is out of scope");
  } else {
    fail("4b. a pin with no workspace sibling is out of scope", JSON.stringify({ exact, linked, unwatchable }));
  }
}

{
  // No example depends on any @pome-sh/* package at all — the state once the
  // adapter is removed from every example. This is a legitimate clean pass, not
  // a blind spot, so parity holds vacuously instead of throwing.
  const root = fixture({ workspaceVersion: "0.3.3", examplePin: "0.3.3" });
  writeFileSync(
    join(root, "agent-examples", "support-triage", "package.json"),
    JSON.stringify({ dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.221" } }),
  );
  let calls = 0;
  const ok = reportExamplePinParity(root, () => {
    calls += 1;
    return { status: "published" };
  });
  if (ok === true && calls === 0) {
    pass("4c. zero @pome-sh/* example deps is a vacuous pass, not a throw");
  } else {
    fail("4c. zero @pome-sh/* example deps is a vacuous pass, not a throw", `ok=${ok} after ${calls} registry call(s)`);
  }
}

const pin = { example: "support-triage", field: "dependencies", dep: "@pome-sh/adapter-claude-sdk" };

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

{
  const { chmodSync, mkdtempSync: mkdtemp, readFileSync, writeFileSync: write } = await import("node:fs");
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
    const result = defaultNpmView("@pome-sh/adapter-claude-sdk", "0.3.3", { attempts: 1 });
    if (result.status === "error") pass("9b. defaultNpmView classifies a non-404 error as a hard failure");
    else fail("9b. defaultNpmView classifies a non-404 error as a hard failure", JSON.stringify(result));
  });

  withMockNpm('echo "0.3.3"', () => {
    const result = defaultNpmView("@pome-sh/adapter-claude-sdk", "0.3.3");
    if (result.status === "published") pass("9c. defaultNpmView classifies a clean exit as published");
    else fail("9c. defaultNpmView classifies a clean exit as published", JSON.stringify(result));
  });

  withMockNpm("exit 1", () => {
    const result = defaultNpmView("@pome-sh/adapter-claude-sdk", "0.3.3", { attempts: 1 });
    if (result.status === "error" && result.detail) {
      pass("9d. defaultNpmView classifies an empty-stderr failure as an error, not unpublished");
    } else {
      fail("9d. defaultNpmView classifies an empty-stderr failure as an error, not unpublished", JSON.stringify(result));
    }
  });

  {
    const counter = join(mkdtemp(join(tmpdir(), "npm-attempts-")), "n");
    withMockNpm(
      `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${counter}"\n` +
        'if [ "$n" -lt 3 ]; then echo "npm error code E503" >&2; exit 1; fi\necho "0.3.3"',
      () => {
        const result = defaultNpmView("@pome-sh/adapter-claude-sdk", "0.3.3", { attempts: 3, delayMs: 0 });
        if (result.status === "published") pass("9e. a transient 5xx is retried, not turned straight into a red");
        else fail("9e. a transient 5xx is retried, not turned straight into a red", JSON.stringify(result));
      },
    );
  }

  withMockNpm('echo "npm error code E503" >&2; exit 1', () => {
    const result = defaultNpmView("@pome-sh/adapter-claude-sdk", "0.3.3", { attempts: 3, delayMs: 0 });
    if (result.status === "error" && result.attempts === 3) {
      pass("9f. a persistent error is still an error after all attempts");
    } else {
      fail("9f. a persistent error is still an error after all attempts", JSON.stringify(result));
    }
  });

  {
    const counter = join(mkdtemp(join(tmpdir(), "npm-404-attempts-")), "n");
    withMockNpm(
      `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${counter}"\n` +
        'echo "npm error code E404" >&2; exit 1',
      () => {
        const result = defaultNpmView("@pome-sh/adapter-claude-sdk", "9.9.9", { attempts: 3, delayMs: 0 });
        const tries = Number(readFileSync(counter, "utf8").trim());
        if (result.status === "unpublished" && tries === 1) pass("9g. an E404 short-circuits the retry budget");
        else fail("9g. an E404 short-circuits the retry budget", `${JSON.stringify(result)} after ${tries} try/tries`);
      },
    );
  }
}

{
  const published = (name, version) => (n, v) =>
    n === name && v === version ? { status: "published" } : { status: "unpublished" };

  {
    const root = fixture({ workspaceVersion: "0.3.6", examplePin: "0.3.5" });
    const repins = planExampleRepins(root, published("@pome-sh/adapter-claude-sdk", "0.3.6"));
    const manifestAfter = JSON.parse(readFileSync(join(root, "agent-examples/support-triage/package.json"), "utf8"));
    if (
      repins.length === 1 &&
      repins[0].example === "support-triage" &&
      repins[0].from === "0.3.5" &&
      repins[0].to === "0.3.6" &&
      manifestAfter.dependencies["@pome-sh/adapter-claude-sdk"] === "0.3.5" && // on disk: repins only PLANS writes
      repins[0].writes[0].path === "agent-examples/support-triage/package.json" &&
      JSON.parse(repins[0].writes[0].contents).dependencies["@pome-sh/adapter-claude-sdk"] === "0.3.6" &&
      repins[0].regenerate.length === 1 &&
      repins[0].regenerate[0].includes('cd "agent-examples/support-triage"') && // quoted: this string is bash'ed in CI

      repins[0].regenerate[0].includes("npm install --package-lock-only")
    ) {
      pass("11. a drifted, published pin plans a manifest rewrite and a lockfile regen command");
    } else {
      fail("11. a drifted, published pin plans a manifest rewrite and a lockfile regen command", JSON.stringify({ repins, manifestAfter }));
    }
  }

  {
    const root = fixture({ workspaceVersion: "0.3.7", examplePin: "0.3.6" });
    const repins = planExampleRepins(root, () => ({ status: "unpublished" }));
    if (repins.length === 0) pass("12. an unpublished sibling produces no repin, ever");
    else fail("12. an unpublished sibling produces no repin, ever", JSON.stringify(repins));
  }

  {
    const root = fixture({ workspaceVersion: "0.3.6", examplePin: "0.3.6" });
    const repins = planExampleRepins(root, published("@pome-sh/adapter-claude-sdk", "0.3.6"));
    if (repins.length === 0) pass("13. a pin that already matches the published sibling is a no-op");
    else fail("13. a pin that already matches the published sibling is a no-op", JSON.stringify(repins));
  }

  {
    const root = fixture({ workspaceVersion: "0.3.6", examplePin: "0.3.5" });
    const repins = planExampleRepins(root, () => ({ status: "error", detail: "ECONNRESET" }));
    if (repins.length === 0) pass("14. a registry error produces no repin (never treated as published)");
    else fail("14. a registry error produces no repin (never treated as published)", JSON.stringify(repins));
  }

  for (const { was, published: newVersion } of [
    { was: "0.3.3", published: "0.3.4" },
    { was: "0.3.5", published: "0.3.6" },
  ]) {
    const root = fixture({ workspaceVersion: newVersion, examplePin: was });
    const repins = planExampleRepins(root, published("@pome-sh/adapter-claude-sdk", newVersion));
    const rewritten = JSON.parse(repins[0]?.writes[0]?.contents ?? "{}");
    if (repins.length === 1 && rewritten.dependencies?.["@pome-sh/adapter-claude-sdk"] === newVersion) {
      pass(`15. replays the ${was} -> ${newVersion} incident exactly as the human PR did`);
    } else {
      fail(`15. replays the ${was} -> ${newVersion} incident exactly as the human PR did`, JSON.stringify(repins));
    }
  }

  {
    const root = mkdtempSync(join(tmpdir(), "example-pins-two-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    for (const [dir, name, version] of [
      ["adapter-claude-sdk", "@pome-sh/adapter-claude-sdk", "0.3.6"],
      ["checks", "@pome-sh/checks", "1.2.0"],
    ]) {
      mkdirSync(join(root, "packages", dir), { recursive: true });
      writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify({ name, version }));
    }
    mkdirSync(join(root, "agent-examples", "support-triage"), { recursive: true });
    writeFileSync(
      join(root, "agent-examples", "support-triage", "package.json"),
      JSON.stringify({
        name: "support-triage-example",
        dependencies: { "@pome-sh/adapter-claude-sdk": "0.3.5", "@pome-sh/checks": "1.1.0" },
      }),
    );
    const repins = planExampleRepins(root, () => ({ status: "published" }));
    const lastForPath = repins.filter((r) => r.writes[0].path === "agent-examples/support-triage/package.json").at(-1);
    const onDisk = JSON.parse(lastForPath?.writes[0].contents ?? "{}");
    if (
      repins.length === 2 &&
      onDisk.dependencies["@pome-sh/adapter-claude-sdk"] === "0.3.6" &&
      onDisk.dependencies["@pome-sh/checks"] === "1.2.0"
    ) {
      pass("16b. two drifted pins in one example both survive the last-write-wins apply");
    } else {
      fail("16b. two drifted pins in one example both survive the last-write-wins apply", JSON.stringify({ repins, onDisk }));
    }
  }

  {
    const root = mkdtempSync(join(tmpdir(), "example-pins-ambig-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    mkdirSync(join(root, "packages", "adapter-claude-sdk"), { recursive: true });
    writeFileSync(
      join(root, "packages", "adapter-claude-sdk", "package.json"),
      JSON.stringify({ name: "@pome-sh/adapter-claude-sdk", version: "0.3.6" }),
    );
    mkdirSync(join(root, "agent-examples", "support-triage"), { recursive: true });
    writeFileSync(
      join(root, "agent-examples", "support-triage", "package.json"),
      JSON.stringify({
        name: "support-triage-example",
        dependencies: { "@pome-sh/adapter-claude-sdk": "0.3.5" },
        overrides: { "@pome-sh/adapter-claude-sdk": "0.3.5" },
      }),
    );
    let threw = null;
    let repins = null;
    try {
      repins = planExampleRepins(root, () => ({ status: "published" }));
    } catch (e) {
      threw = e;
    }
    const { violations } = checkExamplePinsPublished(discoverExampleSiblingDeps(root).exact, () => ({
      status: "published",
    }));
    if (threw === null && repins?.length === 0 && violations.length === 1) {
      pass("16c. an ambiguous pin is skipped, not thrown on, and still reds the read-side gate");
    } else {
      fail("16c. an ambiguous pin is skipped, not thrown on, and still reds the read-side gate", String(threw ?? JSON.stringify({ repins, violations })));
    }
  }

  {
    const root = fixture({
      workspaceVersion: "0.3.6",
      examplePin: "0.3.5",
      extraExamples: {
        "ambiguous-example": {
          name: "ambiguous-example",
          dependencies: { "@pome-sh/adapter-claude-sdk": "0.3.4" },
          overrides: { "@pome-sh/adapter-claude-sdk": "0.3.4" },
        },
      },
    });
    const repins = planExampleRepins(root, () => ({ status: "published" }));
    if (repins.length === 1 && repins[0].example === "support-triage" && repins[0].to === "0.3.6") {
      pass("16d. an ambiguous example does not block a clean one in the same run");
    } else {
      fail("16d. an ambiguous example does not block a clean one in the same run", JSON.stringify(repins));
    }
  }

  {
    const root = mkdtempSync(join(tmpdir(), "no-root-manifest-"));
    let threw = null;
    let repins = null;
    try {
      repins = planExampleRepins(root, published("x", "1.0.0"));
    } catch (e) {
      threw = e;
    }
    if (threw === null && Array.isArray(repins) && repins.length === 0) {
      pass("16. a root with no package.json/examples returns no repins rather than throwing");
    } else {
      fail("16. a root with no package.json/examples returns no repins rather than throwing", String(threw));
    }
  }
}

{
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { exact, linked, unwatchable } = discoverExampleSiblingDeps(repoRoot);
  // No example depends on a @pome-sh/* package, so every kind of pin is empty:
  // nothing to watch, and no stray file: link or unwatchable range either.
  if (exact.length === 0 && linked.length === 0 && unwatchable.length === 0) {
    pass("10. the real tree has no @pome-sh/* example deps to watch");
  } else {
    fail("10. the real tree has no @pome-sh/* example deps to watch", JSON.stringify({ exact, linked, unwatchable }));
  }
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nAll cases passed.");
