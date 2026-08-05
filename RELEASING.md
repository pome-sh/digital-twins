# Releasing

Two packages are published to npm: `@pome-sh/cli` and
`@pome-sh/adapter-claude-sdk`. Everything else in this repo (`@pome-sh/sdk`,
`@pome-sh/wire`, the five `@pome-sh/twin-*`) is `private: true` and bundled
into those two tarballs by tsup — it is never installed from the registry, so
it never needs its own release.

## The model

[`.github/workflows/release.yml`](.github/workflows/release.yml) is
version-diff driven, on every push to `main`:

1. Bump the version in the package's own `package.json` —
   `cli/package.json` for the CLI, `packages/adapter-claude-sdk/package.json`
   for the adapter — and add the user-facing entry to that package's own
   `CHANGELOG.md`.
2. Merge the PR to `main`.
3. `release.yml`'s `plan` job compares each package's local version against
   what's currently on npm. A package whose version is unchanged is skipped.
   A package whose version differs publishes. A package whose version is
   *behind* npm's published `latest` is a hard failure, not a skip — that
   would retag `latest` backwards for every existing user.

That's the whole runbook. There is no changeset file to add, no version PR
to wait on, and no batch release to sequence — the previous flow (Changesets
+ a manual "publish the `@pome-sh/*` batch first" gate, documented in the
now-deleted `PACKAGE_RELEASE.md`) produced 16 batch releases in 14 days, four
of them consecutive failures, before this repo collapsed to one CLI and one
adapter as the only publishable surfaces.

## The two packages version independently

`@pome-sh/cli` and `@pome-sh/adapter-claude-sdk` are on their own version
lines (D11) and are diff-gated separately in the same workflow run — the CLI
bundles the internal packages, the adapter bundles `@pome-sh/wire`, and
neither depends on the other's published version. There is no lockstep to
enforce, so there is no sync-versions script: bump one, both, or neither,
depending on what actually changed.

Both packages are pre-1.0, so npm's `^0.x` caret semantics apply
(`^0.N.x` never crosses into `0.N+1`) — **minor plays the major role**:

- **Minor (`0.N+1.0`)** — anything a consumer must act on: a breaking change
  to the package's public API or CLI surface, an `engines` floor bump, or (for
  the CLI) a change to the frozen twin runtime contract (`CONTRACT.md`).
- **Patch (`0.N.x`)** — everything else: additive exports/flags, internal
  implementation swaps behind an unchanged surface, dependency bumps, bug
  fixes.

## Before you merge

A PR that touches a package's publish-relevant paths without bumping that
package's version fails CI —
[`scripts/ci/check-version-bump-required.mjs`](scripts/ci/check-version-bump-required.mjs)
is the gate. If your change doesn't warrant a release (docs, tests, CI-only),
it shouldn't be touching a publish-relevant path in the first place; if it
does, bump the version in the same PR rather than in a follow-up.

## What CI runs before publish

Both tarballs are built and, before `npm publish`, go through the same
guardrails that run on every PR — the bundled-runtime-dependency gate
(`npm run gate:bundled-deps`) and a clean-room pack test (`npm run test:pack`)
that installs both tarballs with no access to this workspace, boots all five
twins from the CLI tarball, and typechecks a consumer against the adapter's
shipped declarations — plus an npm-registry hard-link tarball check (E415).
Publishing uses npm OIDC Trusted Publishing with provenance; no `NPM_TOKEN` is
stored for either package.

## Twin container images

The five twin Docker images (published to GHCR for pome-cloud) are a separate
pipeline — [`.github/workflows/twin-image.yml`](.github/workflows/twin-image.yml)
— gated on `ci.yml` and `secret-scan.yml` passing for the same SHA, cosign-signed,
and SBOM-attested. They are not part of the npm release described above; see
`AGENTS.md` and `docs/runbooks/twin-release-and-promotion.md` in the private
`pome-sh/pome-cloud` repo for how a signed digest gets promoted into a hosted
snapshot.
