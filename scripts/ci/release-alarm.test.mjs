#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Regression coverage for scripts/ci/release-alarm.mjs.
 *
 * Both directions are asserted, and the silent one matters more. An alarm that
 * fires on a healthy release gets muted, and a muted alarm is exactly the state
 * this ticket exists to end — so every "fires" case below has a matching "stays
 * silent" case: a bump inside the grace window, a failure already being retried,
 * a first-ever publish, a run in flight.
 *
 * The fixture's `.github/workflows/release.yml` is the REAL one, copied from
 * this repo. That makes `parseTargets` a live assertion rather than a test
 * against a hand-written sample: if a release restructure moves the
 * decide-publish.sh calls past the parser, this suite reds instead of the alarm
 * silently watching zero packages.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISHED_PACKAGES } from "./publish-relevance.mjs";
import { check, compareVersions, parseTargets, readTargets } from "./release-alarm.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/ci/release-alarm.mjs");
const REPO = "pome-sh/digital-twins";
// Compared with `===`, never with `.includes`: a host substring match is a
// weaker claim than the one being made here (the registry IS this one, not
// merely contains its name), and CodeQL's js/incomplete-url-substring-
// sanitization is right to flag the weaker form.
const GH_PACKAGES = "https://npm.pkg.github.com";
const NOW = Date.parse("2026-08-06T12:00:00Z");
const HEAD_SHA = "9119a07f0000000000000000000000000000abcd";

let failures = 0;
function check_(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
}

const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

/**
 * A CHANGELOG with nothing pending, for every published package — the state
 * every allocation leaves behind. `pending` names packages that get an
 * `## Unreleased` section instead, which is the state a dead allocator leaves.
 */
function writeChangelogs(dir, pending = {}) {
  for (const pkg of PUBLISHED_PACKAGES) {
    mkdirSync(join(dir, dirname(pkg.changelog)), { recursive: true });
    const section = pending[pkg.name] ? `${pending[pkg.name]}\n\n- words from a PR\n\n` : "";
    writeFileSync(
      join(dir, pkg.changelog),
      `# ${pkg.name} — CHANGELOG\n\n${section}## 1.0.0 — 2026-08-01\n\nShipped.\n`,
    );
  }
}

/** A repo root carrying the real release.yml and manifests at the paths it names. */
function fixture(versions = {}, pending = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-alarm-"));
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  cpSync(
    join(ROOT, ".github/workflows/release.yml"),
    join(dir, ".github/workflows/release.yml"),
  );
  for (const t of parseTargets(ROOT)) {
    mkdirSync(join(dir, dirname(t.manifest)), { recursive: true });
    writeFileSync(
      join(dir, t.manifest),
      JSON.stringify({ name: t.name, version: versions[t.name] ?? "1.0.0" }),
    );
  }
  writeChangelogs(dir, pending);
  return dir;
}

/** A `gh api` stand-in: answers the commit and the run-list calls, nothing else. */
function ghStub({ head = { sha: HEAD_SHA, ageMin: 600 }, runs = [] }) {
  return (args) => {
    const joined = args.join(" ");
    if (joined.includes("/commits/main")) {
      return JSON.stringify({
        sha: head.sha,
        commit: { committer: { date: minutesAgo(head.ageMin) } },
      });
    }
    if (joined.includes("release.yml/runs")) {
      return JSON.stringify({
        workflow_runs: runs.map((r, i) => ({
          id: 31000000000 + i,
          head_sha: r.sha ?? head.sha,
          status: r.status ?? "completed",
          conclusion: r.status === "completed" || !r.status ? (r.conclusion ?? "success") : null,
          created_at: minutesAgo(r.ageMin ?? 300),
        })),
      });
    }
    throw new Error(`unexpected gh call: ${joined}`);
  };
}

const registryStub = (map) => (name, registry) =>
  map[`${name}@${registry || "npm"}`] ?? map[name] ?? { version: "1.0.0" };

function run(opts = {}) {
  const { versions, head, runs, registry = {}, pending, ...rest } = opts;
  return check({
    root: opts.root ?? fixture(versions, pending),
    repo: REPO,
    now: NOW,
    gitHub: ghStub({ head, runs }),
    readVersion: registryStub(registry),
    ...rest,
  });
}

const kinds = (r) => r.alarms.map((a) => a.split(" ")[0]);

