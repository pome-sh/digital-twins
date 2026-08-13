#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1511 — WHICH PUBLISHED ARTIFACTS DOES A SET OF CHANGED FILES MOVE?
//
// One answer, two callers. This table used to live inside
// `check-version-bump-required.mjs`, where it powered a PR-time demand ("bump
// this version yourself"). The version number no longer leaves the pipeline's
// hands (RELEASING.md, "Why the number is not yours to write"), so the
// same question is now asked at two different moments:
//
//   - `allocate-release-versions.mjs`, on `main`, to decide which packages get
//     a NUMBER. This is the authority: a package whose publish-relevant paths
//     moved gets a release whether or not anyone wrote prose about it, because
//     the failure this whole apparatus exists to prevent is the silent
//     non-release.
//   - `check-release-note-required.mjs`, on a PR, to decide which packages need
//     an `## Unreleased (level)` ENTRY. The number is the pipeline's; the words
//     are still the author's.
//
// Both import this file rather than each carrying a copy: a second
// hand-maintained "which paths matter for which package" is the F-1135 shape —
// one goes stale while both still look like they are watching, and here the two
// copies would disagree about whether a release was owed at all.
//
// Exports a table and pure predicates only; no I/O, no git, no CLI.

/**
 * A test file cannot change one byte of any tarball this table guards: no
 * package's `files` array names a test directory, tsup builds from `src/`, and
 * no `src/` module imports out of one. Calling a test-only change
 * publish-relevant therefore asks for a release that republishes an identical
 * artifact — the same pointless-release noise the `@pome-sh/checks` entry below
 * argues a rule must not generate if it wants to keep being obeyed.
 *
 * `examples/`, `assets/` and `tasks/` are carved back IN because the CLI's
 * `files` array publishes them verbatim — a file named `*.test.ts` inside one
 * of those really does ship, so it really is publish-relevant.
 */
function isUnpublishableTestPath(file) {
  if (/(^|\/)(examples|assets|tasks)\//.test(file)) return false;
  return /(^|\/)tests?\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file);
}

/**
 * A twin's own top-level examples/ ships in no tarball — but not because of
 * its `files` array. Some twins' `files` DO name it: twin-github and
 * twin-slack's tsconfig.build.json compile `examples/**\/*.ts` into
 * `dist/examples/*.js` (rootDir "."), and `files: ["dist", ...]` names
 * `dist`. The actual load-bearing fact is `private: true` — release.yml
 * (F-1308, F-949) publishes only cli, adapter-claude-sdk, checks and wire, and
 * no twin is any of those. Nothing in this repo currently asserts a twin stays
 * private, so if one were ever unprivated this exemption would need
 * re-checking; today it holds for all five. The CLI's own `files` entry
 * "examples" is cli/examples (cli/tsconfig.json's `include`), a different
 * directory, not a twin's.
 *
 * `[^/]+` is deliberately one path segment, so only a twin's TOP-LEVEL
 * examples/ is exempt — `packages/twin-stripe/src/examples/handler.ts`
 * does not match, because that file compiles into the twin's `dist` same as
 * any other `src/` module and is publish-relevant if the CLI bundle imports
 * it.
 *
 * F-1455, reproduced by PR #366 (F-1453): a PR touching only
 * packages/twin-stripe/examples/buyer-agent/ was told to bump @pome-sh/cli
 * for a republish that would be byte-identical.
 */
function isTwinExamplePath(file) {
  return /^packages\/twin-[^/]+\/examples\//.test(file);
}

