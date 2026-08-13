#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Regression coverage for scripts/ci/allocate-release-versions.mjs and the
 * CHANGELOG grammar it writes through (scripts/ci/changelog-entry.mjs).
 *
 * Driven over REAL git repositories, because the three properties that matter
 * are all properties of history, not of a string:
 *
 *   - the bump commit cannot re-trigger a publish loop. Asserted by applying a
 *     plan, committing it, and re-planning: the second plan must be empty. That
 *     is the actual sequence `main` sees, and it is what a mocked git could not
 *     tell us anything about.
 *   - two merges landing inside one allocation window get ONE number carrying
 *     both entries, never two numbers or one lost entry.
 *   - insertions only: the released region of every rewritten CHANGELOG is
 *     byte-identical to the one that went in.
 *
 * Plus the refusals, because each one is a shape that must never be mistaken for
 * "nothing to do": an `## Unreleased` with no level, a pending entry below a
 * released one, a version that cannot be bumped, and a shallow clone (whose
 * truncated history would silently mis-scope which packages are owed a release).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUMP_COMMIT_MARKER,
  applyAllocations,
  planAllocations,
} from "./allocate-release-versions.mjs";
import { bumpVersion, parseChangelog, pendingRelease, writeRelease } from "./changelog-entry.mjs";
import { PUBLISHED_PACKAGES } from "./publish-relevance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/ci/allocate-release-versions.mjs");
const DATE = "2026-08-14";
const CLI = PUBLISHED_PACKAGES.find((pkg) => pkg.name === "@pome-sh/cli");
const WIRE = PUBLISHED_PACKAGES.find((pkg) => pkg.name === "@pome-sh/wire");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}\n${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, relPath, contents) {
  mkdirSync(join(dir, dirname(relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), contents);
}

const read = (dir, relPath) => readFileSync(join(dir, relPath), "utf8");

const RELEASED = (name) => `## 1.0.0 — 2026-08-01\n\nThe entry ${name} already shipped.\n`;
const changelogFor = (name) => `# ${name} — CHANGELOG\n\nHow this file works.\n\n${RELEASED(name)}`;

/** A repo carrying every published package at 1.0.0, one commit deep. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "allocate-versions-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "ci@example.com");
  git(dir, "config", "user.name", "ci");
  for (const pkg of PUBLISHED_PACKAGES) {
    write(dir, pkg.manifest, `{\n  "name": "${pkg.name}",\n  "version": "1.0.0"\n}\n`);
    write(dir, pkg.changelog, changelogFor(pkg.name));
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  return dir;
}

function commit(dir, files, message = "a merge") {
  for (const [path, contents] of Object.entries(files)) write(dir, path, contents);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
}

/** Add a pending entry to a package's CHANGELOG, the way a PR author would. */
function pend(dir, pkg, { level = "patch", body = "- something a consumer must know" } = {}) {
  const text = read(dir, pkg.changelog);
  const at = text.indexOf("## ");
  write(dir, pkg.changelog, `${text.slice(0, at)}## Unreleased (${level})\n\n${body}\n\n${text.slice(at)}`);
}

const plan = (dir) => planAllocations({ root: dir, date: DATE });
const named = (result, name) => result.allocations.find((a) => a.name === name);

/** Apply a plan and commit it the way allocate-version.yml does. */
function land(dir, result) {
  applyAllocations(result, { root: dir });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", result.message);
}

console.log("changelog-entry.mjs — the grammar");
{
  check("patch and minor arithmetic", bumpVersion("0.23.45", "patch") === "0.23.46" && bumpVersion("0.23.45", "minor") === "0.24.0");
  let threw = "";
  try {
    bumpVersion("0.4.0-rc.1", "patch");
  } catch (e) {
    threw = e.message;
  }
  check("a prerelease version is refused rather than guessed at", /no single obvious successor/.test(threw), threw);

  threw = "";
  try {
    bumpVersion("1.0.0", "major");
  } catch (e) {
    threw = e.message;
  }
  check("there is no `major` level", /unknown release level/.test(threw), threw);

  threw = "";
  try {
    pendingRelease("# c\n\n## Unreleased\n\n- words\n\n## 1.0.0\n\nshipped\n");
  } catch (e) {
    threw = e.message;
  }
  check(
    "`## Unreleased` with no level throws instead of reading as absent",
    /not a release request/.test(threw),
    threw,
  );

  // The released region is a record, never parsed for requests: the adapter's
  // real CHANGELOG carries a bare `## Unreleased` from the Changesets era between
  // 0.2.3 and 0.2.2, and refusing to release over a heading from July would be
  // this parser policing history it may not correct. A NEW one put down there is
  // caught by the gate's insertions-only check instead, since it changes the
  // released region.
  const withHistoricalHeading = "# c\n\n## 1.0.0\n\nshipped\n\n## Unreleased\n\n## 0.9.0\n\nolder\n";
  check(
    "a pending-ish heading inside the released region is neither a request nor an error",
    pendingRelease(withHistoricalHeading) === null &&
      parseChangelog(withHistoricalHeading).released.includes("## Unreleased"),
  );

  // Two PRs branched off the same base can each add a section. Reddening `main`
  // over that would rebuild a smaller treadmill, so both are honoured: highest
  // level wins, both bodies survive.
  const twoSections =
    "# c\n\n## Unreleased (patch)\n\n- from PR one\n\n## Unreleased (minor)\n\n- from PR two\n\n## 1.0.0\n\nshipped\n";
  const merged = pendingRelease(twoSections);
  check(
    "two pending sections merge: highest level, both bodies, in file order",
    merged.level === "minor" &&
      merged.sections === 2 &&
      merged.body === "- from PR one\n\n- from PR two",
    JSON.stringify(merged),
  );

  const before = "# c\n\nnotes\n\n## Unreleased (patch)\n\n- words\n\n## 1.0.0\n\nshipped\n";
  const after = writeRelease(before, { version: "1.0.1", date: DATE, body: "- words" });
  check(
    "writeRelease inserts above the released region and leaves it byte-identical",
    after.endsWith(parseChangelog(before).released) &&
      after.includes(`## 1.0.1 — ${DATE}`) &&
      !after.includes("## Unreleased"),
    after,
  );
  check("…and keeps the preamble", after.startsWith("# c\n\nnotes\n\n"), after);
}

console.log("nothing owed");
{
  const dir = repo();
  try {
    const result = plan(dir);
    check("a freshly seeded tree owes nothing", result.allocations.length === 0, JSON.stringify(result.allocations));
    commit(dir, { "README.md": "# docs only\n" }, "docs");
    check("a docs-only merge owes nothing", plan(dir).allocations.length === 0);
    // The second, independent loop guard: a CHANGELOG is not a publish-relevant
    // path, so editing one earns no release on its own.
    commit(dir, { [CLI.changelog]: changelogFor("@pome-sh/cli").replace("How this file works.", "Reworded.") }, "preamble");
    check("editing a CHANGELOG preamble owes nothing", plan(dir).allocations.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("a pending entry earns a number");
{
  const dir = repo();
  try {
    pend(dir, CLI, { body: "- the CLI learned a thing" });
    commit(dir, {}, "a merge with an entry (#101)");
    const result = plan(dir);
    const cli = named(result, "@pome-sh/cli");
    check("exactly one package is allocated", result.allocations.length === 1 && cli, JSON.stringify(result.allocations.map((a) => a.name)));
    check("patch by default from the heading's level", cli.from === "1.0.0" && cli.to === "1.0.1" && cli.level === "patch", JSON.stringify(cli));
    check("reason names the entry, not relevance", cli.reason === "entry", cli.reason);

    const written = cli.writes.find((w) => w.path === CLI.changelog).contents;
    check("the heading carries the allocated number and the date", written.includes(`## 1.0.1 — ${DATE}`), written);
    check("the author's words are the entry", written.includes("- the CLI learned a thing"), written);
    check("the pending section is consumed", !written.includes("## Unreleased"), written);
    check(
      "the released region is byte-identical (insertions only)",
      written.endsWith(RELEASED("@pome-sh/cli")),
      written,
    );
    const manifest = cli.writes.find((w) => w.path === CLI.manifest).contents;
    check("the manifest diff is the version line only", manifest === `{\n  "name": "@pome-sh/cli",\n  "version": "1.0.1"\n}\n`, manifest);
    check("the commit subject carries the loop marker", result.message.startsWith(`release: @pome-sh/cli 1.0.1 ${BUMP_COMMIT_MARKER}`), result.message);
    check("the commit body records from → to and why", result.message.includes("- @pome-sh/cli 1.0.0 → 1.0.1 (patch, entry)"), result.message);

    // The whole design rests on this commit's push firing release.yml, and every
    // one of these tokens suppresses ALL workflows for the commit that carries it
    // — a publish that never happens, with a green run and no alarm leg able to
    // tell it from "nothing was owed". `[release-bump]` looks enough like the
    // family to be edited into one of them by someone tidying up, so the message
    // is asserted rather than trusted.
    const CI_SUPPRESSING = ["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]", "***NO_CI***"];
    check(
      "the commit message contains NO CI-suppressing token",
      CI_SUPPRESSING.every((token) => !result.message.toLowerCase().includes(token.toLowerCase())),
      `${CI_SUPPRESSING.filter((t) => result.message.toLowerCase().includes(t.toLowerCase())).join(", ")}\n${result.message}`,
    );
    check("planning twice is the same answer (the retry loop re-plans)", JSON.stringify(plan(dir).allocations) === JSON.stringify(result.allocations));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("a minor entry earns a minor");
{
  const dir = repo();
  try {
    pend(dir, CLI, { level: "minor", body: "- a consumer must act" });
    commit(dir, {}, "a breaking change (#102)");
    check("0.N+1.0, never inferred", named(plan(dir), "@pome-sh/cli").to === "1.1.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("publish relevance earns a number with no entry at all");
{
  const dir = repo();
  try {
    commit(dir, { "cli/src/thing.ts": "export const a = 1;\n" }, "a fix nobody wrote up (#103)");
    const cli = named(plan(dir), "@pome-sh/cli");
    check("the release happens anyway — a silent non-release is the defect", cli?.to === "1.0.1", JSON.stringify(cli));
    check("reason names relevance", cli.reason === "relevance", cli.reason);
    const written = cli.writes.find((w) => w.path === CLI.changelog).contents;
    check("the entry says plainly that no words were supplied", /no `## Unreleased`/.test(written), written);
    check("…and names the commits that are in it", written.includes("a fix nobody wrote up (#103)"), written);
    check("…and stays an insertion", written.endsWith(RELEASED("@pome-sh/cli")), written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("the wire coupling, at bump time");
{
  const dir = repo();
  try {
    pend(dir, WIRE, { body: "- wire gained a subpath" });
    commit(dir, { "packages/wire/src/thing.ts": "export const a = 1;\n" }, "wire moves (#104)");
    const result = plan(dir);
    const names = result.allocations.map((a) => a.name).sort();
    check(
      "one wire change allocates three artifacts",
      JSON.stringify(names) === JSON.stringify(["@pome-sh/adapter-claude-sdk", "@pome-sh/cli", "@pome-sh/wire"]),
      names.join(", "),
    );
    check("wire's own entry is the author's words", named(result, "@pome-sh/wire").reason === "entry+relevance");
    check("the two inliners get version-only entries", named(result, "@pome-sh/cli").reason === "relevance");
    check(
      "the subject collapses when several packages move",
      result.message.startsWith(`release: 3 packages ${BUMP_COMMIT_MARKER}`),
      result.message,
    );
    check(
      "wire's shipped trace-contract.json is named for regeneration",
      named(result, "@pome-sh/wire").regenerate.includes("npm run emit:trace-contract -w @pome-sh/wire") &&
        named(result, "@pome-sh/cli").regenerate.length === 0,
      JSON.stringify(named(result, "@pome-sh/wire").regenerate),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("the bump commit cannot re-trigger a publish loop");
{
  const dir = repo();
  try {
    pend(dir, CLI);
    commit(dir, { "cli/src/thing.ts": "export const a = 1;\n" }, "a merge (#105)");
    const first = plan(dir);
    check("the merge is owed a release", first.allocations.length === 1);

    land(dir, first);
    const second = plan(dir);
    check(
      "the bump commit itself owes nothing — the loop terminates",
      second.allocations.length === 0,
      JSON.stringify(second.allocations.map((a) => `${a.name} ${a.to}`)),
    );
    check(
      "…because relevance is measured from the commit that moved the version",
      read(dir, CLI.manifest).includes('"version": "1.0.1"') &&
        read(dir, CLI.changelog).includes("## 1.0.1"),
    );

    // And it stays terminated across the next unrelated push, which is when a
    // marker-only guard would have let the bump commit's own diff back in.
    commit(dir, { "README.md": "# docs\n" }, "docs after a release");
    check("a later docs merge does not re-open it", plan(dir).allocations.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("two merges inside one window cannot double-allocate");
{
  const dir = repo();
  try {
    // Both PRs merge before the allocator gets to run — the exact race the old
    // hand-written version line turned into a renumber-and-force-push cycle.
    pend(dir, CLI, { body: "- from PR one" });
    commit(dir, { "cli/src/one.ts": "export const a = 1;\n" }, "PR one (#106)");
    pend(dir, CLI, { level: "minor", body: "- from PR two" });
    commit(dir, { "cli/src/two.ts": "export const b = 2;\n" }, "PR two (#107)");

    const result = plan(dir);
    const cli = named(result, "@pome-sh/cli");
    check("ONE number is cut, not two", result.allocations.length === 1 && cli.to === "1.1.0", JSON.stringify(result.allocations));
    const written = cli.writes.find((w) => w.path === CLI.changelog).contents;
    check("both authors' words are in it", written.includes("- from PR one") && written.includes("- from PR two"), written);
    check("the higher level wins", cli.level === "minor", cli.level);

    land(dir, result);
    check("and nothing is owed afterwards", plan(dir).allocations.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("the number and its heading are written together");
{
  const dir = repo();
  try {
    pend(dir, CLI);
    commit(dir, {}, "a merge (#108)");
    land(dir, plan(dir));
    const version = JSON.parse(read(dir, CLI.manifest)).version;
    const { releasedHeading } = parseChangelog(read(dir, CLI.changelog));
    check(
      "the newest released heading names the version the manifest declares",
      releasedHeading === `## ${version} — ${DATE}`,
      `${version} vs ${releasedHeading}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("a shallow clone is refused, not silently mis-scoped");
{
  const source = repo();
  const target = mkdtempSync(join(tmpdir(), "allocate-shallow-"));
  try {
    pend(source, CLI);
    commit(source, { "cli/src/thing.ts": "export const a = 1;\n" }, "a merge (#109)");
    const clone = spawnSync("git", ["clone", "-q", "--depth", "1", `file://${source}`, "shallow"], {
      cwd: target,
      encoding: "utf8",
    });
    let threw = "";
    if (clone.status === 0) {
      try {
        plan(join(target, "shallow"));
      } catch (e) {
        threw = e.message;
      }
      check("throws, naming fetch-depth", /shallow clone/.test(threw) && /fetch-depth: 0/.test(threw), threw);
    } else {
      check("git refused to make a shallow clone here — case skipped", true, clone.stderr);
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

console.log("the script's own surface");
{
  const dir = repo();
  // Outside the repo: allocate-version.yml writes these under $RUNNER_TEMP for
  // the same reason, and a leftover file inside the tree would show up in the
  // `git commit -a` the workflow runs next.
  const out = mkdtempSync(join(tmpdir(), "allocate-out-"));
  try {
    pend(dir, WIRE, { body: "- wire moved" });
    commit(dir, { "packages/wire/src/thing.ts": "export const a = 1;\n" }, "wire (#110)");

    const planOut = join(out, "plan.json");
    const messageOut = join(out, "message.txt");
    const regenOut = join(out, "regen.sh");
    const r = spawnSync(
      "node",
      [SCRIPT, "--write", "--plan-out", planOut, "--message-out", messageOut, "--regen-out", regenOut, dir],
      { cwd: dir, encoding: "utf8", env: { ...process.env, POME_ALLOCATION_DATE: DATE } },
    );
    check("exits 0", r.status === 0, `${r.stdout}${r.stderr}`);
    check("names each allocation on stdout", /@pome-sh\/wire: 1\.0\.0 → 1\.0\.1/.test(r.stdout), r.stdout);
    check("--write actually writes", read(dir, WIRE.manifest).includes('"version": "1.0.1"'));
    check("--plan-out is machine-readable", JSON.parse(readFileSync(planOut, "utf8")).allocations.length === 3);
    check("--message-out carries the marker", readFileSync(messageOut, "utf8").includes(BUMP_COMMIT_MARKER));
    check(
      "--regen-out is a runnable script naming wire's emitter",
      /^set -euo pipefail\nnpm run emit:trace-contract -w @pome-sh\/wire\n$/.test(readFileSync(regenOut, "utf8")),
      readFileSync(regenOut, "utf8"),
    );

    // The no-op run is the one that happens most often (every push that owes
    // nothing), so its exit code and its files matter as much as the other.
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `release: 3 packages ${BUMP_COMMIT_MARKER}`);
    const again = spawnSync("node", [SCRIPT, "--write", "--regen-out", regenOut, dir], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, POME_ALLOCATION_DATE: DATE },
    });
    check("a no-op run exits 0 and says so", again.status === 0 && /Nothing to allocate/.test(again.stdout), `${again.stdout}${again.stderr}`);
    check("…and empties the regeneration script", readFileSync(regenOut, "utf8") === "", readFileSync(regenOut, "utf8"));
    check("…and leaves the tree clean", git(dir, "status", "--porcelain") === "", git(dir, "status", "--porcelain"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