// ── the publish targets are derived from release.yml, not typed here ─────────
console.log("parseTargets");
{
  const targets = parseTargets(ROOT);
  check_(
    `finds every decide-publish.sh call in the real release.yml (${targets.length})`,
    targets.length >= 5,
    `got ${JSON.stringify(targets.map((t) => `${t.name}@${t.registry || "npm"}`))}`,
  );
  check_(
    "covers the grading pin @pome-sh/checks",
    targets.some((t) => t.name === "@pome-sh/checks"),
  );
  check_(
    "keeps wire's two registries as two targets",
    targets.filter((t) => t.name === "@pome-sh/wire").length === 2 &&
      targets.some((t) => t.registry === GH_PACKAGES),
  );
  check_(
    "every derived manifest exists",
    targets.every((t) => JSON.parse(readFileSync(join(ROOT, t.manifest), "utf8")).version),
  );

  // The dead-guard case: a release.yml the parser cannot follow must be a hard
  // failure. An alarm that finds zero packages passes forever.
  const empty = mkdtempSync(join(tmpdir(), "release-alarm-empty-"));
  mkdirSync(join(empty, ".github/workflows"), { recursive: true });
  writeFileSync(join(empty, ".github/workflows/release.yml"), "name: release\njobs: {}\n");
  let threw = "";
  try {
    parseTargets(empty);
  } catch (e) {
    threw = e.message;
  }
  check_("throws when release.yml yields no targets", /no decide-publish\.sh calls/.test(threw), threw);
}

console.log("compareVersions");
{
  check_("0.21.8 > 0.21.7", compareVersions("0.21.8", "0.21.7") > 0);
  check_("0.21.7 == 0.21.7", compareVersions("0.21.7", "0.21.7") === 0);
  check_("0.9.0 < 0.10.0 (not string order)", compareVersions("0.9.0", "0.10.0") < 0);
  check_("1.0.0-rc1 < 1.0.0", compareVersions("1.0.0-rc1", "1.0.0") < 0);
  check_("0.0.0 baseline is below everything", compareVersions("0.1.0", "0.0.0") > 0);
}

// ── silence ─────────────────────────────────────────────────────────────────
console.log("stays silent when everything is green");
{
  const r = run({ runs: [{ ageMin: 300, conclusion: "success" }] });
  check_("no alarms", r.alarms.length === 0, r.alarms.join("\n"));
  check_("report still names each package", r.report.includes("@pome-sh/checks"));
}

console.log("stays silent inside the grace window");
{
  // A bump that merged four minutes ago is legitimately not on npm yet.
  const r = run({
    head: { sha: HEAD_SHA, ageMin: 4 },
    runs: [{ ageMin: 4, status: "in_progress" }],
    versions: { "@pome-sh/checks": "2.0.0" },
    registry: { "@pome-sh/checks": { version: "1.0.0" } },
  });
  check_("no alarms", r.alarms.length === 0, r.alarms.join("\n"));
  check_("says why it did not evaluate", /not evaluated/.test(r.report));
}

console.log("stays silent when a failure is already being retried");
{
  const r = run({
    runs: [
      { ageMin: 10, status: "in_progress" },
      { ageMin: 200, conclusion: "failure" },
    ],
  });
  check_("no FAILED", !kinds(r).includes("FAILED"), r.alarms.join("\n"));
}

console.log("stays silent after a workflow_dispatch recovers a failed push (the 08-06 recovery)");
{
  const r = run({
    runs: [
      { ageMin: 100, conclusion: "success" }, // 13:10 dispatch
      { ageMin: 200, conclusion: "failure" }, // 11:28 push
    ],
  });
  check_("no alarms", r.alarms.length === 0, r.alarms.join("\n"));
}

// ── noise, and only where it is owed ────────────────────────────────────────
console.log("UNPUBLISHED — main declares a version npm does not serve");
{
  const r = run({
    versions: { "@pome-sh/checks": "0.2.0", "@pome-sh/wire": "0.4.0" },
    registry: {
      "@pome-sh/checks": { version: "0.1.0" },
      "@pome-sh/wire@npm": { version: "0.3.0" },
      [`@pome-sh/wire@${GH_PACKAGES}`]: { version: "0.4.0" },
    },
    runs: [{ ageMin: 200, conclusion: "failure" }],
  });
  check_("fires", kinds(r).filter((k) => k === "UNPUBLISHED").length === 2, r.alarms.join("\n"));
  check_("names the package", r.alarms.some((a) => a.includes("@pome-sh/checks 0.2.0")));
  // wire is behind on npmjs and current on GitHub Packages. Two targets, ONE
  // alarm — counted rather than host-matched, which is the sharper claim: a
  // checker that judged wire once would give either two alarms or none.
  check_(
    "the two wire registries are judged separately",
    r.alarms.filter((a) => a.startsWith("UNPUBLISHED") && a.includes("@pome-sh/wire")).length === 1,
    r.alarms.join("\n"),
  );
  check_("also reports the failed run, with its URL", r.alarms.some((a) => a.startsWith("FAILED") && a.includes("/actions/runs/")));
}