/**
 * A twin's own TOP-LEVEL markdown ships in no tarball either, for exactly the
 * reason above: every `packages/twin-*` package is `private: true`, and
 * release.yml publishes only cli, adapter-claude-sdk, checks and wire. Their
 * `files` arrays do name `README.md` / `FIDELITY.md` / `LIMITS.md`, and that is
 * as inert as the `dist/examples` case — a `files` array on a package nothing
 * publishes describes a tarball nobody builds. The CLI's tarball inlines twin
 * SOURCE through tsup, and tsup cannot inline a markdown file.
 *
 * Same shape of over-match as F-1455, one directory over: `packages/twin-` is a
 * plain prefix, so documentation that cannot change one byte of any published
 * artifact was demanding a `@pome-sh/cli` release — i.e. a republish that would
 * be byte-identical. RELEASING.md's advice ("if your change doesn't warrant a
 * release it shouldn't be touching a publish-relevant path") has no answer here:
 * a twin's FIDELITY.md has nowhere else to live.
 *
 * Found on the docs-only PR that added the FIDELITY.md bullets pome-cloud's
 * `lint-known-divergences.ts` binds its registry entries to 1:1.
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
 * load-bearing fact is `private: true`: release.yml (F-1308, F-949) publishes
 * only cli, adapter-claude-sdk, checks and wire, and no twin is any of those.
 * That is deliberately the ONLY reason claimed here, because the tempting
 * second one is false for four of the five twins: only
 * `packages/twin-github/tsconfig.build.json` names `scripts` in its `exclude`,
 * and `packages/twin-slack/dist/scripts/` and `packages/twin-stripe/dist/scripts/`
 * really do exist inside the `dist` those packages' `files` arrays name. A
 * `files` array on a package nothing publishes describes a tarball nobody
 * builds. If a twin were ever unprivated, this exemption needs re-checking.
 *
 * The CLI's tarball is the other artifact that could carry these bytes, and does
 * not: tsup inlines twin source reached from each twin's package `exports`,
 * which resolve into `src/` only, and nothing under `cli/src/` or any twin's own
 * `src/` imports a twin script — so tsup never sees these files.
 *
 * Third instance of the F-1455 over-match, one directory over from the
 * `examples/` and top-level-`.md` carve-outs above: `packages/twin-` is a plain
 * prefix, so editing a validator that CI runs was demanding an `@pome-sh/cli`
 * release — a republish that would be byte-identical. Found on F-1354, which had
 * to touch `packages/twin-github/scripts/validate-mcp.ts` to wire that script
 * into CI at all, and RELEASING.md's "if your change doesn't warrant a release
 * it shouldn't be touching a publish-relevant path" has no answer: a twin's own
 * validator has nowhere else to live.
 *
 * `[^/]+` is deliberately one path segment and `scripts` is anchored directly
 * under the twin root, so `packages/twin-stripe/src/scripts/x.ts` — which
 * compiles into that twin's dist like any other `src/` module — is NOT exempt.
 */
function isTwinScriptPath(file) {
  return /^packages\/twin-[^/]+\/scripts\//.test(file);
}

