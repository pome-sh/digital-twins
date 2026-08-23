#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression suite for `check-example-pins-published.mjs`. Pure
// functions, no network and no `npm ci` needed: `checkExamplePinsPublished`
// takes an injected `npmView`, and `discoverExampleSiblingDeps` runs against
// a throwaway fixture tree built the same way
// `check-workspace-pins-match-workspace.test.mjs` builds one, since both
// gates read the same root `workspaces` shape.

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

/** A throwaway root with one workspace package and one example, mirroring the
 * real tree's `packages/adapter-claude-sdk` + `agent-examples/support-triage`
 * shape. */
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

// 1. Discovery: an exact pin with a matching sibling is picked up, with the
// field it lives in and the workspace version to compare against.
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

// 2. A `file:`/`link:` workspace link resolves from the source next to it and
// cannot reach a registry, so it is not this gate's subject — but it is COUNTED,
// not dropped, so the report cannot claim a denominator it does not have.
for (const pin of ["file:../../packages/adapter-claude-sdk", "link:../../packages/adapter-claude-sdk"]) {
  const root = fixture({ workspaceVersion: "0.3.3", examplePin: pin });
  const { exact, linked, unwatchable } = discoverExampleSiblingDeps(root);
  if (exact.length === 0 && linked.length === 1 && unwatchable.length === 0) {
    pass(`2. pin "${pin}" is counted as a workspace link, not an exact pin`);
  } else {
    fail(`2. pin "${pin}" is counted as a workspace link, not an exact pin`, JSON.stringify({ exact, linked, unwatchable }));
  }
}

// 3. THE HOLE THE FIRST DRAFT HAD: a range/`*`/dist-tag pin resolves FROM the
// registry — the exact risk this gate watches — but has no single version to
// compare. It must be reported as UNWATCHABLE, never silently dropped, or
// re-pinning the hero example to `^0.3.3` deletes its watch while the report
// still reads as a pass.
for (const pin of ["*", "^0.3.3", "~0.3.1", "0.3.x", ">=0.3.0", "latest", "npm:@pome-sh/adapter-claude-sdk@0.3.3"]) {
  const root = fixture({ workspaceVersion: "0.3.3", examplePin: pin });
  const { exact, linked, unwatchable } = discoverExampleSiblingDeps(root);
  if (exact.length === 0 && linked.length === 0 && unwatchable.length === 1) {
    pass(`3. pin "${pin}" is reported as unwatchable, not skipped`);
  } else {
    fail(`3. pin "${pin}" is reported as unwatchable, not skipped`, JSON.stringify({ exact, linked, unwatchable }));
  }
}

// 3b. …and an unwatchable pin makes `reportExamplePinParity` return false even
// when every OTHER pin in the tree is a clean exact match. This is the case the
// zero-pins floor below CANNOT catch: with a second exact pin present the floor
// is satisfied by arithmetic and the range pin's silence is invisible.
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

// 4. Zero EXACT pins under `agent-examples/*` must throw rather than report a pass
// having made no registry call. Asserted on the MESSAGE, not merely "something
// threw": with an empty `packages/` the fixture used to throw
// `no workspace manifests found` out of `loadWorkspaceMembers` before the floor
// was ever reached, so a bare `catch {}` passed this case while the floor itself
// had no coverage at all.
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

// 4b. A `@pome-sh/*` dep naming no workspace sibling is out of scope in all
// three classes — nothing in the tree to compare it against.
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

  // 9d. A failure with EMPTY stderr — the shape a killed call (the `timeout`
  // in `defaultNpmView`) and some network aborts take. No `E404` to match on,
  // so it must land in `error`, never fall through to "unpublished".
  withMockNpm("exit 1", () => {
    const result = defaultNpmView("@pome-sh/adapter-claude-sdk", "0.3.3", { attempts: 1 });
    if (result.status === "error" && result.detail) {
      pass("9d. defaultNpmView classifies an empty-stderr failure as an error, not unpublished");
    } else {
      fail("9d. defaultNpmView classifies an empty-stderr failure as an error, not unpublished", JSON.stringify(result));
    }
  });

  // 9e. A TRANSIENT 5xx is retried rather than reddening the required check on
  // the first blip: this mock 503s twice, then succeeds.
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

  // 9f. …but a PERSISTENT error still ends as an error once the attempts are
  // spent. Retrying must not become a way to eventually pass.
  withMockNpm('echo "npm error code E503" >&2; exit 1', () => {
    const result = defaultNpmView("@pome-sh/adapter-claude-sdk", "0.3.3", { attempts: 3, delayMs: 0 });
    if (result.status === "error" && result.attempts === 3) {
      pass("9f. a persistent error is still an error after all attempts");
    } else {
      fail("9f. a persistent error is still an error after all attempts", JSON.stringify(result));
    }
  });

  // 9g. An E404 returns on the FIRST attempt — the ordinary unpublished path
  // must not pay the retry budget.
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

