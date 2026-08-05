#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// release.yml publishes on version-diff: if a package's local package.json
// version differs from what's on npm, it publishes; if not, it silently skips.
// That silence is the bug (Greptile, PR #312 review) — a PR that changes the
// CLI's source, its bundled twins, or the adapter's source without bumping
// the corresponding package.json version merges clean, passes every other
// check, and the change never reaches npm. There is no second signal; the
// only way to know is to notice a user isn't seeing the fix.
//
// This replaces that silence with a PR-time failure: if a PR touches a
// package's publish-relevant paths, its package.json version must differ
// from the base branch's version. Runs as one of ci.yml's cheap,
// dependency-free gates (git diff two shas, no npm install needed).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const baseSha = process.argv[2];
if (!baseSha) {
  throw new Error("usage: check-version-bump-required.mjs <base-sha>");
}

const changedFiles = execFileSync("git", ["diff", "--name-only", baseSha, "HEAD"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

function versionAt(ref, manifestPath) {
  try {
    const text = execFileSync("git", ["show", `${ref}:${manifestPath}`], { encoding: "utf8" });
    return JSON.parse(text).version;
  } catch {
    // Manifest didn't exist at that ref (e.g. a brand-new package) — nothing
    // to compare against, so this package can't be "unbumped" relative to it.
    return null;
  }
}

const PACKAGES = [
  {
    name: "@pome-sh/cli",
    manifest: "cli/package.json",
    // Bundled: the twins + wire + sdk are inlined via tsup, so a change to
    // any of them is a change to the CLI's published artifact too.
    pathPrefixes: ["cli/", "packages/twin-", "packages/wire/", "packages/sdk/"],
  },
  {
    name: "@pome-sh/adapter-claude-sdk",
    manifest: "packages/adapter-claude-sdk/package.json",
    pathPrefixes: ["packages/adapter-claude-sdk/", "packages/wire/"],
  },
];

const failures = [];
for (const pkg of PACKAGES) {
  const touched = changedFiles.some((file) =>
    pkg.pathPrefixes.some((prefix) => file.startsWith(prefix)),
  );
  if (!touched) continue;

  const baseVersion = versionAt(baseSha, pkg.manifest);
  if (baseVersion === null) continue; // new package this PR — nothing to bump against

  const headVersion = JSON.parse(readFileSync(pkg.manifest, "utf8")).version;
  if (headVersion === baseVersion) {
    failures.push(
      `${pkg.name}: publish-relevant paths changed but ${pkg.manifest}'s version ` +
        `is still ${headVersion}. release.yml only publishes on a version diff — ` +
        `bump it, or this change never reaches npm.`,
    );
  }
}

if (failures.length > 0) {
  console.error("Version bump required:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("Version bump check OK (no publish-relevant path changed an unbumped package, or none touched).");
