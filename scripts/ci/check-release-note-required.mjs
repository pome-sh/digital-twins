#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The PR-time half of the release contract.
//
// The number is written on main after the merge, by
// `allocate-release-versions.mjs`. Which paths move which artifact — including
// the wire -> cli/adapter/checks coupling — lives in `publish-relevance.mjs`,
// which both read. What is left here is everything about a release a PR is
// still the right place to decide, which is all of it except the number:
//
//   1. NO HAND-WRITTEN NUMBER. A PR may not move a published package's `version`
//      field. This is the invariant that makes every other PR's green mean
//      something: nothing a PR contains can be invalidated by someone else's
//      merge if no PR carries the number.
//   2. AN ENTRY, FOR EVERY ARTIFACT THE PR MOVES. Publish-relevant paths changed
//      ⇒ that package's CHANGELOG carries an `## Unreleased (patch|minor)`
//      section with prose under it. The words and the patch/minor judgement stay
//      with the author; only the number leaves.
//   3. RELEASED ENTRIES ARE NEVER REWRITTEN. The region from the newest released
//      heading down is byte-identical to the base branch's. This is the
//      insertions-only property, checked against a real base rather than assumed
//      — the allocator holds the same property by construction (see
//      `changelog-entry.mjs`).
//   4. THE HEADING AND THE NUMBER STILL AGREE. Each package's newest released
//      heading names the version its manifest declares. That was the whole old
//      CHANGELOG contract; it is now a fact about `main` that the allocator
//      maintains, and this is where it stays checked.
//
// Runs as one of ci.yml's cheap, dependency-free gates (git reads only, no npm
// install needed). Only meaningful against a PR's actual base, which is why
// ci.yml guards it with `github.event_name == 'pull_request'`.
//
// Usage: node scripts/ci/check-release-note-required.mjs <base-sha>

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { PENDING_HEADING_EXAMPLE, parseChangelog, pendingRelease } from "./changelog-entry.mjs";
import { PUBLISHED_PACKAGES, isPublishIrrelevantPath, packagesTouchedBy } from "./publish-relevance.mjs";

const baseSha = process.argv[2];
if (!baseSha) {
  throw new Error("usage: check-release-note-required.mjs <base-sha>");
}

const changedFiles = execFileSync("git", ["diff", "--name-only", baseSha, "HEAD"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

/** A file's contents at a ref, or null when it wasn't there. */
function showAt(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

const failures = [];
const touched = new Map(packagesTouchedBy(changedFiles).map((hit) => [hit.pkg.name, hit.files]));

for (const pkg of PUBLISHED_PACKAGES) {
  // The table's own paths must exist, so the allocator and release-alarm.mjs can
  // read them without a "file missing" branch that would have to choose between
  // silence and a false alarm. Cheapest possible place to assert it.
  const missing = [pkg.manifest, pkg.changelog].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    failures.push(
      `${pkg.name}: ${missing.join(" and ")} named by scripts/ci/publish-relevance.mjs but not ` +
        `on disk. The allocator and the release alarm both read those paths.`,
    );
    continue;
  }

  const headVersion = JSON.parse(readFileSync(pkg.manifest, "utf8")).version;
  const baseManifest = showAt(baseSha, pkg.manifest);
  const baseVersion = baseManifest === null ? null : JSON.parse(baseManifest).version;

  // 1 — the number is not this PR's to write. A brand-new package is the one
  // exception: its first version has no base to differ from, and someone has to
  // type the line that starts the line.
  if (baseVersion !== null && headVersion !== baseVersion) {
    failures.push(
      `${pkg.name}: this PR moves ${pkg.manifest}'s version from ${baseVersion} to ${headVersion}. ` +
        `Version numbers are allocated on \`main\` after the merge, by ` +
        `.github/workflows/allocate-version.yml — a PR that carries one is invalidated by any ` +
        `other merge that consumes it, silently and while still green. Revert the version line ` +
        `and describe the change under \`${PENDING_HEADING_EXAMPLE}\` in ${pkg.changelog} ` +
        `instead. The number is not yours to write; the words are.`,
    );
  }

  const headChangelog = readFileSync(pkg.changelog, "utf8");
  let headParsed;
  let pending;
  try {
    headParsed = parseChangelog(headChangelog, pkg.changelog);
    pending = pendingRelease(headChangelog, pkg.changelog);
  } catch (error) {
    failures.push(error.message);
    continue;
  }

  // 2 — an entry for every artifact this PR moves.
  const relevantFiles = touched.get(pkg.name) ?? [];
  if (relevantFiles.length > 0 && !pending?.body) {
    failures.push(
      `${pkg.name}: this PR changes ${relevantFiles.length} publish-relevant path(s) — ` +
        `${relevantFiles.slice(0, 4).join(", ")}${relevantFiles.length > 4 ? ", …" : ""} — so the ` +
        `next ${pkg.name} release carries them, and ${pkg.changelog} has no pending entry. ` +
        `Add one, above the newest released heading:\n` +
        `        ${PENDING_HEADING_EXAMPLE}\n` +
        `        <what a consumer of ${pkg.name} needs to know>\n` +
        `    \`(minor)\` if a consumer must act — a breaking change to this package's public ` +
        `surface, an \`engines\` floor, or for the CLI a change to the frozen twin contract — ` +
        `\`(patch)\` otherwise. The number is not yours to write; the words are.`,
    );
  }

  // 3 — insertions only. Compared as bytes against the base branch: a rewritten
  // released entry is a record that changed after the fact, and the released
  // region is the one part of this file nobody may touch.
  const baseChangelog = showAt(baseSha, pkg.changelog);
  if (baseChangelog !== null) {
    let baseReleased = null;
    try {
      baseReleased = parseChangelog(baseChangelog, pkg.changelog).released;
    } catch {
      // The BASE is malformed, which this PR cannot be blamed for and which the
      // parse of HEAD above already reports if the PR leaves it that way.
      baseReleased = null;
    }
    if (baseReleased !== null && baseReleased !== headParsed.released) {
      failures.push(
        `${pkg.name}: ${pkg.changelog}'s released entries are not byte-identical to the base ` +
          `branch's. A released entry records what shipped: entries are only ever inserted above ` +
          `it, never edited, and a correction is the next entry naming the one it corrects. ` +
          `(The preamble above the first heading is not covered by this, and neither is a pending ` +
          `\`## Unreleased\` section.)`,
      );
    }
  }

  // 4 — the surviving half of the old CHANGELOG contract.
  if (headParsed.releasedHeading !== null) {
    const declared = headParsed.releasedHeading.replace(/^##\s+/, "").split(/\s/)[0];
    if (declared !== headVersion) {
      failures.push(
        `${pkg.name}: ${pkg.manifest} declares ${headVersion} but ${pkg.changelog}'s newest ` +
          `released heading is \`${headParsed.releasedHeading}\`. Those two are written in one ` +
          `commit by .github/workflows/allocate-version.yml, so a disagreement means one of them ` +
          `was edited by hand.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Release inputs missing or hand-written:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

// The counts are printed because a gate that only ever says "OK" cannot be told
// apart from one whose subject has gone empty — the same reason
// release-alarm.mjs carries a --targets dead-guard.
const exempt = changedFiles.filter((file) => isPublishIrrelevantPath(file)).length;
console.log(
  `Release inputs OK. ${PUBLISHED_PACKAGES.length} published package(s); ` +
    `${changedFiles.length} file(s) changed, ${exempt} exempt from publish relevance; ` +
    `${touched.size} package(s) moved by this PR` +
    `${touched.size ? `: ${[...touched.keys()].join(", ")}` : ""}.`,
);
