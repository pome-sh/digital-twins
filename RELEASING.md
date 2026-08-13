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
version-diff driven, on every push to `main`. **You do not write the version
number** — F-1511 moved it out of PRs entirely (the decision record is the F-1511
ADR in the private `pome-sh/pome-cloud` docs; the operational half, including why
the rejected alternative was rejected, is below):

1. In the PR, add an entry to the package's own `CHANGELOG.md`, above the
   newest released heading:

   ```markdown
   ## Unreleased (patch)

   **What a consumer of this package needs to know.** …
   ```

   `(patch)` or `(minor)` — the judgement below under "minor plays the major
   role". That is the whole of what a PR carries. Leave every `version` field
   alone; [`scripts/ci/check-release-note-required.mjs`](scripts/ci/check-release-note-required.mjs)
   fails a PR that moves one.
2. Merge the PR to `main`.
3. [`.github/workflows/allocate-version.yml`](.github/workflows/allocate-version.yml)
   runs on that push, works out which packages the tip has earned a release for,
   writes the numbers into the manifests and rewrites `## Unreleased (patch)` to
   `## 0.23.46 — 2026-08-14`, and pushes one commit to `main`.
4. `release.yml`'s `plan` job — on the bump commit's own push — compares each
   package's local version against what's currently on its registry. A package
   whose version is unchanged is skipped. A package whose version differs
   publishes. A package whose version is *behind* the registry's published
   `latest` is a hard failure, not a skip — that would retag `latest` backwards
   for every existing consumer. A package the registry has never seen (404)
   baselines at `0.0.0` and publishes; an auth or network error is NOT treated
   as "unpublished", because that would bypass the floor check.

Step 4 is exactly what it always was. The run on your own merge commit publishes
nothing (the number does not exist at that sha yet), which is correct and not a
missed release.

That's the whole runbook. There is no changeset file to add, no version PR
to wait on, and no batch release to sequence — the previous flow (Changesets
+ a manual "publish the `@pome-sh/*` batch first" gate, documented in the
now-deleted `PACKAGE_RELEASE.md`) produced 16 batch releases in 14 days, four
of them consecutive failures, before this repo collapsed to one CLI and one
adapter as the only publishable surfaces. Moving *who writes the number* did not
bring any of that back: nothing batches and nothing waits.

### Why the number is not yours to write

Because a number in a PR is a claim about `main` that goes stale without saying
so. Every twins PR used to hand-write the shared version line, so **every merge
invalidated every open PR** that had pinned a number that merge consumed — and the
invalidation was silent: the stale PR stayed green, because its own CI had run
before the merge. It crossed workspaces and humans and got worse with
parallelism. Measured 2026-08-13: #402/#405 went stale-green overnight;
five renumber+force-push cycles in one batch night; 0.23.35 and 0.23.36 burned
without ever being published. CI wall-clock was measured *not* to be the cost
(`ci` ≈ 4 min); the cost was attention per cycle, plus a failure class nobody can
see. `strict_required_status_checks_policy` on `main` exists only to keep the
version gate's verdict fresh against a moving base — which is the treadmill
serving the number rather than the code.

**The alternative that was rejected**, recorded because it is the cheaper one and
someone will suggest it again: have PRs write a placeholder and let the merge
pipeline compute the real number at publish time from the registry's `latest`. It
needs no credential, no push to a protected branch and no race handling — and it
makes `release.yml`'s `plan` job vacuous. "Behind npm is a hard failure" and "a
never-seen package baselines at 0.0.0" are both statements about *the number
`main` declares* versus *what the registry serves*; derive the number from the
registry and behind-npm becomes structurally impossible, so the check can never
fire and still passes forever. `release-alarm.mjs`'s primary leg ("does each
registry serve the version `main` declares?") — the one that caught the
2026-08-06 eleven-hour silence — loses its subject at the same moment, and
`main`'s tree stops recording what shipped from which commit. Everything else
follows: any design where `main` records the number needs a write to `main`, and
any design where it does not changes plan-job semantics. Hence a commit.

This is **not** a return to changesets or batch releases. #239 killed batching and
release-PR waits; both stay dead. Nothing waits for a release PR, nothing
batches, and what moved is only *who writes the number*.

Four properties, and what holds each:

1. **The bump commit cannot re-trigger a publish loop.** Relevance is measured
   from the newest commit that *moved* a package's version — and the bump commit
   is one, so its own diff already sits inside the release it created, and the
   entry it consumed is gone. Structural, not a marker match. Two independent
   guards sit on top: a `CHANGELOG.md` is not a publish-relevant path, and
   `allocate-version.yml` skips a push whose head commit carries
   `[release-bump]`. Any one of the three suffices; none is load-bearing alone.
2. **Two PRs merging close together cannot double-allocate.** The unit of
   allocation is `main`'s tip, never the pushed range; the workflow serialises
   itself with a `concurrency` group and *recomputes* after a rejected push
   instead of retrying a stale write. Two merges inside one window get **one**
   number carrying both entries — the truth, not a lost release.
   `release.yml`'s per-ref concurrency already serialises the publish half.
3. **The heading↔number binding survives**, moved to where the number is now
   written: one script writes `"version": "0.23.46"` and
   `## 0.23.46 — 2026-08-14` in one commit, so they cannot drift instead of being
   re-asserted against two hand-written copies.
4. **Insertions only.** The writer reassembles a CHANGELOG as
   `preamble + newSection + releasedRegion`, so a released entry is carried
   across byte-for-byte by construction; the PR gate checks the same region
   against the base branch. Corrections are the next entry, never an edit.

### What a release is owed, and by whom

A package gets a number when **either** of these is true of `main`'s tip, and the
two halves are why both a gate and an allocator exist:

- it has a pending `## Unreleased (level)` entry — words are a release request in
  their own right; or
- a **publish-relevant path** of that package moved since the last commit that
  changed its version. That list lives in
  [`scripts/ci/publish-relevance.mjs`](scripts/ci/publish-relevance.mjs) and is
  read by both the PR gate and the allocator, so they cannot disagree.

The second half is the one that cannot be forgotten: a fix that merges clean and
reaches no consumer is the failure the version gate has always existed to
prevent, and it does not stop existing because nobody wrote a changelog line. A
package owed a release with no entry gets a patch and an entry saying so, naming
the commits.

### The credential: `pome-ops-push`, and the one-time setup around it