console.log("UNPUBLISHED — a first-ever publish that never happened");
{
  const r = run({
    versions: { "@pome-sh/checks": "0.1.0" },
    registry: { "@pome-sh/checks": { version: "0.0.0", unpublished: true } },
  });
  check_("fires", r.alarms.some((a) => a.startsWith("UNPUBLISHED") && a.includes("@pome-sh/checks")));
  check_("says nothing is published rather than printing 0.0.0", r.alarms.some((a) => a.includes("serves nothing")));
}

console.log("BEHIND — main is below the registry, so the next merge fails its lane");
{
  const r = run({
    versions: { "@pome-sh/cli": "0.21.0" },
    registry: { "@pome-sh/cli": { version: "0.21.7" } },
  });
  check_("fires", kinds(r).includes("BEHIND"), r.alarms.join("\n"));
  check_("no UNPUBLISHED for the same package", !kinds(r).includes("UNPUBLISHED"));
}

console.log("NEVER_RAN — a push to main that triggered nothing (the release silence)");
{
  const r = run({
    head: { sha: HEAD_SHA, ageMin: 600 },
    runs: [{ sha: "deadbeef".repeat(5), ageMin: 900, conclusion: "success" }],
  });
  check_("fires", kinds(r).includes("NEVER_RAN"), r.alarms.join("\n"));
  check_("names the commit", r.alarms.some((a) => a.includes(HEAD_SHA.slice(0, 8))));
  check_("no run at all is also NEVER_RAN", kinds(run({ runs: [] })).includes("NEVER_RAN"));
}

console.log("STUCK — a run holding the concurrency lock");
{
  const r = run({ runs: [{ ageMin: 700, status: "queued" }] });
  check_("fires", kinds(r).includes("STUCK"), r.alarms.join("\n"));
  check_(
    "an in-flight run inside the window does not",
    !kinds(run({ runs: [{ ageMin: 30, status: "in_progress" }] })).includes("STUCK"),
  );
}

console.log("FAILED — a broken release path with nothing owed");
{
  // Every version matches its registry: the outcome check cannot see this, and
  // it is the reason the mechanism leg exists.
  const r = run({ runs: [{ ageMin: 200, conclusion: "failure" }] });
  check_("fires", kinds(r).includes("FAILED"), r.alarms.join("\n"));
  check_("nothing else does", r.alarms.length === 1, r.alarms.join("\n"));
  check_("a cancelled run counts", kinds(run({ runs: [{ ageMin: 200, conclusion: "cancelled" }] })).includes("FAILED"));
  check_("a skipped run does not", !kinds(run({ runs: [{ ageMin: 200, conclusion: "skipped" }] })).includes("FAILED"));
}

console.log("UNALLOCATED — a number nobody wrote");
{
  // The state a broken or unconfigured allocate-version.yml leaves: main carries
  // the words and not the number, main and the registry agree on the OLD version,
  // and every other leg is green. The outcome check cannot see this at all, which
  // is the whole reason this leg exists.
  const r = run({
    runs: [{ ageMin: 300, conclusion: "success" }],
    pending: { "@pome-sh/cli": "## Unreleased (patch)" },
  });
  check_("fires", kinds(r).includes("UNALLOCATED"), r.alarms.join("\n"));
  check_(
    "names the file and the level",
    r.alarms.some((a) => a.includes("cli/CHANGELOG.md") && a.includes("(patch)")),
    r.alarms.join("\n"),
  );
  check_(
    "and nothing else fires — every version matches its registry",
    r.alarms.length === 1,
    r.alarms.join("\n"),
  );
  check_("the report names the waiting package", /@pome-sh\/cli — pending patch/.test(r.report), r.report);

  // A `## Unreleased` heading with no level is refused by the same parser
  // allocate-version.yml runs, so the allocator is failing on it too — reported,
  // never silently read as "nothing pending".
  const malformed = run({
    runs: [{ ageMin: 300, conclusion: "success" }],
    pending: { "@pome-sh/wire": "## Unreleased" },
  });
  check_(
    "a malformed pending heading is UNALLOCATED, not silence",
    kinds(malformed).includes("UNALLOCATED") &&
      malformed.alarms.some((a) => a.includes("not a release request")),
    malformed.alarms.join("\n"),
  );

  // Inside the grace window an entry is legitimately still being allocated.
  const fresh = run({
    head: { sha: HEAD_SHA, ageMin: 4 },
    runs: [{ ageMin: 4, status: "in_progress" }],
    pending: { "@pome-sh/cli": "## Unreleased (minor)" },
  });
  check_("stays silent inside the grace window", fresh.alarms.length === 0, fresh.alarms.join("\n"));
}

