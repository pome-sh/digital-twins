# AGENTS.md

> Operational notes for anyone — human or AI agent — working in this repo.

## What this repo is

The open-source Pome twins and the `pome` CLI. The twins are local, resettable
services that answer the same REST, GraphQL, and MCP calls your agent makes in
production (GitHub, Stripe, Slack, Gmail, Linear), each backed by real SQLite
state. The CLI boots a
twin, runs an agent against it, and records the trace for you to inspect.
Evaluation and scoring are hosted features — `pome run --local` records a trace
only, no local scoring. The Pome platform (evaluation, simulation,
observability) is at https://pome.sh. Apache-2.0.

## Docs

Repo layout, full build/test workflow, conventions, and the contributor guide
live at **https://docs.pome.sh**.

## Before you build

- **npm only** — one root `package-lock.json` for `packages/*`; use
  `npm ci` / `npm install`.
- **Vocabulary: the product term is "task"** — "scenario" is retired (F-778,
  F-860, F-892). Never introduce "scenario" in new code, docs, or CLI copy.
  F-892 completed the CLI rename end-to-end: the command (`pome tasks`), scaffold
  (`./tasks/`), and the internal runner/schema surface (`src/task/`, `runTask*`,
  the `Task` type, `parseTask`, `taskSchema`). `pome scenarios` survives only as
  a hidden deprecated alias. The ONLY remaining sanctioned survivors are the
  serialized `scenario` / `scenario_*` keys — the run-artifact `scenario` key and
  the finalize/result wire fields (server contract; flip with W3/FDRS-653) — and
  the in-memory carriers whose value flows straight into them.
- **The CLI (`cli/`) IS a root workspace member** — `workspaces: ["packages/*",
  "cli"]`, one `package-lock.json`, one `npm ci`. Use `npm run -w @pome-sh/cli
  ...` from the root. The former `cli/package-lock.json` and
  `cli/pnpm-workspace.yaml` (the changesets/manypkg root marker) are gone.
- **Internal `@pome-sh/*` deps are `"*"`** — sdk, shared-types and the five
  twins are `private: true` workspace members resolved by npm's workspace
  linking, never from the registry. Never reintroduce an exact version pin
  between them: the exact pins drifted and installed a second registry copy of
  `@pome-sh/shared-types` (two zod schema identities at one runtime).

## Releases (`@pome-sh/cli`, `@pome-sh/adapter-claude-sdk`)

Those two packages are the ONLY things published to npm. Everything else
(`@pome-sh/sdk`, `@pome-sh/shared-types`, the five `@pome-sh/twin-*`) is a
`private: true` workspace member bundled into them by tsup
(`noExternal: [/^@pome-sh\//]`).

`.github/workflows/release.yml` is version-diff driven (npm OIDC Trusted
Publishing, provenance on). To ship:

1. Bump the version in that package's own `package.json` and write the
   user-facing entry in its `CHANGELOG.md`.
2. Merge to `main`. `release.yml` compares each package's local version against
   the registry and publishes only the ones that differ. Publishing from a
   version BEHIND npm `latest` is a hard failure, not a skip — that would retag
   `latest` backwards.

The two version INDEPENDENTLY: the CLI is on its own line, the adapter on its
0.2.x line. There is no lockstep to enforce (nothing published depends on an
internal version), so there is no sync-versions script. Changesets are gone.

## Invariants ↔ CI checks (P8)

Docs are contracts. Any PR that changes an invariant below must update this
section in the same PR.

