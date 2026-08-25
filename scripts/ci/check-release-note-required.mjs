#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The PR-time half of the release contract: no hand-written version, an
// `## Unreleased (level)` entry per artifact the PR moves, released entries never
// rewritten, and each newest released heading still naming its manifest version.
//
// The base must come from the checked-out history, not `pull_request.base.sha`,
// which is pinned at the last synchronize. For a STACKED PR the base is its base
// branch — checking against main gives a false green.

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

  const baseChangelog = showAt(baseSha, pkg.changelog);
  if (baseChangelog !== null) {
    let baseReleased = null;
    try {
      baseReleased = parseChangelog(baseChangelog, pkg.changelog).released;
    } catch {
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

const exempt = changedFiles.filter((file) => isPublishIrrelevantPath(file)).length;
console.log(
  `Release inputs OK. ${PUBLISHED_PACKAGES.length} published package(s); ` +
    `${changedFiles.length} file(s) changed, ${exempt} exempt from publish relevance; ` +
    `${touched.size} package(s) moved by this PR` +
    `${touched.size ? `: ${[...touched.keys()].join(", ")}` : ""}.`,
);