console.log("UNMEASURED — an unreadable registry is never read as 'unpublished'");
{
  // wire is in sync on npmjs and unreadable on GitHub Packages: the ONLY
  // correct output is one UNMEASURED and nothing else. A checker that folded a
  // 401 into "unpublished" would add an UNPUBLISHED here, and one that gave up
  // on the whole package would lose the npmjs judgement — both are counted for.
  const r = run({
    versions: { "@pome-sh/wire": "0.4.0" },
    registry: {
      "@pome-sh/wire@npm": { version: "0.4.0" },
      [`@pome-sh/wire@${GH_PACKAGES}`]: { error: "npm error code E401" },
    },
  });
  check_("fires", kinds(r).filter((k) => k === "UNMEASURED").length === 1, r.alarms.join("\n"));
  check_(
    "a 401 is never folded into UNPUBLISHED or BEHIND",
    !kinds(r).includes("UNPUBLISHED") && !kinds(r).includes("BEHIND"),
    r.alarms.join("\n"),
  );
  check_(
    "the readable npmjs copy is still judged, and separately",
    r.report.split("\n").filter((l) => l.startsWith("@pome-sh/wire @")).length === 2 &&
      r.report.includes("declared 0.4.0, registry 0.4.0 ✓"),
    r.report,
  );
}