/**
 * F-1511 — a `CHANGELOG.md` is exempt, and this one is NOT the F-1455 shape:
 * these bytes really do ship (`packages/checks/package.json` and
 * `packages/twin-linear/package.json` name `CHANGELOG.md` in `files`, and npm
 * packs a root CHANGELOG.md whether or not `files` asks it to). The exemption is
 * about what a release MEANS, and it has two halves.
 *
 * The half that is a judgement: a release exists to move code to a consumer.
 * Republishing four tarballs because someone fixed a typo in a historical entry
 * spends a version number on nothing anyone installs — the same "gate that
 * generates noise stops being read" argument as the carve-outs above, one file
 * over. When a changelog edit DOES accompany a release, the release was earned
 * by the code beside it, or by an `## Unreleased` entry that
 * `allocate-release-versions.mjs` reads as a release request in its own right —
 * so nothing that should publish stops publishing because of this line.
 *
 * The half that is structural, and the reason this is not merely a preference:
 * the allocator's own bump commit REWRITES these files (an `## Unreleased`
 * heading becomes `## 0.23.46 — 2026-08-14`). If a CHANGELOG.md were
 * publish-relevant, that commit would be publish-relevant for the package it
 * just released, and the allocator would allocate again on the next push, and
 * again. The primary loop guard is elsewhere and does not depend on this line
 * (the allocator measures relevance from the last commit that moved the version,
 * which is that very bump commit — see its header), so this is the second,
 * independent reason the loop cannot start. Two independent guarantees, the same
 * shape as wire's two "this cannot land on the wrong registry" guards in
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
  if (isChangelogPath(file)) return "a CHANGELOG.md (the entry, not the artifact — see publish-relevance.mjs)";
  return null;
}

/**
 * The four packages `release.yml` can publish, and what changes each one's
 * bytes. `changelog` is where that package's release note lives, and
 * `versionedArtifacts` names committed files that embed the package's own
 * version and are byte-compared by a CI gate, so the allocator cannot move a
 * version without moving them too.
 *
 * `release.yml` remains the authority on what actually publishes — it is where
 * `decide-publish.sh` is called, and `release-alarm.mjs` PARSES that file
 * rather than trusting any list. If the two ever disagree about the set of
 * packages, the alarm's `--targets` dead-guard is what says so out loud.
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
    // The grading vocabulary, published to npmjs for pome-cloud (F-1308).
    //
    // Its publish-relevant paths are the DECLARATION layer of six other
    // packages, because that is what tsup inlines into its tarball: each twin's
    // `check-*.ts` / `checks.ts` / `seed.ts`, and the sdk's `checks.ts` +
    // `check-state-path.ts` + `check-discrimination.ts` + `check-redaction.ts` +
    // `failure-injection.ts`.
    //
    // Deliberately NOT the whole of `packages/twin-*/` or `packages/sdk/`. A
    // change to a twin's routes, tools or domain does not alter one byte of this
    // tarball, and making it earn a release here would put a pointless version
    // on most twin PRs — after which the numbers stop meaning anything, which is
    // how a release line stops being read at all. The cost of drawing it narrowly
    // is that a declaration file added under a NEW name outside these globs would
    // not trigger it; `packages/checks/test/surface.test.ts` plus each twin's own
    // `checks-contract.test.ts` are what cover that.
    name: "@pome-sh/checks",
    manifest: "packages/checks/package.json",
    changelog: "packages/checks/CHANGELOG.md",
    registry: "npm",
    pathPrefixes: ["packages/checks/"],
    pathPatterns: [
      /^packages\/twin-[a-z]+\/src\/(checks|check-[a-z-]+|seed|tape-assertable-tools)\.ts$/,
      /^packages\/sdk\/src\/(checks|check-state-path|check-discrimination|check-redaction|failure-injection)\.ts$/,
    ],
  },
  {
    // Published to BOTH registries from one version line (F-949): npmjs for
    // pome-cloud's migration off @pome-sh/shared-types, GitHub Packages for its
    // original cross-repo consumers. Its own independent version line and
    // therefore its own independent entry here.
    //
    // `packages/wire/` deliberately appears in THREE entries and that is not
    // double-counting — it is three different published artifacts that all
    // change when wire changes. A wire source change alters the bytes tsup
    // inlines into the CLI's and the adapter's tarballs, so both of those need
    // a release for a user to see it, AND wire itself needs one for pome-cloud
    // to see it. Three releases for one wire change is the correct answer, not a
    // bug; the wrong answer is the silent non-release this apparatus exists to
    // prevent. `@pome-sh/checks` is deliberately not the fourth — see its entry
    // above for why its relevance is named files rather than directories.
    name: "@pome-sh/wire",
    manifest: "packages/wire/package.json",
    changelog: "packages/wire/CHANGELOG.md",
    registry: "npm + GitHub Packages (npm.pkg.github.com)",
    pathPrefixes: ["packages/wire/"],
    // trace-contract.json is in wire's `files`, so it SHIPS, and it embeds
    // wire's own `version`. `check:trace-contract` (a required ci.yml gate) is a
    // byte compare, so a version moved without regenerating it reds `main` —
    // RELEASING.md has carried "bumping wire's version also means re-running
    // emit:trace-contract" as a human instruction since F-1201, and a human
    // instruction is exactly what stops being followed when the version stops
    // being written by a human.
    //
    // `regenerate` runs the REAL emitter rather than patching the one key,
    // because that emitter also enumerates the event union out of zod and
    // asserts a fixture per kind (F-1201) — a hand-patch would keep the byte
    // compare green while silently dropping that assertion. It is the reason
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
