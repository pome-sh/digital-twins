#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The number is written here, on main, after the merge.
//
// A version line hand-written in a PR invalidates every other open PR that
// pinned it, silently, because those PRs stay green — their CI ran before the
// merge. Writing it on the tip instead removes the whole class.
//
// The tempting alternative, recorded because it is cheaper and will be
// suggested again: have PRs write a placeholder and compute the real number at
// publish time from the registry's `latest`. It makes release.yml's `plan` job
// vacuous — "behind the registry is a hard failure" becomes structurally
// impossible to trip, so that check passes forever without being able to fire.
//
// This script is the whole of "the pipeline writes it". `.github/workflows/
// allocate-version.yml` runs it on every push to `main`; it writes version lines
// and CHANGELOG headings, and commits. `release.yml` is untouched: it still
// diffs each package's local manifest against its registry on push to `main`,
// still hard-fails on behind-npm, still baselines a never-seen package at 0.0.0.
// The bump commit is a push to `main`, so it is that commit's own `release.yml`
// run that publishes.
//
// ── WHAT EARNS A NUMBER ──────────────────────────────────────────────────────
//
// A package is owed a release if EITHER holds:
//
//   pending    — its CHANGELOG has an `## Unreleased (patch|minor)` section.
//                Someone asked for a release in words; that is a request in its
//                own right, even for a change no path rule would notice.
//   relevance  — a publish-relevant path of that package moved since the last
//                commit that changed its version (`publish-relevance.mjs` owns
//                which paths those are, including the wire→cli/adapter/checks
//                coupling). This is the half that cannot be forgotten: the
//                failure this apparatus exists to prevent is a fix that merges
//                clean and never reaches a consumer, and a rule that only fires
//                when someone remembered to write prose reintroduces it.
//
// The LEVEL is never inferred. It comes from the pending heading, and a package
// owed a release with no pending entry gets a patch plus an entry naming the
// commits — see `derivedEntry()` for why that is written rather than refused.
//
// ── THE THREE PROPERTIES THAT HOLD ──────────────────────────────────────────
//
// 1. THE BUMP COMMIT CANNOT RE-TRIGGER A PUBLISH LOOP. Relevance is measured
//    from `lastVersionChange()` — the newest commit that moved that package's
//    version — and the bump commit IS such a commit. So one push after a
//    release, the range is empty and the pending entry it consumed is gone: the
//    allocator is a no-op on its own output. That is structural, not a marker
//    match. Two further, independent guards sit on top of it: a `CHANGELOG.md`
//    is not a publish-relevant path (`publish-relevance.mjs` explains why), and
//    allocate-version.yml skips a push whose head commit carries the marker
//    below. Either one alone would stop the loop; none of them is load-bearing
//    alone.
//
// 2. TWO PRs MERGING CLOSE TOGETHER CANNOT DOUBLE-ALLOCATE. The unit of
//    allocation is `main`'s TIP, never the pushed range: the script reads the
//    tip's manifests and the tip's pending entries, and allocate-version.yml
//    serialises itself with a `concurrency` group and re-runs the whole
//    computation after any rejected push. Two merges that land inside one
//    window get ONE number carrying both entries — which is the truth (both
//    were on `main` when the number was cut), not a lost release.
//
// 3. INSERTIONS ONLY. `changelog-entry.mjs`'s `writeRelease()` reassembles a
//    file as `preamble + newSection + releasedRegion`, so a released entry is
//    carried across byte-for-byte. The PR gate compares that same region against
//    the base branch, which is the human half of the same property.
//
// Usage:
//   node scripts/ci/allocate-release-versions.mjs [repo root]      # plan only
//   node scripts/ci/allocate-release-versions.mjs --write \
//        [--plan-out f.json] [--message-out f.txt] [--regen-out f.sh] [repo root]
//   env: POME_ALLOCATION_DATE=YYYY-MM-DD (tests; default: today, UTC)

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { planExampleRepins } from "../check-example-pins-published.mjs";
import { bumpVersion, pendingRelease, writeRelease } from "./changelog-entry.mjs";
import { PUBLISHED_PACKAGES, packagesTouchedBy } from "./publish-relevance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Carried in the bump commit's subject. Read by allocate-version.yml's job-level
 * `if:` as a cheap "don't even start" — deliberately NOT the loop guard (see
 * property 1 above). If this string and the workflow's copy of it ever drift,
 * the allocator simply runs and finds nothing to do; nothing breaks.
 */
export const BUMP_COMMIT_MARKER = "[release-bump]";