// ── the incident this exists for, replayed from the real record ─────────────
//
// Every number below is measured, not invented: run ids and conclusions from
// the GitHub Actions API, manifest versions from `git show <sha>:<manifest>`,
// registry state from `npm view <pkg> time`. The claim under test is the
// ticket's own bar — "merge something that makes a publish job fail, expect a
// signal naming the run and the package" — checked against the eleven hours
// where nothing fired.
console.log("2026-08-06, replayed");
{
  /** A fixture whose release.yml is a historical one, not today's. */
  function historical(releaseYaml, versions) {
    const dir = mkdtempSync(join(tmpdir(), "release-alarm-hist-"));
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/release.yml"), releaseYaml);
    for (const [manifest, version] of Object.entries(versions)) {
      mkdirSync(join(dir, dirname(manifest)), { recursive: true });
      writeFileSync(join(dir, manifest), JSON.stringify({ version }));
    }
    // Backfill any target the YAML names that the caller did not — `parseTargets`
    // hard-fails on a manifest that does not exist, so a hand-written map has to
    // be re-edited every time release.yml gains a package. It was, once: a new
    // fifth target broke the replay below, which passes the REAL release.yml
    // against a four-entry map. The versions are what each replay is about, so
    // callers still name those; the rest only need to exist, and matching
    // `fixture()`'s self-updating shape is what stops a sixth package breaking a
    // 2026-08-06 replay it has nothing to do with.
    for (const t of readTargets(dir)) {
      if (versions[t.manifest] !== undefined) continue;
      mkdirSync(join(dir, dirname(t.manifest)), { recursive: true });
      writeFileSync(join(dir, t.manifest), JSON.stringify({ name: t.name, version: "1.0.0" }));
    }
    // Today's CHANGELOGs even in a historical fixture: the allocation leg's
    // subject is the tree the alarm is checked out in, and the replay below is
    // about the registry and the run list, not about the allocation contract.
    writeChangelogs(dir);
    return dir;
  }

  // 06:37 UTC — the first cron after the first two failures (00:42 and 01:26,
  // both on the `adapter-claude-sdk` publish job). main is f8694aca, committed
  // 01:26:29 UTC. release.yml at that commit decided three targets.
  const at0637 = Date.parse("2026-08-06T06:37:00Z");
  const early = check({
    root: historical(
      [
        `scripts/ci/decide-publish.sh "@pome-sh/cli" "cli/package.json" "cli"`,
        `scripts/ci/decide-publish.sh "@pome-sh/adapter-claude-sdk" "packages/adapter-claude-sdk/package.json" "adapter"`,
        `scripts/ci/decide-publish.sh "@pome-sh/wire" "packages/wire/package.json" "wire" "${GH_PACKAGES}"`,
      ].join("\n"),
      {
        "cli/package.json": "0.21.8",
        "packages/adapter-claude-sdk/package.json": "0.3.3",
        "packages/wire/package.json": "0.2.1",
      },
    ),
    repo: REPO,
    now: at0637,
    gitHub: (args) =>
      args.join(" ").includes("/commits/main")
        ? JSON.stringify({
            sha: "f8694aca705618cacc1de82613d6bb4cb3723929",
            commit: { committer: { date: "2026-08-06T01:26:29Z" } },
          })
        : JSON.stringify({
            workflow_runs: [
              { id: 31062739165, head_sha: "f8694aca705618cacc1de82613d6bb4cb3723929", status: "completed", conclusion: "failure", created_at: "2026-08-06T01:26:32Z" },
              { id: 31060554081, head_sha: "96e10b0c00000000000000000000000000000000", status: "completed", conclusion: "failure", created_at: "2026-08-06T00:42:37Z" },
              { id: 31059706519, head_sha: "ba15fcb200000000000000000000000000000000", status: "completed", conclusion: "success", created_at: "2026-08-06T00:26:24Z" },
            ],
          }),
    // What each registry actually served at 06:37: cli 0.21.8 landed 01:28,
    // adapter was still on 0.3.1 (0.3.3 did not publish until 13:11).
    readVersion: (name) =>
      ({
        "@pome-sh/cli": { version: "0.21.8" },
        "@pome-sh/adapter-claude-sdk": { version: "0.3.1" },
        "@pome-sh/wire": { version: "0.2.1" },
      })[name],
  });
  check_(
    "fires at the first cron, ~4h before the 10:41 merge failed too",
    early.alarms.length > 0,
    early.report,
  );
  check_(
    "names the package the publish job actually failed on",
    early.alarms.some((a) => a.startsWith("UNPUBLISHED") && a.includes("@pome-sh/adapter-claude-sdk 0.3.3")),
    early.alarms.join("\n"),
  );
  check_(
    "names the failed run",
    early.alarms.some((a) => a.startsWith("FAILED") && a.includes("31062739165")),
    early.alarms.join("\n"),
  );
  check_(
    "says nothing about the two packages that did publish",
    !early.alarms.some((a) => a.includes("@pome-sh/cli") || a.includes("@pome-sh/wire")),
    early.alarms.join("\n"),
  );

  // 12:00 UTC — after the 11:28 run failed on THREE jobs (adapter, checks,
  // wire), main at 9119a07. The human noticed later; the manual
  // workflow_dispatch that recovered it ran at 13:10.
  const at1200 = Date.parse("2026-08-06T12:00:00Z");
  const late = check({
    root: historical(
      readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"),
      {
        "cli/package.json": "0.21.9",
        "packages/adapter-claude-sdk/package.json": "0.3.3",
        "packages/checks/package.json": "0.1.0",
        "packages/wire/package.json": "0.2.1",
      },
    ),
    repo: REPO,
    now: at1200,
    gitHub: (args) =>
      args.join(" ").includes("/commits/main")
        ? JSON.stringify({
            sha: "9119a07f00000000000000000000000000000000",
            commit: { committer: { date: "2026-08-06T11:28:00Z" } },
          })
        : JSON.stringify({
            workflow_runs: [
              { id: 31097401934, head_sha: "9119a07f00000000000000000000000000000000", status: "completed", conclusion: "failure", created_at: "2026-08-06T11:28:30Z" },
              { id: 31094244061, head_sha: "452daee900000000000000000000000000000000", status: "completed", conclusion: "failure", created_at: "2026-08-06T10:41:20Z" },
            ],
          }),
    // cli 0.21.9 published at 10:42; checks 0.1.0 and wire 0.2.1 had never been
    // published (13:04 and 13:03, by the manual dispatch); adapter was on 0.3.1.
    //
    // Anything this replay does not name is a package that did not exist on
    // 2026-08-06 and is answered in sync with the version `historical` backfilled
    // — the same `?? { version: "1.0.0" }` fallback `registryStub` uses. Without
    // it the fifth target reads `undefined` and this replay reds over a
    // package it is not about, which is the trap the fixture backfill above
    // exists to close on the other side.
    readVersion: (name, registry) =>
      registry
        ? { version: "0.2.1" }
        : {
            "@pome-sh/cli": { version: "0.21.9" },
            "@pome-sh/adapter-claude-sdk": { version: "0.3.1" },
            "@pome-sh/checks": { version: "0.0.0", unpublished: true },
            "@pome-sh/wire": { version: "0.0.0", unpublished: true },
          }[name] ?? { version: "1.0.0" },
    graceMinutes: 30, // the cron would have been the next morning; 12:00 is 32 min after
  });
  const unpublished = late.alarms.filter((a) => a.startsWith("UNPUBLISHED"));
  check_(
    "names exactly the three packages whose publish jobs failed at 11:28",
    unpublished.length === 3 &&
      ["@pome-sh/adapter-claude-sdk", "@pome-sh/checks", "@pome-sh/wire"].every((p) =>
        unpublished.some((a) => a.includes(p)),
      ),
    unpublished.join("\n"),
  );
  check_(
    "leaves @pome-sh/cli alone — 0.21.9 did publish, at 10:42",
    !unpublished.some((a) => a.includes("@pome-sh/cli")),
    unpublished.join("\n"),
  );
  check_(
    "the grading pin is named by version, not just by package",
    unpublished.some((a) => a.includes("@pome-sh/checks 0.1.0") && a.includes("serves nothing")),
    unpublished.join("\n"),
  );
}