`allocate-version.yml` pushes to a protected `main`, so it needs a credential the
ambient `GITHUB_TOKEN` cannot be. It mints an installation token from the org's
**`pome-ops-push`** GitHub App (`app_id` 4582446, org installation 153466692,
Contents: RW) — the same app and the same pinned mint step pome-cloud uses in
`fidelity-watch.yml` and `declared-diff.yml` (its PR #730), so the two repos'
release paths cannot drift onto different versions of one mechanism.

Two independent reasons the ambient token cannot stand in:

- **`github-actions` can never be a ruleset bypass actor.** The UI and the API
  both refuse it, and deploy keys are disabled org-wide. An App installation can
  (`actor_type: Integration`), which is why this app exists. The rules it is
  bypassing are the live ones
  [`scripts/ci/assert-repo-policy.sh`](scripts/ci/assert-repo-policy.sh) asserts:
  a pull request with resolved threads, strict required status checks,
  non-fast-forward, and deletion. Classic branch protection sits underneath them
  and can refuse a push on its own, so that is the second layer to look at if
  the bypass alone is not enough — note it also forbids deletion
  (`allow_deletions: false`, `enforce_admins: true`), which the ruleset bypass
  does not lift.
- **A `GITHUB_TOKEN` push does not trigger workflows.** It would land the number
  and no `release.yml` run would ever see it. An App installation token is not
  event-suppressed — only `GITHUB_TOKEN` is.

The three one-time steps, **in this order** (step 3 answers `422 must be part of
the ruleset source or owner organization` until step 1 is done):

1. **App installation → Repository access includes `pome-sh/digital-twins`.**
   UI only: the API 403s here even for org owners on an OAuth token.
2. **Generate a SECOND private key** for the app — the first lives write-only in
   pome-cloud's secrets and cannot be read back — then:

   ```bash
   gh secret set OPS_APP_ID -R pome-sh/digital-twins -b "4582446"
   gh secret set OPS_APP_PRIVATE_KEY -R pome-sh/digital-twins < <downloaded>.pem
   gh secret list -R pome-sh/digital-twins   # verify
   ```
3. **Add the app to the ruleset's bypass list.** `GET` the ruleset first and leave
   every other field untouched:

   ```bash
   gh api repos/pome-sh/digital-twins/rulesets/18797095   # read, then PUT back with
   # bypass_actors = Team 16601595 (always) + {"actor_id": 4582446, "actor_type": "Integration", "bypass_mode": "always"}
   ```

**Why an App and not a fine-grained PAT** — this job was first written against
one. A PAT expires, and its expiry day is a release-freeze day nobody scheduled;
it also binds the release path to one person's account. An App private key does
not expire and rotates in one click.

**The F-1212 lesson, which is why the failure mode is loud either way.** This repo
just deleted its only PAT dependency (`REPO_POLICY_TOKEN`): the PAT was never
minted, so `repo-policy.yml`'s weekly cron was red from the day it shipped and its
live check never ran once. A credential nobody creates is a check nobody runs. The
app removes the recurring half of that risk; the loud half is deliberate and
stays. An unset secret reds **every push to `main`**, with the three steps above
printed in the log — not a weekly cron nobody reads — and `release-alarm.yml`
reports the consequence independently as `UNALLOCATED` within a day. The same two
signals cover a key that is later rotated away or a bypass that is revoked.
`allocate-version.yml` never falls back to `GITHUB_TOKEN`, because both fallback
outcomes (a refused push, or a push that triggers no release) look like a quiet
green.

One deliberate wart: the mint step passes `app-id`, which `create-github-app-token`
v3.2.0 deprecates in favour of `client-id`. It matches pome-cloud's call sites on
purpose; migrating is a some-day for both repos at once, not a divergence to
introduce here.

## The four packages version independently

`@pome-sh/cli`, `@pome-sh/adapter-claude-sdk`, `@pome-sh/checks` and
`@pome-sh/wire` are on their own version lines (D11) and are diff-gated
separately in the same workflow run — the CLI bundles the internal packages, the
adapter bundles `@pome-sh/wire`, `@pome-sh/checks` bundles the twins' declaration
layer, and none depends on another's published version. There is no lockstep to
enforce and no sync-versions script.

Independent version *lines* is not the same as independent *releases*, and the
one coupling worth knowing up front: because wire's compiled output is inlined
into both npm tarballs, a change under `packages/wire/` is publish-relevant for
all three, so all three get a number. Anything else — a CLI-only change, an
adapter-only change — releases only its own package. See "Before you merge".

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

**A change to a declaration file needs TWO entries** — `@pome-sh/checks` and the
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

A PR that touches a package's publish-relevant paths without adding that
package's `## Unreleased (level)` entry fails CI —
[`scripts/ci/check-release-note-required.mjs`](scripts/ci/check-release-note-required.mjs)
is the gate, and it is the re-scoped former `check-version-bump-required.mjs`
(F-1511). It asserts four things, all of them about a PR and none of them about a
number:

- **no hand-written version.** A PR that moves a published package's `version`
  field fails. That invariant is what makes every other PR's green mean
  something: nothing in a PR can be invalidated by someone else's merge if no PR
  carries the number.
- **an entry for every artifact the PR moves**, with `(patch)` or `(minor)`.
- **released entries are never rewritten** — the region from the newest released
  heading down must be byte-identical to the base branch's. Corrections go in the
  next entry, naming the one they correct. The preamble above the first heading is
  not covered, and neither is your pending section.
- **the newest released heading names the version its manifest declares** — the
  old CHANGELOG contract's one surviving assertion, now a fact about `main` that
  the allocator maintains rather than a demand on you.

If your change doesn't warrant a release (docs, tests, CI-only), it shouldn't be
touching a publish-relevant path in the first place.

**A change under `packages/wire/` requires THREE entries** — wire's own, the
CLI's, and the adapter's. That is not the gate double-counting: wire's bytes are
inlined into both npmjs tarballs, so a wire fix reaches an end user only via a CLI
or adapter release, and reaches pome-cloud only via a wire release. Three
artifacts change, so three versions move — the allocator moves all three whether
or not you wrote all three entries, and writes a version-only note for any you
did not.

**Re-running `npm run emit:trace-contract -w @pome-sh/wire` is no longer yours to
remember.** `packages/wire/trace-contract.json` embeds wire's own `version`, so
`check:trace-contract` (a required `ci.yml` gate) fails on a bump until the file
is regenerated — and the bump now happens after your PR is merged.
`allocate-version.yml` runs the real emitter in the same commit, driven by the
`regenerate` field next to that artifact in
[`scripts/ci/publish-relevance.mjs`](scripts/ci/publish-relevance.mjs). A future
second version-embedding artifact belongs in that table, not in a human
instruction.

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