/**
 * How far back to look for the commit that last moved a package's version.
 * Path-filtered, so this is 60-odd commits for a real package, and the loop
 * usually exits on the first. Exhausting it is not treated as "nothing to do":
 * see `lastVersionChange`.
 */
const VERSION_WALK_LIMIT = 500;

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitLines(root, args) {
  return git(root, args).split("\n").filter(Boolean);
}

/** The version a manifest declared at a ref, or null if it wasn't there. */
function versionAt(root, ref, manifest) {
  try {
    return JSON.parse(git(root, ["show", `${ref}:${manifest}`])).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The newest commit that CHANGED this manifest's version — the point after which
 * changed files are not yet in any release.
 *
 * "Changed the version" rather than "touched the manifest", because a Renovate
 * dependency bump touches the manifest without allocating anything, and rather
 * than "carries the marker below", because that would be blind to the hand-bump
 * era this replaces (and to a founder-bypass bump). The bump commit this script
 * writes is itself a version change, which is what makes the loop terminate.
 *
 * Returns `{ sha }`, or `{ sha: null, exhausted }` when no such commit is
 * reachable. A null answer widens the range to the whole history, which will
 * over-allocate rather than under-allocate — the deliberate direction: a
 * spurious patch release is visible and cheap, a silently skipped one is the
 * defect this file exists to prevent.
 */
export function lastVersionChange(root, manifest) {
  const shas = gitLines(root, ["log", "--format=%H", "--", manifest]);
  for (const sha of shas.slice(0, VERSION_WALK_LIMIT)) {
    if (versionAt(root, sha, manifest) !== versionAt(root, `${sha}^`, manifest)) return { sha };
  }
  return { sha: null, exhausted: shas.length > VERSION_WALK_LIMIT };
}

/**
 * The entry written for a package that is owed a release and has no words —
 * today, only the coupled case: wire moved, so the CLI's, the adapter's and
 * checks' tarballs all carry different bytes and each needs a release, and
 * whoever changed wire may have had nothing to say about three other packages.
 * Version-only releases have been accepted for exactly this since
 * `cli/CHANGELOG.md` 0.21.7.
 *
 * WRITTEN, NOT REFUSED. Failing here would mean not publishing, which is the
 * silence the whole apparatus exists to end; and this repo's own convention is
 * that a gap gets named in the record rather than papered over. So the entry
 * says plainly that no words were supplied and names the commits, which is
 * where the words are.
 */
function derivedEntry({ pkg, files, commits }) {
  const paths = [...new Set(files.map((file) => file.replace(/[^/]+$/, "")))].sort().slice(0, 6);
  return [
    `Version-only release: publish-relevant paths changed and no \`## Unreleased\``,
    `entry was supplied, so this heading is the whole record. \`${pkg.name}\`'s bytes`,
    `moved under ${paths.map((p) => `\`${p}\``).join(", ")}.`,
    "",
    ...(commits.length ? commits.map((line) => `- ${line}`) : ["- (no commit subjects available)"]),
  ].join("\n");
}

/**
 * What `main`'s tip owes, per package. Pure read — nothing is written unless
 * `applyAllocations()` is called with the result.
 */
export function planAllocations({ root = resolve(HERE, "../.."), date = today(), npmView } = {}) {
  if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error(
      "refusing to allocate versions in a shallow clone: the walk for 'when did this " +
        "version last move' would be truncated, and a truncated walk silently mis-scopes " +
        "which packages are owed a release. Check out with fetch-depth: 0.",
    );
  }

  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const allocations = [];
  const notes = [];

  for (const pkg of PUBLISHED_PACKAGES) {
    const manifestPath = join(root, pkg.manifest);
    const manifest = readFileSync(manifestPath, "utf8");
    const from = JSON.parse(manifest).version;
    const changelogPath = join(root, pkg.changelog);
    const changelog = readFileSync(changelogPath, "utf8");

    const pending = pendingRelease(changelog, pkg.changelog);

    const since = lastVersionChange(root, pkg.manifest);
    if (since.exhausted) {
      notes.push(
        `${pkg.name}: no version change found in the last ${VERSION_WALK_LIMIT} commits touching ` +
          `${pkg.manifest} — measuring relevance against the whole history, which over-allocates.`,
      );
    }
    const range = since.sha ? [since.sha, head] : [head];
    const changed = since.sha ? gitLines(root, ["diff", "--name-only", since.sha, head]) : gitLines(root, ["ls-files"]);
    const relevance = packagesTouchedBy(changed).find((hit) => hit.pkg.name === pkg.name);

    if (!pending && !relevance) continue;

    const level = pending?.level ?? "patch";
    const to = bumpVersion(from, level);
    const commits = since.sha
      ? gitLines(root, [
          "log",
          "--format=%h %s",
          `${since.sha}..${head}`,
          "--",
          ...(relevance?.files ?? []),
        ]).slice(0, 20)
      : [];
    const body = pending?.body || derivedEntry({ pkg, files: relevance?.files ?? [], commits });

    allocations.push({
      name: pkg.name,
      manifest: pkg.manifest,
      changelog: pkg.changelog,
      from,
      to,
      level,
      reason: [pending ? "entry" : null, relevance ? "relevance" : null].filter(Boolean).join("+"),
      relevantFiles: relevance?.files ?? [],
      since: range,
      regenerate: pkg.regenerate ? [pkg.regenerate] : [],
      versionedArtifacts: pkg.versionedArtifacts ?? [],
      writes: [
        { path: pkg.manifest, contents: rewriteVersion(manifest, { from, to, path: pkg.manifest }) },
        {
          path: pkg.changelog,
          contents: writeRelease(changelog, { version: to, date, body, label: pkg.changelog }),
        },
      ],
    });
  }

  // An example that pins a `@pome-sh/*` package from the registry
  // (today only `agent-examples/support-triage`) must never fall out of sync with
  // that sibling's published version: two incidents (adapter 0.3.4 and 0.3.6,
  // both 2026-08-13) each reddened `check-example-pins-published.mjs` until a
  // human noticed and opened a one-line PR. `planExampleRepins` is the part of
  // that gate's own logic that already answers "which pins are safely fixable
  // right now" (its `violations`: drifted AND the sibling is CONFIRMED
  // published) — reused rather than re-implemented, discovered from
  // `agent-examples/*/package.json` rather than a hand-kept list.
  //
  // Deliberately measured against the manifests ON DISK, before this run's own
  // `writes` above are applied: a package THIS SAME run is bumping is not yet
  // published (that happens in `release.yml`'s run of the commit this script is
  // about to push), so `planExampleRepins`'s own registry check correctly finds
  // it unpublished and leaves it alone — repinning to a version that does not
  // exist yet would need a lockfile entry `npm install --package-lock-only`
  // cannot resolve, and a manifest pin with no matching lockfile entry breaks
  // `npm ci` for that example outright, which is worse than the drift this
  // exists to fix. That version's example pin gets corrected on the FIRST
  // subsequent run of this workflow after `release.yml` actually publishes it —
  // still fully automatic, still no human PR, just one push later.
  //
  // ONE guard around the whole call, rather than a guard per throw site. A
  // re-pin is cosmetic; an allocation is not — and this function runs on every
  // push to `main`, so ANY throw from the example walk stops EVERY package's
  // release over one example directory. The reachable vectors today are already
  // more than one (an ambiguous pin, a malformed `agent-examples/*/package.json` that
  // `discoverExampleSiblingDeps` `JSON.parse`s unguarded, `loadWorkspaceMembers`
  // on an empty `workspaces` glob) and the next one arrives with the next
  // caller, so the invariant is enforced here where it is total. The failure is
  // loud — `notes` is printed as `::warning::` — and the read-side gate in
  // `ci.yml` still reds on whatever the example is doing wrong, so nothing is
  // swallowed, only de-escalated to the blast radius it should have had.
  let repins = [];
  try {
    repins = npmView ? planExampleRepins(root, npmView) : planExampleRepins(root);
  } catch (err) {
    notes.push(
      `example re-pin planning failed and was SKIPPED so it cannot block this allocation — ${err.message}. ` +
        "check-example-pins-published.mjs still reds on the drift.",
    );
  }

  return { head, date, allocations, repins, notes, message: commitMessage(allocations, repins, head) };
}

/**
 * Replace the `"version": "x.y.z"` line textually rather than re-emitting
 * `JSON.stringify(manifest)`: a manifest round-tripped through JSON.parse loses
 * its key order, its indentation and its trailing newline, and the diff of a
 * release commit should be one line.
 *
 * The occurrence count is asserted rather than assumed. `String.replace` with a
 * string pattern silently replaces only the FIRST match, so a manifest that grew
 * a second `"version":` key (inside a nested config block) would have the wrong
 * one rewritten and still parse as valid JSON.
 */
function rewriteVersion(manifest, { from, to, path }) {
  const line = (version) => `"version": "${version}"`;
  const occurrences = manifest.split(line(from)).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${path}: expected exactly one \`${line(from)}\`, found ${occurrences}. Refusing to guess ` +
        `which one is the package's own version.`,
    );
  }
  return manifest.replace(line(from), line(to));
}

