# Releasing

Five packages are published, all from
[`release.yml`](.github/workflows/release.yml):

| Package | Registry | Audience |
| --- | --- | --- |
| `@pome-sh/cli`, `@pome-sh/adapter-claude-sdk` | npmjs | end users |
| `@pome-sh/checks`, `@pome-sh/sandbox-domains` | npmjs | `pome-sh/pome-cloud`'s grader |
| `@pome-sh/wire` | npmjs **and** GitHub Packages, one version line | pome-cloud |

Everything else (`@pome-sh/sdk`, the five `@pome-sh/twin-*`) is `private: true`
and inlined into those tarballs by tsup, so it never needs a release.

## The procedure

1. In your PR, add an entry to the package's own `CHANGELOG.md`, above the
   newest released heading:

   ```markdown
   ## Unreleased (patch)

   **What a consumer of this package needs to know.** …
   ```

   Leave every `version` field alone —
   [`check-release-note-required.mjs`](scripts/ci/check-release-note-required.mjs)
   fails a PR that moves one.
2. Merge to `main`.
3. [`allocate-version.yml`](.github/workflows/allocate-version.yml) works out
   which packages the tip earned a release for, writes the numbers into the
   manifests, rewrites `## Unreleased (patch)` to `## 0.23.46 — 2026-08-14`, and
   pushes one commit to `main`.
4. `release.yml` compares each local version against its registry on that bump
   commit. Unchanged is skipped, different publishes, and *behind* the registry
   is a hard failure — as is an auth or network error.

The run on your own merge commit publishes nothing — the number does not exist
at that sha yet. Correct, not a missed release.

### Why the number is not yours to write

A number in a PR is a claim about `main` that goes stale silently: it
invalidates every other open PR that pinned it, and those stay green because
their CI ran before the merge.

Released entries are insertions only — the gate compares everything from the
newest released heading down against the base branch. Correct a released entry
with a **new** entry naming the one it corrects.

## Which packages owe an entry

A package is owed a number when `main`'s tip carries a pending `## Unreleased`
entry for it, or moved one of its **publish-relevant paths** —
see [`publish-relevance.mjs`](scripts/ci/publish-relevance.mjs).

| You changed | Entries owed |
| --- | --- |
| `packages/wire/**` | wire, cli, adapter — wire's bytes are inlined into both npmjs tarballs |
| a twin declaration file | checks, sandbox-domains, cli |
| a twin's routes, tools or domain | sandbox-domains, cli |
| `cli/**` only | cli |

## Patch or minor

All five are pre-1.0, so `^0.N.x` never crosses into `0.N+1` — **minor plays
the major role.** Minor is anything a consumer must act on: a break to the
public API or CLI surface, an `engines` floor bump, a change to the frozen twin
runtime contract (`CONTRACT.md`). Patch is everything else — additive exports
and flags, internal swaps behind an unchanged surface, dependency bumps, fixes.
`checks` reads differently: a renamed check id fails no build, it stops
*binding*, and the criterion silently scores nothing — every id, template and
polarity there is public surface, so touching one is a minor.

## Before you merge

`check-release-note-required.mjs` asserts four things about your PR, none about
a number: no hand-written `version`; an entry with a level for every artifact
the PR moves; released entries byte-identical to the base branch; the newest
released heading names the version its manifest declares. If your change doesn't
warrant a release — docs, tests, CI-only — it shouldn't touch a publish-relevant
path at all.

## The credential: `pome-ops-push`

`allocate-version.yml` pushes to a protected `main` with a token from the org's
`pome-ops-push` GitHub App (`app_id` 4582446), because `GITHUB_TOKEN` can be
neither a ruleset bypass actor nor a push that triggers workflows. Every layer
guarding `main` has to let the app through, and the workflow names whichever one
refused it. To recover a missed allocation, run `gh workflow run
allocate-version.yml --ref main` — never hand-write the version to unstick it.

## What CI runs before publish

Both npmjs tarballs go through `gate:bundled-deps` and `test:pack`, which
installs them outside this workspace and boots all five twins from the CLI
tarball; wire adds `check:trace-contract` and `gate:wire-tarball`. Publishing
uses npm OIDC Trusted Publishing, which matches on the live `owner/repo` and
workflow path — renaming either breaks it until every package's config is
re-pointed on npmjs.

The five twin Docker images (GHCR, for pome-cloud) are a separate pipeline in
[`twin-image.yml`](.github/workflows/twin-image.yml), gated on `ci.yml` and
`secret-scan.yml` passing for the same SHA. Nothing above applies to them.