| Invariant | Enforced by |
| --- | --- |
| npm only | root `packageManager` is npm; CI/Docker use `npm ci` and committed `package-lock.json` |
| Capture is open, evaluation is the product — no local eval/scoring/judging/correlation anywhere in `cli/src/**`, `cli/scripts/**`, `packages/**`, or repo-root `scripts/**` | [`scripts/no-eval-in-oss.mjs`](scripts/no-eval-in-oss.mjs) (`npm run gate:no-eval`) in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — repo-wide, path + module-name + import denylist, empty file allowlist. The module-name rule is a **prefix** match (`correlate*`/`score*`/`judge*`/`verdict*`); an infix like `runScorer.ts` relies on the import rule instead — accepted policy, not a gap. |
| No cloud imports in OSS (`packages/`, `cli/src/`, `cli/scripts/`, `scripts/`) — including bare `pome-cloud/*` | [`scripts/lint-no-cloud-imports.sh`](scripts/lint-no-cloud-imports.sh) (+ fixture test `scripts/lint-no-cloud-imports.test.sh`) |
| Public `main` protection (classic: strict required checks + no force-push/delete; ruleset `main founder-bypass`: PR + 1 review + conversation resolution + same checks, with team `founder` bypass so founders can self-merge) | [`scripts/ci/assert-repo-policy.sh`](scripts/ci/assert-repo-policy.sh) via [`.github/workflows/repo-policy.yml`](.github/workflows/repo-policy.yml) (offline fixtures in CI; live drift needs Actions secret `REPO_POLICY_TOKEN` — fine-grained PAT with Administration: Read-only; `GITHUB_TOKEN` cannot hold that scope) |
| Twin image publish waits for both `ci.yml` and `secret-scan.yml` on the same SHA; PR image matrix builds only changed twins (full matrix on main/tags) | [`scripts/ci/wait-for-workflow.sh`](scripts/ci/wait-for-workflow.sh) in [`.github/workflows/twin-image.yml`](.github/workflows/twin-image.yml); regression: [`scripts/ci/wait-for-workflow.test.mjs`](scripts/ci/wait-for-workflow.test.mjs) |
| Required `typecheck-test` always reports on PRs; heavy npm build/test/parity is skipped for docs/chore-only diffs | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) path-aware scope step |
| No cross-package file copies | [`scripts/check-copy-markers.mjs`](scripts/check-copy-markers.mjs) (empty allowlist) |
| Criterion markers are `[code]`/`[model]` — the retired bracketed `D`/`P` forms never reappear (allowlist: the parser's legacy-detection + its rejection tests; `CHANGELOG.md`s are historical records) | [`scripts/lint-legacy-criterion-markers.mjs`](scripts/lint-legacy-criterion-markers.mjs) via `npm run lint:legacy-markers` in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Dead code / orphan packages = 0 | [`knip.json`](knip.json) via `npm run lint:dead-code` in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Zero native modules in the production dependency closure (gyp markers: `binding.gyp` / `"gypfile"`; prebuilt installers like esbuild/fsevents pass) | [`scripts/no-native-modules.mjs`](scripts/no-native-modules.mjs) via `npm run gate:no-native` in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Every third-party dep of a package INLINED into the CLI bundle is declared by the CLI (a bundled package's own `dependencies` are never installed for it) | [`scripts/check-bundled-runtime-deps.mjs`](scripts/check-bundled-runtime-deps.mjs) via `npm run gate:bundled-deps` in [`ci.yml`](.github/workflows/ci.yml) and [`release.yml`](.github/workflows/release.yml) |
| Both published tarballs install and run with no access to this workspace; all five twins boot from the CLI tarball; a consumer typechecks against the adapter's shipped declarations | [`scripts/clean-room-pack-test.mjs`](scripts/clean-room-pack-test.mjs) via `npm run test:pack` in [`ci.yml`](.github/workflows/ci.yml) and [`release.yml`](.github/workflows/release.yml) |
| Package barrels + file-size hygiene | [`scripts/lint-code-health.mjs`](scripts/lint-code-health.mjs) |
| A published version is never behind npm `latest` — a publish must not retag `latest` backwards (an unpublished package's `0.0.0` baseline passes) | the `plan` job in [`.github/workflows/release.yml`](.github/workflows/release.yml) |

## Public Repo Guardrails

The public `main` branch requires reviewed PRs and green required checks before
merge. Direct pushes are reserved for release automation only.

“Zero embedded cloud config” means no credentials and no non-overridable env
wiring. An overrideable public API base (`https://api.pome.sh`, via
`--api-url` / `POME_API_URL`) remains allowed.

Secret scanning runs in CI via [`.github/workflows/secret-scan.yml`](.github/workflows/secret-scan.yml)
with both gitleaks and TruffleHog. Install the local hook with
`bash scripts/hooks/install.sh`; staged changes are blocked unless the same
boundary gates pass and installed secret scanners find no verified secrets.

Twin images publish only after both the `ci` and `secret-scan` workflows
succeed for that SHA (`scripts/ci/wait-for-workflow.sh`) and Trivy scans pass.
Published GHCR
digests are cosign-signed with GitHub OIDC, and each digest receives an SPDX
SBOM attestation. Downstream cloud snapshot promotion must pin and verify those
signed digests before rebuilding runtime snapshots. That promotion is operated
from the private `pome-sh/pome-cloud` repo — maintainers: see
`docs/runbooks/twin-release-and-promotion.md` there.

Only `@pome-sh/cli` and `@pome-sh/adapter-claude-sdk` are published to npm.
Everything else is internal to the CLI tarball, so the per-package version-bump
runbook (`PACKAGE_RELEASE.md`) is retired.

Everything else — architecture, per-package details, and the CI gotchas
(no-cloud-imports, twin Docker build) — is documented at
https://docs.pome.sh.