function commitMessage(allocations, repins, head) {
  if (allocations.length === 0 && repins.length === 0) return "";
  const named = allocations.map((a) => `${a.name} ${a.to}`);
  const subject =
    allocations.length === 0
      ? `chore: re-pin ${repins.length} example dep(s) to the published version ${BUMP_COMMIT_MARKER}`
      : allocations.length <= 2
        ? `release: ${named.join(", ")} ${BUMP_COMMIT_MARKER}`
        : `release: ${allocations.length} packages ${BUMP_COMMIT_MARKER}`;
  return [
    subject,
    "",
    ...allocations.map((a) => `- ${a.name} ${a.from} → ${a.to} (${a.level}, ${a.reason})`),
    ...repins.map((r) => `- agent-examples/${r.example} ${r.dep} ${r.from} → ${r.to} (published pin re-pin)`),
    "",
    `Allocated from ${head.slice(0, 8)} by .github/workflows/allocate-version.yml.`,
    "The version number is written here, after the merge, and never in a PR.",
    "",
  ].join("\n");
}

/** Applies a plan's writes. Returns the paths written. */
export function applyAllocations(plan, { root = resolve(HERE, "../..") } = {}) {
  const written = [];
  for (const allocation of [...plan.allocations, ...plan.repins]) {
    for (const write of allocation.writes) {
      writeFileSync(join(root, write.path), write.contents);
      written.push(write.path);
    }
  }
  return written;
}

