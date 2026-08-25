#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Which published artifacts does a set of changed files move?
//
// One answer, two callers. `allocate-release-versions.mjs` asks it on main to
// decide which packages get a NUMBER; `check-release-note-required.mjs` asks it
// on a PR to decide which packages need an `## Unreleased (level)` ENTRY. Both
// import this file rather than each keeping a copy, because two hand-maintained
// "which paths matter for which package" tables would disagree about whether a
// release was owed at all while both still looked like they were watching.
//
// Exports a table and pure predicates only; no I/O, no git, no CLI.

/**
  * A test file cannot change one byte of any tarball this table guards: no
  * package's `files` array names a test directory, tsup builds from `src/`, and
  * no `src/` module imports out of one.
  *
  * `examples/`, `assets/` and `tasks/` are carved back IN because the CLI's
  * `files` array publishes them verbatim, so a `*.test.ts` inside one really
  * does ship.
 */
function isUnpublishableTestPath(file) {
  if (/(^|\/)(examples|assets|tasks)\//.test(file)) return false;
  return /(^|\/)tests?\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file);
}

/**
  * A twin's own top-level examples/ ships in no tarball. The load-bearing
  * reason is `private: true`, not any `files` array — some twins' `files` do
  * name it. release.yml publishes cli, adapter-claude-sdk, checks, wire and
  * sandbox-domains, and no twin is any of those. Nothing asserts a twin stays
  * private, so unprivating one means re-checking this.
  *
  * `[^/]+` is deliberately one path segment, so only a twin's TOP-LEVEL
  * examples/ is exempt: `packages/twin-stripe/src/examples/handler.ts` compiles
  * into that twin's dist like any other `src/` module and stays relevant.
 */
function isTwinExamplePath(file) {
  return /^packages\/twin-[^/]+\/examples\//.test(file);
}

/**
  * A twin's own top-level markdown ships in no tarball either, for the same
  * reason: every twin is `private: true`, so its `files` array describes a
  * tarball nobody builds. tsup inlines twin source through each twin's
  * `exports` map and cannot inline a markdown file.
  *
  * `[^/]+\/[^/]+\.md` is two single path segments on purpose: this exempts
  * `packages/twin-github/FIDELITY.md` and NOT `packages/twin-github/src/x.md`
  * or any nested docs directory, so it cannot widen to cover something the
 * bundler might actually read.
 */
function isTwinTopLevelDocPath(file) {
  return /^packages\/twin-[^/]+\/[^/]+\.md$/.test(file);
}

/**
 * A twin's own top-level `scripts/` is dev/CI tooling, run via tsx on the `.ts`
 * source. It ships in no tarball, and — as with the two carve-outs above — the
 * load-bearing fact is `private: true`: release.yml
 * publishes cli, adapter-claude-sdk, checks, wire and sandbox-domains, and no twin
 * is any of those. That is deliberately the ONLY reason claimed here, because the tempting
 * second one is false for four of the five twins: only
 * `packages/twin-github/tsconfig.build.json` names `scripts` in its `exclude`,
 * and `packages/twin-slack/dist/scripts/` and `packages/twin-stripe/dist/scripts/`
 * really do exist inside the `dist` those packages' `files` arrays name. A
 * `files` array on a package nothing publishes describes a tarball nobody
 * builds. If a twin were ever unprivated, this exemption needs re-checking.
 *
 * The CLI's and `@pome-sh/sandbox-domains`' tarballs are the other artifacts that
 * could carry these bytes, and do not: tsup inlines twin source reached from
 * each twin's package `exports`, which resolve into `src/` only, and nothing
 * under `cli/src/`, `packages/sandbox-domains/src/` or any twin's own `src/`
 * imports a twin script — so tsup never sees these files.
 *
 *
 * `[^/]+` is deliberately one path segment and `scripts` is anchored directly
 * under the twin root, so `packages/twin-stripe/src/scripts/x.ts` — which
 * compiles into that twin's dist like any other `src/` module — is NOT exempt.
 */
function isTwinScriptPath(file) {
  return /^packages\/twin-[^/]+\/scripts\//.test(file);
}

/**
  * A twin's `Dockerfile` is the recipe for its GHCR image, which is not an npm
  * artifact: release.yml publishes tarballs, twin-image.yml publishes images,
  * and no version number spans the two. It ships in no tarball for the same
  * reason as the carve-outs above — every twin is `private: true` — and here no
  * twin's `files` array names a Dockerfile either.
 *
 *
 * The filename is matched EXACTLY and anchored directly under the twin root, so
 * a Dockerfile somewhere a bundler could plausibly reach —
 * `packages/twin-stripe/src/Dockerfile` — is NOT exempt.
 */
