#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1350 — a failed release must reach a human without a human going looking.
//
// On 2026-08-06 four consecutive push-triggered `release.yml` runs failed over
// eleven hours (00:42, 01:26, 10:41, 11:28 UTC). Nothing fired. `release.yml`
// has no failure path — no `if: failure()`, no notification, no tracking issue
// — so a publish that died is indistinguishable from a merge that owed no
// publish. The first signal was a human noticing two packages missing from npm,
// and the recovery was that human dispatching the workflow by hand. Two of
// those four runs were the merges of F-1308 and F-949's wire work: the packages
// the grading vocabulary now depends on, reporting themselves as merged while
// publishing nothing.
//
// This is the checker behind `.github/workflows/release-alarm.yml`. It runs on
// its own daily schedule, in a SEPARATE workflow file, because the alarm has to
// survive the thing it is watching — the reasoning `check-release-staleness.yml`
// gave before it was deleted alongside the Changesets flow it watched
// (`a3c9441`, "replace two release systems with one"). Deleting it with its
// subject was right; not replacing it was the gap. An `if: failure()` step
// inside `release.yml` cannot see the silence that bit F-1180: a release
// workflow that never triggers at all takes an embedded check down with it.
//
// ── What it asserts ──────────────────────────────────────────────────────────
//
// Primarily an OUTCOME check, not a mechanism one: for every package
// `release.yml` can publish, does its registry actually serve the version main
// declares? That question is blind to HOW a publish went missing, which is the
// point — "ran and failed", "never ran", "cancelled", "the plan job skipped it"
// and "someone disabled the job" all land on the same answer. The mechanism
// legs below exist for the cases where nothing was owed and the release path is
// broken anyway, which the outcome check cannot see until the next bump.
//
//   UNALLOCATED — main carries a pending `## Unreleased` entry that no
//                 allocation consumed (F-1511). The version number is written on
//                 main after the merge by allocate-version.yml, so a broken or
//                 unconfigured allocator produces a state the outcome check
//                 CANNOT see: main declares the old version, the registry serves
//                 the old version, everything agrees, and the fix never ships.
//                 A pending entry is transient by construction — the allocator
//                 consumes it on the next push — so one still sitting there past
//                 the grace window is that silence, named.
//   UNPUBLISHED — main declares a version its registry does not serve. The
//                 08-06 shape, and the only state a consumer can observe.
//   BEHIND      — main declares a version BELOW the registry's `latest`. Not
//                 yet a missing publish; it is the floor check in
//                 decide-publish.sh armed to hard-fail the whole lane on the
//                 next merge, taking that merge's unrelated publishes with it.
//   NEVER_RAN   — main's HEAD has no `release.yml` run at all and is past the
//                 grace window. The F-1180 silence: a push to main that
//                 triggered nothing (a bot pushing with the ambient
//                 GITHUB_TOKEN cannot trigger workflows), or Actions disabled.
//   STUCK       — a run has been queued/in_progress past the stuck window.
//                 `release.yml` sets `cancel-in-progress: false`, so one hung
//                 run holds the concurrency lock and everything behind it waits.
//   FAILED      — the newest COMPLETED run on main did not succeed, with
//                 nothing newer in flight. Catches a broken release path even
//                 when no version was owed, so it is visible before the next
//                 bump rather than after it.
//   UNMEASURED  — a registry read failed for a reason other than 404. Reported
//                 as its own state and never folded into UNPUBLISHED: a 401 for
//                 a package that exists reads identically to "nothing published
//                 yet" unless the two are kept apart, which is the same
//                 distinction decide-publish.sh is careful about.
//
// Silence is asserted as hard as noise: everything green produces no issue, no
// comment, and exit 0 — an alarm that cries wolf gets muted, and a muted alarm
// is the state this ticket is about.
//
// ── Why the package list is derived, not typed ───────────────────────────────
//
// The publish targets are parsed out of `release.yml`'s own
// `scripts/ci/decide-publish.sh` invocations rather than listed here. A second
// hand-maintained copy of "what gets published" is a guard that goes quietly
// blind the day someone adds a fifth package — a list that stops matching its
// subject still passes, forever. Deriving it means a new target is watched the
// same day it is added, and a `release.yml` restructured past the parse is a
// hard failure (`--targets` in ci.yml's always-on block) rather than an alarm
// that silently watches nothing.
//
// Usage: node scripts/ci/release-alarm.mjs [repo root]
//        node scripts/ci/release-alarm.mjs --targets   (parse only, no network)
//   env: GITHUB_REPOSITORY, GH_TOKEN
//        GRACE_MINUTES (default 90)  — how long after a push to main before its
//          missing publish counts as missing rather than still building.
//        STUCK_MINUTES (default 360) — how long in flight before a run is hung.
//        NOW_MS (tests)
//   Writes alarm= / reason= / report= to $GITHUB_OUTPUT. Exits 1 when alarming.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pendingRelease } from "./changelog-entry.mjs";
import { PUBLISHED_PACKAGES } from "./publish-relevance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELEASE_WORKFLOW = "release.yml";
const ALLOCATE_WORKFLOW = "allocate-version.yml";