function today() {
  return process.env.POME_ALLOCATION_DATE ?? new Date().toISOString().slice(0, 10);
}

export function main(argv = process.argv.slice(2)) {
  const flagValue = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const flagValues = new Set(["--plan-out", "--message-out", "--regen-out"].map(flagValue).filter(Boolean));
  // An optional positional repo root, same shape as release-alarm.mjs, so the
  // regression suite can drive the real CLI over a throwaway repository instead
  // of asserting against the plan function alone.
  const root = resolve(argv.find((arg) => !arg.startsWith("--") && !flagValues.has(arg)) ?? resolve(HERE, "../.."));

  const plan = planAllocations({ root });
  for (const note of plan.notes) console.log(`::warning::${note}`);

  if (plan.allocations.length === 0 && plan.repins.length === 0) {
    console.log(`Nothing to allocate at ${plan.head.slice(0, 8)} — no pending entry, no unreleased`);
    console.log("publish-relevant change, no example pin drifted from an already-published sibling.");
    console.log("(This is what the bump commit's own push looks like.)");
  }
  for (const a of plan.allocations) {
    console.log(`${a.name}: ${a.from} → ${a.to}  (${a.level}, ${a.reason})`);
    for (const file of a.relevantFiles.slice(0, 10)) console.log(`    ${file}`);
    if (a.relevantFiles.length > 10) console.log(`    … ${a.relevantFiles.length - 10} more`);
  }
  for (const r of plan.repins) {
    console.log(`agent-examples/${r.example}: ${r.dep} ${r.from} → ${r.to}  (published pin drift)`);
  }

  const planOut = flagValue("--plan-out");
  if (planOut) writeFileSync(planOut, `${JSON.stringify(plan, null, 2)}\n`);
  const messageOut = flagValue("--message-out");
  if (messageOut) writeFileSync(messageOut, plan.message);
  // The regeneration commands are DERIVED from the table beside the artifacts
  // they produce (wire's trace-contract.json embeds wire's own version and is
  // byte-compared by a required gate), rather than hand-wired into the workflow
  // YAML: a second versioned artifact should not need a workflow edit to be
  // regenerated, and the command belongs next to the file it writes.
  const regenOut = flagValue("--regen-out");
  if (regenOut) {
    const commands = [...plan.allocations, ...plan.repins].flatMap((a) => a.regenerate);
    writeFileSync(regenOut, commands.length ? `set -euo pipefail\n${commands.join("\n")}\n` : "");
  }

  if (argv.includes("--write")) {
    const written = applyAllocations(plan, { root });
    for (const path of written) console.log(`wrote ${path}`);
  }
  return plan;
}

// Realpath'd on both sides — node resolves symlinks before deriving
// `import.meta.url`, so a bare `pathToFileURL()` of argv[1] misses through a
// symlinked checkout (a worktree, or macOS's symlinked `/tmp`) in the same
// silent shape, and a guard miss while invoked as this file throws
// rather than exits 0.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("allocate-release-versions.mjs")) {
  throw new Error(`allocate-release-versions.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) main();
