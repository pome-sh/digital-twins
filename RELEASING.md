# Releasing

Four packages are published to **npm**: `@pome-sh/cli` and
`@pome-sh/adapter-claude-sdk` for end users, `@pome-sh/checks` — the grading
vocabulary — for the cloud grader in `pome-sh/pome-cloud`, and `@pome-sh/wire`
for pome-cloud's migration off `@pome-sh/shared-types`. `@pome-sh/wire` is ALSO
published to **GitHub Packages**, independently, from the same version line —
it is the only package on two registries. Everything else in this repo
(`@pome-sh/sdk`, the five `@pome-sh/twin-*`) is `private: true` and bundled
into those tarballs by tsup — it is never installed from a registry, so it
never needs its own release.

`@pome-sh/checks` is the one whose *staleness* is a product bug rather than a
missed feature: pome-cloud grades every `[code]` criterion out of it, so an
unpublished correction means a frozen grading engine (F-1308). See
[`packages/README.md`](packages/README.md#pome-shchecks--the-grading-vocabulary-as-its-own-artifact)
for why it is a separate package instead of un-privatising the twins.

`@pome-sh/wire` is the odd one out and worth reading the section on before
touching it: it is published to two registries AND still bundled. Publishing
it did not change how the CLI or the adapter consume it.

## The model

[`.github/workflows/release.yml`](.github/workflows/release.yml) is
version-diff driven, on every push to `main`:

1. Bump the version in the package's own `package.json` —
   `cli/package.json` for the CLI,
   `packages/adapter-claude-sdk/package.json` for the adapter,
   `packages/checks/package.json` for the grading vocabulary,
   `packages/wire/package.json` for wire — and add the entry to that
   package's own `CHANGELOG.md`.
2. Merge the PR to `main`.
3. `release.yml`'s `plan` job compares each package's local version against
   what's currently on its registry. A package whose version is unchanged is
   skipped. A package whose version differs publishes. A package whose version
   is *behind* the registry's published `latest` is a hard failure, not a skip
   — that would retag `latest` backwards for every existing consumer. A package
   the registry has never seen (404) baselines at `0.0.0` and publishes; an
   auth or network error is NOT treated as "unpublished", because that would
   bypass the floor check.

That's the whole runbook. There is no changeset file to add, no version PR
to wait on, and no batch release to sequence — the previous flow (Changesets
+ a manual "publish the `@pome-sh/*` batch first" gate, documented in the
now-deleted `PACKAGE_RELEASE.md`) produced 16 batch releases in 14 days, four
of them consecutive failures, before this repo collapsed to one CLI and one
adapter as the only publishable surfaces.

## The four packages version independently

`@pome-sh/cli`, `@pome-sh/adapter-claude-sdk`, `@pome-sh/checks` and
`@pome-sh/wire` are on their own version lines (D11) and are diff-gated
separately in the same workflow run — the CLI bundles the internal packages, the
adapter bundles `@pome-sh/wire`, `@pome-sh/checks` bundles the twins' declaration
layer, and none depends on another's published version. There is no lockstep to
enforce and no sync-versions script.

Independent version *lines* is not the same as independent *bumps*, and the one
coupling worth knowing up front: because wire's compiled output is inlined into
both npm tarballs, a change under `packages/wire/` is publish-relevant for all
three, so it needs all three bumped. Anything else — a CLI-only change, an
adapter-only change — bumps only its own package. See "Before you merge".

All four packages are pre-1.0, so npm's `^0.x` caret semantics apply
(`^0.N.x` never crosses into `0.N+1`) — **minor plays the major role**:

- **Minor (`0.N+1.0`)** — anything a consumer must act on: a breaking change
  to the package's public API or CLI surface, an `engines` floor bump, or (for
  the CLI) a change to the frozen twin runtime contract (`CONTRACT.md`).
- **Patch (`0.N.x`)** — everything else: additive exports/flags, internal
  implementation swaps behind an unchanged surface, dependency bumps, bug
  fixes.

## `@pome-sh/wire` — published to TWO registries, and still bundled

