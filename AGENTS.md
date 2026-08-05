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
  serialized `scenario` / `scenario_*` keys that have a contract behind them —
  `meta.json`'s `scenario` slug (uploaded to cloud finalize; also read back by
  `pome eval` / `pome inspect` from run dirs older CLIs wrote) and the
  finalize / result / compile-seed wire fields (server contract; flip with
  W3/FDRS-653) — and the in-memory carriers whose value flows straight into
  them. F-933 renamed the two artifact keys that had no such contract:
  `runs/latest.json` now writes `task` (was `scenario`) and
  `runs/<task>/<session>/verdict.json` writes `task_path` (was
  `scenario_path`); the verdict READ path still accepts `scenario_path` so
  `pome fix-prompt` can read trials recorded by `@pome-sh/cli` <= 0.8.x.
- **The CLI (`cli/`) IS a root workspace member** — `workspaces: ["packages/*",
  "cli"]`, one `package-lock.json`, one `npm ci`. Use `npm run -w @pome-sh/cli
  ...` from the root. The former `cli/package-lock.json` and
  `cli/pnpm-workspace.yaml` (the changesets/manypkg root marker) are gone.
- **Internal `@pome-sh/*` deps are `"*"`** — sdk, wire and the five
  twins are `private: true` workspace members resolved by npm's workspace
  linking, never from the registry. Never reintroduce an exact version pin
  between them: the exact pins drifted and installed a second registry copy of
  `@pome-sh/shared-types` (two zod schema identities at one runtime).

## Releases (`@pome-sh/cli`, `@pome-sh/adapter-claude-sdk`)

Those two packages are the ONLY things published to npm. Everything else
(`@pome-sh/sdk`, `@pome-sh/wire`, the five `@pome-sh/twin-*`) is a
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
(F-1180's `RELEASE_BOT_TOKEN` / release-PR check verifier applied to the old
Changesets version PR; this lane has no bot-pushed version PR, so that
machinery is gone with `cli-release.yml`.)

## Invariants ↔ CI checks (P8)

Docs are contracts. Any PR that changes an invariant below must update this
section in the same PR.