// ── end to end: exit code, $GITHUB_OUTPUT protocol, --targets ───────────────
console.log("the script's own surface");
{
  const dir = fixture({ "@pome-sh/checks": "0.2.0" });
  const bin = mkdtempSync(join(tmpdir(), "release-alarm-bin-"));
  writeFileSync(
    join(bin, "gh-impl.mjs"),
    `const joined = process.argv.slice(2).join(" ");
     if (joined.includes("/commits/main")) {
       process.stdout.write(JSON.stringify({ sha: "${HEAD_SHA}", commit: { committer: { date: "${minutesAgo(600)}" } } }));
     } else if (joined.includes("release.yml/runs")) {
       process.stdout.write(JSON.stringify({ workflow_runs: [
         { id: 31097401934, head_sha: "${HEAD_SHA}", status: "completed", conclusion: "failure", created_at: "${minutesAgo(300)}" },
       ] }));
     } else { process.stderr.write("unexpected: " + joined); process.exit(2); }
    `,
  );
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\nexec node "$(dirname "$0")/gh-impl.mjs" "$@"\n`);
  // Every package resolves except @pome-sh/checks, which is E404 — the 08-06 shape.
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash\nif [[ "$*" == *"@pome-sh/checks"* ]]; then\n  echo "npm error code E404" >&2\n  exit 1\nfi\necho 1.0.0\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);

  const outFile = join(bin, "github-output.txt");
  writeFileSync(outFile, "");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_REPOSITORY: REPO,
    GITHUB_OUTPUT: outFile,
    NOW_MS: String(NOW),
  };
  const r = spawnSync("node", [SCRIPT, dir], { encoding: "utf8", env });
  const out = readFileSync(outFile, "utf8");

  check_("exits 1 when alarming", r.status === 1, `status=${r.status} ${r.stderr}`);
  check_("writes alarm=true", /^alarm=true$/m.test(out), out);
  check_("reason names the package", /@pome-sh\/checks 0\.2\.0/.test(out), out);
  check_("reason names the failed run URL", /actions\/runs\/31097401934/.test(out), out);
  check_("report is heredoc-delimited", /report<<POME_EOF/.test(out), out);
  check_("annotates for the run log", /::error::UNPUBLISHED/.test(r.stderr), r.stderr);

  // --targets is the network-free dead-guard arm ci.yml runs on every PR.
  const t = spawnSync("node", [SCRIPT, "--targets"], { encoding: "utf8", env: process.env });
  check_("--targets exits 0 against the real repo", t.status === 0, t.stderr);
  check_("--targets lists @pome-sh/cli", /@pome-sh\/cli/.test(t.stdout), t.stdout);
  check_("--targets needs no GITHUB_REPOSITORY", !/GITHUB_REPOSITORY/.test(t.stderr));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\n✅ release-alarm regression suite green");