/**
 * Every publish target `release.yml` decides on, read from the workflow itself.
 *
 * `decide-publish.sh <name> <manifest> <output-key> [registry]` — an omitted
 * registry means registry.npmjs.org. @pome-sh/wire legitimately appears twice
 * with two registries (npmjs and GitHub Packages, from the same version line),
 * so targets are keyed on name+registry rather than name.
 */
export function parseTargets(root) {
  const targets = readTargets(root);
  for (const t of targets) {
    if (!existsSync(join(root, t.manifest))) {
      throw new Error(`${RELEASE_WORKFLOW} points ${t.name} at ${t.manifest}, which does not exist`);
    }
  }
  return targets;
}

/**
 * The parse half of `parseTargets`, without the "every manifest exists" leg.
 *
 * Split out for callers that need to know WHICH manifests a workflow names
 * before those manifests exist — the test suite's historical fixtures build a
 * scratch tree from the real release.yml and have to create them. Folding that
 * need into `parseTargets` would mean weakening the existence check, and that
 * check is the whole reason the alarm cannot silently watch a package whose
 * manifest was moved or renamed.
 *
 * The empty-targets guard stays HERE rather than in `parseTargets`, because it
 * is a property of the parser rather than of the tree: an alarm watching zero
 * packages passes forever, and a fixture builder that silently created nothing
 * would be the same failure one layer down.
 */
export function readTargets(root) {
  const file = join(root, ".github/workflows", RELEASE_WORKFLOW);
  if (!existsSync(file)) throw new Error(`${RELEASE_WORKFLOW} not found at ${file}`);
  const yaml = readFileSync(file, "utf8");
  const re = /decide-publish\.sh\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"(?:\s+"([^"]+)")?/g;

  const targets = [];
  for (const [, name, manifest, outputKey, registry] of yaml.matchAll(re)) {
    targets.push({ name, manifest, outputKey, registry: registry ?? "" });
  }
  if (targets.length === 0) {
    throw new Error(
      `no decide-publish.sh calls found in ${RELEASE_WORKFLOW}. Either the release ` +
        `stopped using it or this parser has drifted — an alarm watching zero ` +
        `packages passes forever, so this is a hard failure, not an empty run.`,
    );
  }
  return targets;
}

/**
 * Semver order, enough for the `x.y.z[-pre]` versions these packages use.
 * A prerelease sorts BELOW its release, which is where this deliberately
 * differs from decide-publish.sh's `sort -V` (GNU version sort puts
 * `1.0.0-rc1` above `1.0.0`). Nothing here ships prereleases; if that changes,
 * the release's own floor check is the one that has to be corrected, not this.
 */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = ""] = String(v).split("-");
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * What the registry currently serves.
 *
 * Read independently of decide-publish.sh on purpose. A watcher that shares its
 * subject's code goes blind with it, and the shared thing that MUST NOT drift —
 * which package, which manifest, which registry — is derived from release.yml
 * above rather than duplicated. What is duplicated is fifteen lines of
 * 404-vs-everything-else, and the distinction is asserted by this script's own
 * regression suite.
 */