function isTwinDockerfilePath(file) {
  return /^packages\/twin-[^/]+\/Dockerfile$/.test(file);
}

/**
  * A `CHANGELOG.md` is exempt even though these bytes really do ship. The
  * exemption is about what a release MEANS, and it has two halves.
  *
  * The judgement: a release exists to move code to a consumer, and republishing
  * four tarballs over a typo in a historical entry spends a version number on
  * nothing anyone installs. When a changelog edit does accompany a release, the
  * release was earned by the code beside it, or by an `## Unreleased` entry the
  * allocator reads as a release request in its own right.
  *
  * The structural half, and why this is not merely a preference: the allocator's
  * own bump commit REWRITES these files. If a CHANGELOG.md were
  * publish-relevant, that commit would be publish-relevant for the package it
  * just released, and the allocator would allocate again on the next push, and
  * again. The primary loop guard is elsewhere and does not depend on this line,
  * so this is a second, independent reason the loop cannot start — the same
 * release.yml.
 */
function isChangelogPath(file) {
  return /(^|\/)CHANGELOG\.md$/.test(file);
}

/**
 * The union of every reason a changed file cannot move a published artifact.
 * Exported for the two callers' error messages, which name the exemption that
 * dropped a file rather than silently reporting "nothing to do".
 */
export function isPublishIrrelevantPath(file) {
  if (isUnpublishableTestPath(file)) return "a test path (in no package's `files`, imported by no `src/`)";
  if (isTwinExamplePath(file)) return "a twin's top-level examples/ (every twin is `private: true`)";
  if (isTwinTopLevelDocPath(file)) return "a twin's top-level docs (every twin is `private: true`)";
  if (isTwinScriptPath(file)) return "a twin's top-level scripts/ (dev tooling, in no tarball)";
  if (isTwinDockerfilePath(file)) return "a twin's Dockerfile (a GHCR image recipe, in no tarball)";
  if (isChangelogPath(file)) return "a CHANGELOG.md (the entry, not the artifact — see publish-relevance.mjs)";
  return null;
}

/**
 * The five packages `release.yml` can publish, and what changes each one's
 * bytes. `changelog` is where that package's release note lives, and
 * `versionedArtifacts` names committed files that embed the package's own
 * version and are byte-compared by a CI gate, so the allocator cannot move a
 * version without moving them too.
 *
  * `release.yml` remains the authority on what actually publishes, and
  * `release-alarm.mjs` PARSES that file rather than trusting any list. If the
  * two disagree about the set of packages, the alarm's `--targets` dead-guard
  * says so out loud.
 */
