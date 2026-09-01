#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Which published artifacts a set of changed files moves. Read by the allocator
// (which packages get a number) and the PR gate (which need an entry).
//
// Every regex here is one path segment wide on purpose; widening one republishes
// identical tarballs. The exemptions rest on `private: true`, not on `files`.

function isUnpublishableTestPath(file) {
  if (/(^|\/)(examples|assets|tasks)\//.test(file)) return false;
  return /(^|\/)tests?\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file);
}

function isTwinExamplePath(file) {
  return /^packages\/twin-[^/]+\/examples\//.test(file);
}

function isTwinTopLevelDocPath(file) {
  return /^packages\/twin-[^/]+\/[^/]+\.md$/.test(file);
}

function isTwinScriptPath(file) {
  return /^packages\/twin-[^/]+\/scripts\//.test(file);
}

function isTwinDockerfilePath(file) {
  return /^packages\/twin-[^/]+\/Dockerfile$/.test(file);
}

function isChangelogPath(file) {
  return /(^|\/)CHANGELOG\.md$/.test(file);
}

export function isPublishIrrelevantPath(file) {
  if (isUnpublishableTestPath(file)) return "a test path (in no package's `files`, imported by no `src/`)";
  if (isTwinExamplePath(file)) return "a twin's top-level examples/ (every twin is `private: true`)";
  if (isTwinTopLevelDocPath(file)) return "a twin's top-level docs (every twin is `private: true`)";
  if (isTwinScriptPath(file)) return "a twin's top-level scripts/ (dev tooling, in no tarball)";
  if (isTwinDockerfilePath(file)) return "a twin's Dockerfile (a GHCR image recipe, in no tarball)";
  if (isChangelogPath(file)) return "a CHANGELOG.md (the entry, not the artifact — see publish-relevance.mjs)";
  return null;
}

export const PUBLISHED_PACKAGES = [
  {
    name: "@pome-sh/cli",
    manifest: "cli/package.json",
    changelog: "cli/CHANGELOG.md",
    registry: "npm",
    pathPrefixes: ["cli/", "packages/twin-", "packages/wire/", "packages/sdk/"],
  },
  {
    name: "@pome-sh/checks",
    manifest: "packages/checks/package.json",
    changelog: "packages/checks/CHANGELOG.md",
    registry: "npm",
    pathPrefixes: ["packages/checks/"],
    pathPatterns: [
      /^packages\/twin-[a-z]+\/src\/(checks|check-[a-z-]+|seed|tape-assertable-tools)\.ts$/,
      /^packages\/sdk\/src\/(checks|check-state-path|check-discrimination|check-redaction|failure-injection)\.ts$/,
      /^scripts\/bundle-declarations\.mjs$/,
    ],
  },
  {
    name: "@pome-sh/sandbox-domains",
    manifest: "packages/sandbox-domains/package.json",
    changelog: "packages/sandbox-domains/CHANGELOG.md",
    registry: "npm",
    pathPrefixes: [
      "packages/sandbox-domains/",
      "packages/twin-",
      "packages/sdk/",
    ],
    pathPatterns: [/^scripts\/bundle-declarations\.mjs$/],
  },
  {
    name: "@pome-sh/wire",
    manifest: "packages/wire/package.json",
    changelog: "packages/wire/CHANGELOG.md",
    registry: "npm + GitHub Packages (npm.pkg.github.com)",
    pathPrefixes: ["packages/wire/"],
    versionedArtifacts: ["packages/wire/trace-contract.json"],
    regenerate: "npm run emit:trace-contract -w @pome-sh/wire",
  },
];

export function packagesTouchedBy(changedFiles) {
  const relevant = changedFiles.filter((file) => !isPublishIrrelevantPath(file));
  const hits = [];
  for (const pkg of PUBLISHED_PACKAGES) {
    const files = relevant.filter(
      (file) =>
        pkg.pathPrefixes.some((prefix) => file.startsWith(prefix)) ||
        (pkg.pathPatterns ?? []).some((pattern) => pattern.test(file)),
    );
    if (files.length > 0) hits.push({ pkg, files });
  }
  return hits;
}