| Invariant | Enforced by |
| --- | --- |
| npm only | root `packageManager` is npm; CI/Docker use `npm ci` and committed `package-lock.json` |
| Renovate is the sole dependency updater — fortnightly batched non-majors, ≤1 concurrent PR, security anytime; ignores release-gated `@pome-sh/*` npm bumps | [`renovate.json`](renovate.json) (Mend Renovate GitHub App) |
| Capture is open, evaluation is the product — no local eval/scoring/judging/correlation anywhere in `cli/src/**`, `cli/scripts/**`, `packages/**`, or repo-root `scripts/**` | [`scripts/no-eval-in-oss.mjs`](scripts/no-eval-in-oss.mjs) (`npm run gate:no-eval`) in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — repo-wide, path + module-name + import denylist, empty file allowlist. The module-name rule is a **prefix** match (`correlate*`/`score*`/`judge*`/`verdict*`); an infix like `runScorer.ts` relies on the import rule instead — accepted policy, not a gap. |
| No cloud imports in OSS (`packages/`, `cli/src/`, `cli/scripts/`, `scripts/`) — including bare `pome-cloud/*` | [`scripts/lint-no-cloud-imports.sh`](scripts/lint-no-cloud-imports.sh) (+ fixture test `scripts/lint-no-cloud-imports.test.sh`) |
| Public `main` protection (classic: strict required checks + no force-push/delete; ruleset `main founder-bypass`: PR + conversation resolution + same checks, zero required approving reviews so either founder can merge on green CI; team `founder` bypass kept) | [`scripts/ci/assert-repo-policy.sh`](scripts/ci/assert-repo-policy.sh) via [`.github/workflows/repo-policy.yml`](.github/workflows/repo-policy.yml) (offline fixtures in CI; live drift needs Actions secret `REPO_POLICY_TOKEN` — fine-grained PAT with Administration: Read-only; `GITHUB_TOKEN` cannot hold that scope) |
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
| Every tool a bundled example registers is answered by the twin it targets, on that example's own task seed. A tool the twin refuses (4xx/5xx) reds the gate naming the example, the tool, and the twin's status; a newly added tool with no probe reds it too, as does an `expect_status` exemption that no longer fires. `typecheck:examples` is green on a well-typed tool whose endpoint 404s and `smoke:examples` returns before any tool fires, which is how `comment_on_pull_request` 404'd in two examples for their entire existence. Needs no model | [`scripts/probe-example-tools.mjs`](scripts/probe-example-tools.mjs) (`npm run probe:examples`) in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), fixture arguments in [`config/example-tool-probes.json`](config/example-tool-probes.json); regression: [`scripts/probe-example-tools.test.mjs`](scripts/probe-example-tools.test.mjs) |
| Every member of the event union (`otelEventSchema` — the seven `eventSchema` variants plus `OtelSpanEvent`) has at least one wire fixture under `packages/wire/test/fixtures/v1/event/<Kind>/`, and the kind list in `trace-contract.json` is enumerated from the zod union rather than typed out. Adding a kind with no fixture, or renaming one and leaving its directory behind, fails BOTH `emit:trace-contract` and `--check` — regenerating is not an escape hatch. The old script read no schema at all: `canonicalSchemas` was a hardcoded four-string literal and the rest was a directory walk, so a new kind moved zero bytes and the byte-compare was green by construction, which is how M1 shipped `LlmTurnEvent` with no fixture anywhere | [`packages/wire/scripts/emit-trace-contract.mjs`](packages/wire/scripts/emit-trace-contract.mjs) (`npm run check:trace-contract -w @pome-sh/wire`) in [`.github/workflows/ci.yml`](.github/workflows/ci.yml); regression: [`packages/wire/scripts/emit-trace-contract.test.mjs`](packages/wire/scripts/emit-trace-contract.test.mjs). The dropped/renamed half is `typecheck` — `test/export-surface.test.ts` guards the per-kind types, `test/v1-event-corpus.test.ts` keys its coverage map on `OtelEvent["kind"]` |
| No emitter writes a bare `parent_id`. It meant four different things depending on which of five writers produced the row — a spawning `event_id` (`wrapQuery`), a raw SDK `tool_use_id` (`hooks`), a hard null (`turn-usage`, and every twin HTTP row), and a mirror of `parent_span_id` (`OtelSpanEvent`) — so reading a trace meant knowing which writer a row came from. The vocab is `parent_event_id` (always the spawning row's `event_id`) plus `causing_tool_use_id` for the meaning that was never a parent edge. The schema still ACCEPTS `parent_id` as a legacy input key, and must: every shipped 0.13.0 emitter writes it and a row that fails to parse is dropped silently, so the tolerant readers stay. That tolerance is exactly why the gate is a linter and not zod — nothing in the type system can stop a new writer emitting the old spelling and having it parse. Allowlist is five reader files, one of which is the Linear twin's own domain model (an issue's parent issue, not an event's parent row) | [`scripts/lint-parent-vocab.mjs`](scripts/lint-parent-vocab.mjs) (`npm run lint:parent-vocab`) in [`.github/workflows/ci.yml`](.github/workflows/ci.yml); regression: [`scripts/lint-parent-vocab.test.mjs`](scripts/lint-parent-vocab.test.mjs) — case 2 locks the quoted-key hole the first version of the gate had |
| `main`'s required status-check contexts have exactly one home — the live-protection assertion reads it, so it cannot drift into watching a context GitHub no longer requires | [`config/required-checks.json`](config/required-checks.json), read by [`scripts/ci/assert-repo-policy.sh`](scripts/ci/assert-repo-policy.sh) |

## Public Repo Guardrails

The public `main` branch requires a PR and green required checks before merge
(no approving-review gate — the founder team is two people). Direct pushes are
reserved for release automation only.

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