export const PUBLISHED_PACKAGES = [
  {
    name: "@pome-sh/cli",
    manifest: "cli/package.json",
    changelog: "cli/CHANGELOG.md",
    registry: "npm",
    // Bundled: the twins + wire + sdk are inlined via tsup, so a change to
    // any of them is a change to the CLI's published artifact too.
    pathPrefixes: ["cli/", "packages/twin-", "packages/wire/", "packages/sdk/"],
  },
  {
    name: "@pome-sh/adapter-claude-sdk",
    manifest: "packages/adapter-claude-sdk/package.json",
    changelog: "packages/adapter-claude-sdk/CHANGELOG.md",
    registry: "npm",
    pathPrefixes: ["packages/adapter-claude-sdk/", "packages/wire/"],
  },
  {
    // The grading vocabulary, published to npmjs for pome-cloud.
    //
    // Its publish-relevant paths are the DECLARATION layer of six other
    // packages, because that is what tsup inlines into its tarball: each twin's
    // `check-*.ts` / `checks.ts` / `seed.ts`, and the sdk's `checks.ts` +
    // `check-state-path.ts` + `check-discrimination.ts` + `check-redaction.ts` +
    // `failure-injection.ts`.
    //
    // Deliberately NOT the whole of `packages/twin-*/` or `packages/sdk/`. A
        // change to a twin's routes, tools or domain alters no byte of this
        // tarball, and making it earn a release here would put a pointless version
        // on most twin PRs — after which the numbers stop meaning anything. The
        // cost of drawing it narrowly is that a declaration file added under a NEW
        // name outside these globs would not trigger it;
        // `packages/checks/test/surface.test.ts` and each twin's own
        // `checks-contract.test.ts` cover that.
    name: "@pome-sh/checks",
    manifest: "packages/checks/package.json",
    changelog: "packages/checks/CHANGELOG.md",
    registry: "npm",
    pathPrefixes: ["packages/checks/"],
    pathPatterns: [
      /^packages\/twin-[a-z]+\/src\/(checks|check-[a-z-]+|seed|tape-assertable-tools)\.ts$/,
      /^packages\/sdk\/src\/(checks|check-state-path|check-discrimination|check-redaction|failure-injection)\.ts$/,
      // The declaration bundler is shared with @pome-sh/sandbox-domains rather
            // than copied. It is what makes this tarball's `.d.ts` resolvable for a
            // consumer, so it is publish-relevant here.
      /^scripts\/bundle-declarations\.mjs$/,
    ],
  },
  {
    // The twin domain layer — the in-process runtime pome-cloud's
    // `lib/twin-state.ts` boots and a bound check reads.
    //
    // @pome-sh/checks ships the DECLARATIONS, this ships what they read. They
        // are the two legs of pome-cloud's `checks-package-drift.test.ts`, and both
        // must be cut from the SAME main commit: publishing a widened vocabulary
        // whose runtime could not follow is the wall this pairing removes.
        //
        // Its paths are WHOLE directories where the checks entry names files, and
        // that difference is not an oversight. A twin's routes, tools and domain
        // change no byte of the vocabulary tarball, but they are exactly what this
        // one bundles, so a domain change that did not republish this package is
        // the silent non-release this table exists to prevent.
    name: "@pome-sh/sandbox-domains",
    manifest: "packages/sandbox-domains/package.json",
    changelog: "packages/sandbox-domains/CHANGELOG.md",
    registry: "npm",
    pathPrefixes: [
      "packages/sandbox-domains/",
      "packages/twin-",
      // `./server` re-exports `toTwinHttpEventRow`, and every twin domain
      // reaches the sdk's db layer — the whole sdk is inlined here, exactly as
      // it is into the CLI.
      "packages/sdk/",
    ],
    pathPatterns: [/^scripts\/bundle-declarations\.mjs$/],
  },
  {
    // Published to BOTH registries from one version line, with its own
        // independent version line and therefore its own entry here.
        //
        // `packages/wire/` deliberately appears in THREE entries, and that is not
        // double-counting: three different published artifacts change when wire
        // changes. A wire source change alters the bytes tsup inlines into the
        // CLI's and the adapter's tarballs, so both need a release for a user to
        // see it, and wire itself needs one for its own consumers. Three releases
        // for one wire change is the correct answer. @pome-sh/checks is not the
        // fourth — see its entry above, where relevance is named files rather than
        // directories.
    name: "@pome-sh/wire",
    manifest: "packages/wire/package.json",
    changelog: "packages/wire/CHANGELOG.md",
    registry: "npm + GitHub Packages (npm.pkg.github.com)",
    pathPrefixes: ["packages/wire/"],
    // trace-contract.json is in wire's `files`, so it SHIPS, and it embeds
        // wire's own `version`. `check:trace-contract` is a byte compare, so a
        // version moved without regenerating it reds main. Keeping that pairing in
        // this table rather than in a human instruction is the point: the version
        // is no longer written by a human.
        //
        // `regenerate` runs the REAL emitter rather than patching the one key,
        // because that emitter also enumerates the event union out of zod and
        // asserts a fixture per kind — a hand-patch would keep the byte compare
        // green while silently dropping that assertion. It is why
        // allocate-version.yml has an `npm ci` at all, and it runs only when a
        // package in the plan names one.
    versionedArtifacts: ["packages/wire/trace-contract.json"],
    regenerate: "npm run emit:trace-contract -w @pome-sh/wire",
  },
];

/**
  * Which published packages a set of changed paths moves, with the paths that
  * made each one relevant — callers name those paths, so a demand is never
  * "something you touched" but "these files, and this is the artifact they are
  * inlined into".
  *
  * Returns `[{ pkg, files }]` in table order, only for packages with at least
  * one relevant file.
 */
export function packagesTouchedBy(changedFiles) {
  const relevant = changedFiles.filter((file) => !isPublishIrrelevantPath(file));
  const hits = [];
  for (const pkg of PUBLISHED_PACKAGES) {
    const files = relevant.filter(
      (file) =>
        pkg.pathPrefixes.some((prefix) => file.startsWith(prefix)) ||
        // `pathPatterns` exists for @pome-sh/checks, whose tarball is assembled
        // from named FILES inside other packages rather than whole directories —
        // a prefix would over-trigger on every twin route change.
        (pkg.pathPatterns ?? []).some((pattern) => pattern.test(file)),
    );
    if (files.length > 0) hits.push({ pkg, files });
  }
  return hits;
}