export function registryVersion(name, registry) {
  const args = ["view", name, "version", ...(registry ? ["--registry", registry] : [])];
  const r = spawnSync("npm", args, { encoding: "utf8" });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === 0) return { version: r.stdout.trim() };
  // A brand-new package genuinely has nothing published; 0.0.0 is the correct
  // baseline and is NOT an alarm on its own (the drift check below still fires
  // if main declares a version, which is exactly right for a first publish that
  // never happened).
  if (/E404|404 Not Found/.test(output)) return { version: "0.0.0", unpublished: true };
  return { error: output.trim().split("\n").filter(Boolean).slice(-2).join(" / ") || "unknown npm error" };
}

const minutesSince = (iso, now) => (now - Date.parse(iso)) / 60_000;

/** Newest first, so "the newest completed run" needs no scan order assumption. */
function newestFirst(runs) {
  return [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

function runUrl(repo, run) {
  return `https://github.com/${repo}/actions/runs/${run.id}`;
}

/** The mechanism legs: is the release path itself alive? */
function inspectReleaseRuns({ repo, head, runs, now, graceMinutes, stuckMinutes }) {
  const alarms = [];
  const lines = [];
  const headAge = minutesSince(head.date, now);
  const forHead = runs.filter((r) => r.head_sha === head.sha);
  const inFlight = runs.filter((r) => r.status !== "completed");
  const newestCompleted = runs.find((r) => r.status === "completed");

  lines.push(
    `main HEAD ${head.sha.slice(0, 8)} (${headAge.toFixed(0)} min old) — ` +
      (forHead.length
        ? forHead.map((r) => `${r.status}/${r.conclusion ?? "—"} ${runUrl(repo, r)}`).join(", ")
        : "NO release run"),
  );
  lines.push(
    `newest completed release run: ` +
      (newestCompleted
        ? `${newestCompleted.conclusion} ${runUrl(repo, newestCompleted)}`
        : "none in the window"),
  );

  if (forHead.length === 0 && headAge > graceMinutes) {
    alarms.push(
      `NEVER_RAN — main's HEAD ${head.sha.slice(0, 8)} has been on main for ` +
        `${headAge.toFixed(0)} min (grace ${graceMinutes}) and \`${RELEASE_WORKFLOW}\` never ran on it. ` +
        `A push that triggers nothing publishes nothing, and reports nothing.`,
    );
  }

  const hung = inFlight.filter((r) => minutesSince(r.created_at, now) > stuckMinutes);
  if (hung.length > 0) {
    alarms.push(
      `STUCK — a \`${RELEASE_WORKFLOW}\` run has been ${hung[0].status} for ` +
        `${minutesSince(hung[0].created_at, now).toFixed(0)} min (limit ${stuckMinutes}): ` +
        `${runUrl(repo, hung[0])}. \`cancel-in-progress: false\` means it holds the ` +
        `concurrency lock, so every release behind it is waiting too.`,
    );
  }

  // Only when nothing newer is in flight: a failure already being retried is
  // the release path working, and paging it teaches people to ignore the label.
  const newerInFlight =
    newestCompleted &&
    inFlight.some((r) => Date.parse(r.created_at) > Date.parse(newestCompleted.created_at));
  if (
    newestCompleted &&
    !["success", "skipped"].includes(newestCompleted.conclusion) &&
    !newerInFlight
  ) {
    alarms.push(
      `FAILED — the newest completed \`${RELEASE_WORKFLOW}\` run on main concluded ` +
        `${newestCompleted.conclusion}: ${runUrl(repo, newestCompleted)}. Nothing newer is in flight.`,
    );
  }

  return { alarms, lines, headAge, forHead, inFlight };
}

/**
 * The allocation leg (F-1511): is anything still WAITING for a number?
 *
 * A pending `## Unreleased` entry on main is transient by construction —
 * allocate-version.yml consumes it on the push that created it — so one still
 * there is the allocator not running: the secret unset, the ruleset bypass
 * revoked, three rejected pushes, a crash. None of that is visible to the
 * outcome leg below, which compares main's declared version against the
 * registry and finds them in perfect agreement on the OLD number.
 *
 * WHAT THIS DOES NOT COVER, stated rather than implied: the other half of what
 * earns a release is publish RELEVANCE (paths moved with no entry written), and
 * that half is not checked here. It needs the git history the allocator walks,
 * and a watcher that re-derives it would either share the allocator's table (and
 * go blind with it) or keep a second copy (and drift from it). The PR gate
 * demands an entry for every publish-relevant change, so reaching that state
 * takes a bypassed gate — and any OTHER package with an entry still fires this
 * leg in the same run, because a dead allocator is dead for all of them.
 *
 * Reads the tree it is checked out in, not the registry, so it costs nothing and
 * cannot fail for a network reason. The CHANGELOG path per package comes from
 * scripts/ci/publish-relevance.mjs, the same table the allocator and the PR gate
 * read.
 */
function inspectPendingEntries({ root }) {
  const alarms = [];
  const lines = [];

  for (const pkg of PUBLISHED_PACKAGES) {
    const file = join(root, pkg.changelog);
    if (!existsSync(file)) {
      // Asserted pre-merge by check-release-note-required.mjs, so this is
      // unreachable through a PR. Reported rather than skipped: an alarm that
      // silently stops watching a package is the shape of every bug in this file.
      alarms.push(
        `UNMEASURED — ${pkg.changelog} is missing, so nothing here can say whether ` +
          `${pkg.name} is waiting for a version number.`,
      );
      continue;
    }
    let pending;
    try {
      pending = pendingRelease(readFileSync(file, "utf8"), pkg.changelog);
    } catch (error) {
      alarms.push(
        `UNALLOCATED — ${pkg.changelog} cannot be read as a release request: ${error.message} ` +
          `allocate-version.yml fails on the same parse, so nothing is being allocated.`,
      );
      continue;
    }
    if (!pending) continue;
    lines.push(`${pkg.name} — pending ${pending.level} entry awaiting a number`);
    alarms.push(
      `UNALLOCATED — ${pkg.changelog} carries a pending \`## Unreleased (${pending.level})\` entry ` +
        `that no allocation consumed. \`${ALLOCATE_WORKFLOW}\` writes the number on main after the ` +
        `merge, so nothing has published this and the registry agrees with main about the OLD ` +
        `version — the outcome check below cannot see it.`,
    );
  }

  return { alarms, lines };
}

/** The outcome leg: does each registry serve what main declares? */
function inspectRegistries({ root, targets, readVersion }) {
  const alarms = [];
  const lines = [];

  for (const t of targets) {
    const where = t.registry || "registry.npmjs.org";
    const declared = JSON.parse(readFileSync(join(root, t.manifest), "utf8")).version;
    const seen = readVersion(t.name, t.registry);

    if (seen.error) {
      lines.push(`${t.name} @ ${where} — declared ${declared}, registry UNREADABLE`);
      alarms.push(
        `UNMEASURED — could not read ${t.name} from ${where}: ${seen.error}. ` +
          `This is NOT "unpublished": an auth or transport error for a package that ` +
          `exists reads identically to one that does not, and only one of those is an outage.`,
      );
      continue;
    }

    const order = compareVersions(declared, seen.version);
    lines.push(
      `${t.name} @ ${where} — declared ${declared}, registry ${seen.unpublished ? "(nothing published)" : seen.version}` +
        (order === 0 ? " ✓" : ""),
    );
    if (order > 0) {
      alarms.push(
        `UNPUBLISHED — ${t.name} ${declared} is on main but ${where} serves ` +
          `${seen.unpublished ? "nothing" : seen.version}. Consumers install the old one.`,
      );
    } else if (order < 0) {
      alarms.push(
        `BEHIND — ${t.name} declares ${declared} on main while ${where} already serves ` +
          `${seen.version}. decide-publish.sh hard-fails on this, so the next merge that ` +
          `touches ${t.manifest.replace(/\/package\.json$/, "/")} fails its whole lane.`,
      );
    }
  }

  return { alarms, lines };
}

export function check({
  root,
  repo,
  now,
  readVersion = registryVersion,
  gitHub = gh,
  graceMinutes = Number(process.env.GRACE_MINUTES ?? 90),
  stuckMinutes = Number(process.env.STUCK_MINUTES ?? 360),
}) {
  const targets = parseTargets(root);

  const headCommit = JSON.parse(gitHub(["api", `repos/${repo}/commits/main`]) || "{}");
  const head = {
    sha: headCommit.sha ?? "",
    date: headCommit.commit?.committer?.date ?? headCommit.commit?.author?.date ?? "",
  };
  if (!head.sha || !head.date) throw new Error(`could not read main's HEAD commit for ${repo}`);

  const runs = newestFirst(
    JSON.parse(
      gitHub([
        "api",
        `repos/${repo}/actions/workflows/${RELEASE_WORKFLOW}/runs?branch=main&per_page=30`,
      ]) || "{}",
    ).workflow_runs ?? [],
  );

  const path = inspectReleaseRuns({ repo, head, runs, now, graceMinutes, stuckMinutes });
  const lines = [...path.lines, ""];
  const alarms = [...path.alarms];

  // Registry drift is only meaningful once HEAD's own release has had time to
  // run. Inside the grace window a bump that merged four minutes ago is
  // legitimately not on npm yet, and firing there would be the false alarm that
  // gets the label muted. HEAD is the right subject even for a publish an
  // EARLIER commit missed: `release.yml` diffs against the registry, not against
  // the previous commit, so HEAD's run publishes whatever is still owed.
  if (path.headAge > graceMinutes) {
    // Same grace window, same reason: an entry that merged four minutes ago is
    // legitimately still waiting for allocate-version.yml to finish, and firing
    // there would be the false alarm that gets the label muted.
    const allocation = inspectPendingEntries({ root });
    lines.push(...allocation.lines);
    alarms.push(...allocation.alarms);
    const registries = inspectRegistries({ root, targets, readVersion });
    lines.push(...registries.lines);
    alarms.push(...registries.alarms);
  } else {
    lines.push(
      `registry drift and pending allocations not evaluated — HEAD is ` +
        `${path.headAge.toFixed(0)} min old (grace ${graceMinutes}); its number may still be ` +
        `being allocated and its release may still be building.`,
    );
  }

  return { alarms, report: lines.join("\n"), targets };
}

export function main(argv = process.argv.slice(2)) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const root = resolve(argv.find((a) => !a.startsWith("--")) ?? join(HERE, "../.."));

  // Dead-guard check, network-free: prove release.yml still yields targets. Run
  // in ci.yml's always-on block so a release restructure that this parser cannot
  // follow reds the PR that causes it, rather than the alarm going quietly blind.
  if (flags.includes("--targets")) {
    const targets = parseTargets(root);
    for (const t of targets) {
      console.log(`${t.name}  ←  ${t.manifest}  →  ${t.registry || "registry.npmjs.org"}`);
    }
    console.log(`✅ ${RELEASE_WORKFLOW} declares ${targets.length} publish target(s).`);
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  const now = Number(process.env.NOW_MS ?? Date.now());

  const { alarms, report } = check({ root, repo, now });
  const reason = alarms.join("\n");
  console.log(report);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `alarm=${alarms.length ? "true" : "false"}\n` +
        `reason<<POME_EOF\n${reason}\nPOME_EOF\n` +
        `report<<POME_EOF\n${report}\nPOME_EOF\n`,
    );
  }

  if (alarms.length > 0) {
    for (const a of alarms) console.error(`::error::${a}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n✅ Every version main declares is on its registry, and the release path is alive.");
}

// Realpath'd on both sides — node resolves symlinks before deriving
// `import.meta.url`, so a bare `pathToFileURL()` of argv[1] (with no
// realpath) misses through a symlinked checkout (a worktree, or macOS's
// symlinked `/tmp`) in the same silent shape (F-1488), and a guard miss
// while invoked as this file throws rather than exits 0.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("release-alarm.mjs")) {
  throw new Error(`release-alarm.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) main();