// PlanExampleRepins is the write-side of this same gate: a pin that
// this file's own `violations` classifier already calls drifted-against-a-
// published-sibling is exactly the set safe to rewrite automatically.
{
  const published = (name, version) => (n, v) =>
    n === name && v === version ? { status: "published" } : { status: "unpublished" };

  // 11. A genuinely drifted, published pin produces a repin: the manifest
  // text is rewritten (old pin -> new pin, nothing else touched) and a
  // lockfile-regeneration command names the right example directory.
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

  // 12. The exact incident shape: the sibling is NOT yet published (this run's
  // own bump, or a `release.yml` publish still in flight) — must not repin.
  // Repinning here would set a pin to a version `npm install
  // --package-lock-only` cannot resolve, breaking `npm ci` outright.
  {
    const root = fixture({ workspaceVersion: "0.3.7", examplePin: "0.3.6" });
    const repins = planExampleRepins(root, () => ({ status: "unpublished" }));
    if (repins.length === 0) pass("12. an unpublished sibling produces no repin, ever");
    else fail("12. an unpublished sibling produces no repin, ever", JSON.stringify(repins));
  }

  // 13. Already matching: no-op, no write planned — idempotence.
  {
    const root = fixture({ workspaceVersion: "0.3.6", examplePin: "0.3.6" });
    const repins = planExampleRepins(root, published("@pome-sh/adapter-claude-sdk", "0.3.6"));
    if (repins.length === 0) pass("13. a pin that already matches the published sibling is a no-op");
    else fail("13. a pin that already matches the published sibling is a no-op", JSON.stringify(repins));
  }

  // 14. A registry error (not E404) must not be read as "go ahead and repin".
  {
    const root = fixture({ workspaceVersion: "0.3.6", examplePin: "0.3.5" });
    const repins = planExampleRepins(root, () => ({ status: "error", detail: "ECONNRESET" }));
    if (repins.length === 0) pass("14. a registry error produces no repin (never treated as published)");
    else fail("14. a registry error produces no repin (never treated as published)", JSON.stringify(repins));
  }

  // 15. Replays the real incidents (#395: adapter 0.3.4, #425: adapter 0.3.6)
  // — the exact state right after each release, before the human PR.
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

  // 16b. TWO drifted pins in ONE example. `applyAllocations` writes a plan's
  // entries in order and last write wins per path, so the LAST entry for a
  // manifest must already carry every earlier substitution — otherwise the
  // first repin is silently dropped while the commit message still claims it,
  // and the read-side gate keeps reddening on a drift the commit says it fixed.
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
    // Whichever entry lands last for that path is what ends up on disk.
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

  // 16c. An ambiguous manifest — the same `"<dep>": "<pin>"` bytes repeated in
  // an `overrides` block, which npm accepts and this gate does not read as a
  // second install field. `planExampleRepins` runs inside `planAllocations` on
  // EVERY push to main, so throwing here would stop every package's release
  // over one example manifest. It must skip that pin and keep going, leaving
  // the read-side gate to red on it.
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
    // The gate itself must still call it drift — skipping the WRITE must never
    // skip the READ.
    const { violations } = checkExamplePinsPublished(discoverExampleSiblingDeps(root).exact, () => ({
      status: "published",
    }));
    if (threw === null && repins?.length === 0 && violations.length === 1) {
      pass("16c. an ambiguous pin is skipped, not thrown on, and still reds the read-side gate");
    } else {
      fail("16c. an ambiguous pin is skipped, not thrown on, and still reds the read-side gate", String(threw ?? JSON.stringify({ repins, violations })));
    }
  }

  // 16d. …and one ambiguous pin must not cost a DIFFERENT example its repin.
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

  // 16. No `package.json` at the repo root (a throwaway fixture, like
  // allocate-release-versions.test.mjs's) — must return empty, not throw.
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

// 10. Aimed at the REAL tree, not only fixtures: `agent-examples/*` must still carry
// at least one exact `@pome-sh/*` pin with a workspace sibling, and nothing
// unwatchable. No fixture can prove the gate points at the live corpus.
{
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { exact, unwatchable } = discoverExampleSiblingDeps(repoRoot);
  if (exact.length >= 1 && unwatchable.length === 0) {
    pass(`10. the real tree has ${exact.length} watched exact pin(s) and 0 unwatchable`);
  } else {
    fail("10. the real tree has watched exact pin(s) and 0 unwatchable", JSON.stringify({ exact, unwatchable }));
  }
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("\nAll cases passed.");