`@pome-sh/wire` is a published artifact on two registries with two different
audiences, and it did not stop being a bundled one (F-949, extended to add the
public-npm target for pome-cloud's `@pome-sh/shared-types` migration).

|  | `@pome-sh/cli`, `@pome-sh/adapter-claude-sdk`, `@pome-sh/checks` | `@pome-sh/wire` on npmjs | `@pome-sh/wire` on GitHub Packages |
| --- | --- | --- | --- |
| Registry | `registry.npmjs.org` | `registry.npmjs.org` | `npm.pkg.github.com` (GitHub Packages) |
| Audience | end users — `npx @pome-sh/cli`, `npm i @pome-sh/adapter-claude-sdk`, `npm i @pome-sh/checks` | `pome-sh/pome-cloud`, whose other `@pome-sh/*` deps (sdk, twin-*) only resolve from npmjs | `pome-sh/pome-cloud`'s original target, still supported |
| Auth | npm OIDC Trusted Publishing (`id-token: write`, provenance attestation, no stored token) | same OIDC mechanism, same `publish` job | `GITHUB_TOKEN` + `packages: write`, via an `.npmrc` auth line |
| Jobs | `plan` → `publish` (a matrix, wire is the fourth entry) | `plan` → `publish` | `plan-wire` → `publish-wire` |
| Reachable without auth | yes | yes | no — GitHub Packages requires a token even to read |

wire's `publishConfig.registry` in `packages/wire/package.json` still names
GitHub Packages — that is its *default*, and `ci.yml`'s `gate:wire-manifest`
asserts it on every PR — so the npmjs-lane `publish` job overrides it with an
explicit `--registry https://registry.npmjs.org` flag for wire only. See the
comment on that step in `release.yml`.

**Publishing wire changed nothing about how this repo consumes it.** `cli/` and
`packages/adapter-claude-sdk/` still declare it as a **devDependency** at `"*"`
(workspace-resolved), and tsup's `noExternal: [/^@pome-sh\//]` still inlines
its compiled output into both tarballs. Neither published npmjs tarball has an
`@pome-sh/*` dependency, and `scripts/clean-room-pack-test.mjs` fails if that
ever changes. Nobody installing the CLI or the adapter fetches wire from either
registry. Do not "simplify" this by turning wire into a real dependency of
either: that would put a registry-resolved package in an end user's install
graph for no reason tsup doesn't already solve.

Why wire went to GitHub Packages first, and why npmjs got added rather than
replacing it: wire is trace-vocabulary infrastructure (Zod schemas, the OTel
span extension, secret redaction) with no stable public API promise, and
GitHub Packages kept it out of the public npm namespace where it would look
like a supported end-user library. That reasoning still holds — nothing about
wire's confidentiality or audit status changed — but a single `@pome-sh` scope
can only resolve from one registry per *consumer*, and pome-cloud's other
`@pome-sh/*` dependencies (sdk, twin-*) exist only on public npmjs. Routing
wire through GitHub Packages for that consumer would require an `.npmrc`
change pome-cloud cannot make without breaking those other installs, so wire
now publishes to both, independently, from the same version line.

`@pome-sh/wire` publishes as `@pome-sh/…` on GitHub Packages because that
registry scopes npm packages to the account that owns the linked repository —
the scope must equal the org name, and `@pome-sh` matches the `pome-sh` org.
The package is linked to this repository through the `repository` field
already in `packages/wire/package.json`, which must keep naming the repo's
**canonical** path (`pome-sh/digital-twins`; `pome-sh/pome-twins` is an old
name GitHub redirects, and some local git remotes still use it).

### One-time manual bootstrap for wire's npmjs target

npm's OIDC Trusted Publishing cannot be configured for a package that has never
been published — the Trusted Publisher settings live on the package's own
npmjs.com page, and that page does not exist until a first version lands on the
registry. `@pome-sh/wire` has never been on `registry.npmjs.org` (only on
GitHub Packages), so the FIRST run of the `publish` job's OIDC-based `npm
publish -w @pome-sh/wire --registry https://registry.npmjs.org` step **will
fail** — this is npm's documented bootstrap limitation, not a bug in this
workflow. A maintainer must, once:

1. Publish the initial npmjs version out of band — a local `npm publish -w
   @pome-sh/wire --access public --registry https://registry.npmjs.org` from a
   clean build, authenticated with a classic token or `npm login` as someone
   with publish rights on the `@pome-sh` org.
2. On npmjs.com, under the now-existing `@pome-sh/wire` package's *Settings →
   Trusted Publisher*, add this repository (`pome-sh/digital-twins`), the
   workflow file (`.github/workflows/release.yml`), and the `publish` job —
   the same way `@pome-sh/cli`, `@pome-sh/adapter-claude-sdk` and
   `@pome-sh/checks` are already configured there.

Until step 2 is done, every subsequent version bump's `publish` run for
`@pome-sh/wire` on the npmjs lane fails the same way. This is a one-time
bootstrap, not a per-release step, and it does not affect
`publish-wire`/GitHub Packages, which has its own token-based auth and needs
no npmjs configuration.

The npmjs and GitHub Packages lanes are deliberately independent — `plan`/
`publish` never reads GitHub Packages and `plan-wire`/`publish-wire` never
reads npmjs — so an outage or a permissions change on one registry cannot skip
the other's publishes. That matters because a GitHub Packages read failure is
a *hard* failure by design (a 401 must never be read as "unpublished", which
would bypass the floor check); without the independence it would otherwise be
an outage on one registry silently blocking releases on the other.

### One-time manual step for a maintainer (GitHub Packages)

GitHub Packages' npm registry supports granular permissions, so a package's
visibility is settable independently of its linked repository — **but only once
the package exists**, and only by someone with admin on the package. This
repository is public, so the first publish produces a package whose access is
inherited from a public repository. Making it genuinely private is a manual,
post-first-publish step for an org owner at
`github.com/orgs/pome-sh/packages/npm/wire/settings`:

1. **First**, under *Manage Actions access*, add `pome-sh/digital-twins` with
   the **Write** role.
2. **Then** turn off *Inherit access from repository* and set visibility to
   **Private**.
3. Grant the `pome-cloud` consumers read.

> **Do step 1 before step 2.** Disabling inheritance clears the package's
> Actions-access list, which is where this repository's `GITHUB_TOKEN` gets its
> permission. Skip it and `plan-wire`'s read answers 401 — a hard failure by
> design, because a 401 must never be mistaken for "unpublished" — so every
> subsequent wire release is red until someone re-grants it in the UI. Nothing
> in the code can detect or repair this; it is a settings change with no commit
> attached. (The `plan`/`publish` lane for the two npm packages is deliberately
> independent, so this cannot stop the CLI or the adapter from publishing — see
> the job comments in `release.yml`.)

Until that is done, treat wire's contents as public. Nothing secret may ever go
into it — which is true regardless: wire is types and redaction logic, no
credentials, no domain data, no control-plane contract (that lives in
`cli/src/contract/`).

## `@pome-sh/checks` — versioning a vocabulary

A grading vocabulary breaks differently from a library. A renamed or removed
check id does not fail anyone's build: it stops *binding*, the criterion scores
nothing, and the run still reports a number. Treat every check id, template and
polarity as public surface.

- **Minor (`0.N+1.0`)** — a check id renamed or removed, a template reworded so
  its generated pattern changes, a polarity flipped, a seed schema tightened.
- **Patch (`0.N.x`)** — a check added, an export added, wording that leaves the
  pattern identical, internals.

**A change to a declaration file needs TWO bumps** — `@pome-sh/checks` and the
CLI (which bundles the same twin sources). The gate names both; the publish-
relevant paths for `@pome-sh/checks` are the declaration files specifically
(`packages/twin-*/src/{checks,check-*,seed,tape-assertable-tools}.ts`,
`packages/sdk/src/{checks,check-state-path,check-discrimination,failure-injection}.ts`),
not the whole of `packages/twin-*/`, so a twin's route or tool change does not
demand a vocabulary release it would not appear in.

**There is no drift gate, and that is the design** — F-1308's checklist asks for
one or for the reason there isn't. There is no second copy of any declaration to
drift: `packages/checks/src/*.ts` contains only `export … from` lines, and the
bytes come from the twin at build time. The failure a drift gate would catch
cannot be expressed here. What *can* still drift is the twin LIST (five explicit
export blocks), so
[`scripts/check-first-party-twin-registration.mjs`](scripts/check-first-party-twin-registration.mjs)
compares `CHECKS_TWIN_NAMES` against `config/first-party-twins.json`, and
`packages/checks/test/surface.test.ts` asserts every twin's vocabulary is
non-empty and every default seed parses under its own schema.

## Before you merge

A PR that touches a package's publish-relevant paths without bumping that
package's version fails CI —
[`scripts/ci/check-version-bump-required.mjs`](scripts/ci/check-version-bump-required.mjs)
is the gate. If your change doesn't warrant a release (docs, tests, CI-only),
it shouldn't be touching a publish-relevant path in the first place; if it
does, bump the version in the same PR rather than in a follow-up.

**A change under `packages/wire/` requires THREE bumps** — wire's own version,
the CLI's, and the adapter's. That is not the gate double-counting: wire's bytes
are inlined into both npmjs tarballs, so a wire fix reaches an end user only via
a CLI or adapter release, and reaches pome-cloud only via a wire release. Three
artifacts change, so three versions move.

**Bumping wire's version also means re-running `npm run emit:trace-contract -w
@pome-sh/wire`** in the same commit. `packages/wire/trace-contract.json` embeds
wire's own `version`, so `check:trace-contract` (a required `ci.yml` gate) fails
on a bump until the file is regenerated. It is one line, but it is not optional.

## What CI runs before publish

The two npm tarballs are built and, before `npm publish`, go through the same
guardrails that run on every PR — the bundled-runtime-dependency gate
(`npm run gate:bundled-deps`) and a clean-room pack test (`npm run test:pack`)
that installs both tarballs with no access to this workspace, boots all five
twins from the CLI tarball, and typechecks a consumer against the adapter's
shipped declarations — plus an npm-registry hard-link tarball check (E415).
Publishing uses npm OIDC Trusted Publishing with provenance; no `NPM_TOKEN` is
stored for either package.

`@pome-sh/wire` runs its own build, typecheck, unit tests,
`check:trace-contract` (the shipped `trace-contract.json` embeds wire's version,
so this is what stops a tarball carrying a descriptor that disagrees with the
`package.json` beside it), and `npm run gate:wire-tarball`
([`scripts/ci/check-wire-tarball.mjs`](scripts/ci/check-wire-tarball.mjs)),
which packs wire and asserts:

- every `exports`/`main`/`types` target is physically in the tarball. Inside
  this workspace those resolve through npm's workspace symlink whether or not
  `files` ships them, so this failure is invisible here and lands as
  `ERR_PACKAGE_PATH_NOT_EXPORTED` in a cross-repo consumer's build;
- no hard links (E415) and no dangling `.map` files — the same rule
  `test:pack` enforces on the other two tarballs (F-943);
- `private` is exactly `false` and `publishConfig.registry` is GitHub Packages.

Those last two assertions also run **pre-merge**, on every PR, via
`npm run gate:wire-manifest` (the same script, `--manifest-only`, needing no
build and no network). They are the pair worth catching early: `npm publish -w`
on a `private: true` workspace prints a warning and **exits 0**, so that
regression would otherwise produce a green release that published nothing, and a
mistaken publish to public npm cannot be undone after 72 hours.

`gate:bundled-deps` and `test:pack` are deliberately NOT re-run in
`publish-wire`: they are assertions about the other two tarballs, and they
already gate every PR and both npmjs publishes.

The shared version-diff decision is
[`scripts/ci/decide-publish.sh`](scripts/ci/decide-publish.sh), covered by
[`scripts/ci/decide-publish.test.mjs`](scripts/ci/decide-publish.test.mjs) —
which mocks `npm` to assert, among other cases, that a GitHub Packages 401 is a
hard failure rather than a `0.0.0` baseline, and that the two lanes cannot block
each other.

## Twin container images

The five twin Docker images (published to GHCR for pome-cloud) are a separate
pipeline — [`.github/workflows/twin-image.yml`](.github/workflows/twin-image.yml)
— gated on `ci.yml` and `secret-scan.yml` passing for the same SHA, cosign-signed,
and SBOM-attested. They are not part of the npm release described above; see
`AGENTS.md` and `docs/runbooks/twin-release-and-promotion.md` in the private
`pome-sh/pome-cloud` repo for how a signed digest gets promoted into a hosted
snapshot.
