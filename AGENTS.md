# AGENTS.md

## Intro

Open-sourced Digital Twins of APIs and the `pome` CLI.

A digital twin is a local, resettable emulation of a real API that answers the same
REST, GraphQL and MCP calls your agent makes in production, backed by real SQLite state.
The CLI boots a twin, runs an agent against it, and records the trace.

Recording is open source. Evaluation and scoring are hosted: `pome run --local`
records a trace. Apache-2.0.

## Layout

```
cli/                  the `pome` CLI
  src/cli/            one file per command; main.ts is the Commander tree
  src/runner/         boots twins, runs the agent, writes artifacts
  src/recorder/       trace capture and redaction
  src/hosted/         control-plane client
  src/task/           task file parsing
  tasks/              the bundled task library `pome tasks` serves
packages/
  twin-{github,gmail,linear,slack,stripe}/
  sdk/                the HTTP + MCP server every twin mounts, route input
                      declaration, seed loading
  wire/               event and trace types crossing a process boundary
  checks/             the check DSL and the twins' check declarations
  sandbox-domains/    the same twins with no server — domain object, SQLite
                      opener, seed parser, for reading state in-process
  adapter-claude-sdk/ Claude Agent SDK correlation wrapper
contract/             cross-package tests against a booted twin
scripts/              build and CI gates
skills/               Claude skills shipped as a plugin
agent-examples/       runnable agents, each with its own install
```

## Commands

```bash
npm test                     # every vitest test in the repo, one process
npm run typecheck            # every workspace
npm run build                # every workspace, dependency-ordered
npm run test:contract        # contract/ suite, needs a built cli/
npm run test:pack            # installs both tarballs in a clean room
npm run gate:examples        # typechecks + tests every example, own install
npm run smoke:examples       # launches every example for real
npm run lint:dead-code       # knip
npm run lint                 # every lint rule, one runner
npm run lint -- <rule>       # one rule, for local iteration
npm run lint -- --list       # what rules exist
npm run lint:test            # each rule's case table
npm run probe:twins          # every declared endpoint answers
```

`npm test` is `vitest run` against the one root `vitest.config.ts`, which
declares every workspace as a project. It does **not** include `contract/` or
`scripts/`; those have their own scripts above.

Single project: `npx vitest run --project twin-github`. Single file:
`npx vitest run cli/test/unit/tasks-command.test.ts`.

**Two test conventions, and that is all.** A test that runs in-process against
source is a vitest `.test.ts` under the workspace's `test/`. The black-box
contract suite in `contract/` is plain `.mjs` on `node --test`, because running
it without TypeScript is what proves the published artifact boots — see
`CONTRACT.md`. A self-test *of a script* stays beside its script as `.mjs`.

Coverage cannot live in the root config: vitest reads `coverage` only at the
top level and drops a `coverage` block inside a project entry **silently**.
twin-github and twin-slack each keep a `vitest.coverage.config.ts` that
`test:coverage` passes with `--config`.

## Rules

**Internal `@pome-sh/*` deps are `"*"`.** Workspace linking resolves them. An
exact pin between siblings installs a second registry copy and you get two zod
schema identities in one runtime. This holds for `@pome-sh/wire` too, even
though it is published.

**`agent-examples/*` pins are exact, on purpose.** Each example installs
independently, so it needs a real published version. This is the inverse of the
rule above and both are correct.

**`zod` is a `peerDependency` in published packages, never bundled.** Two copies
means two schema identities.

**Released changelog entries are insertions only.** Correct a released entry
with a new entry naming the one it corrects.

**A twin's MCP tool table is never written in TypeScript.** Each twin derives
its served listing from `packages/twin-*/fixtures/mcp-tools-list.raw.json` —
captured vendor bytes, validated at load. Add a tool by capturing it, not by
typing it.

**Route inputs come from the route's declaration.** Handlers receive a parse
result, never the raw request. `declareRouteInputs()` is how a route says what
it accepts, and `packages/twin-*/route-inputs.json` publishes that set.

**Criterion markers are `[code]` and `[model]`.** The bracketed `D`/`P` forms
are retired.

**No bare `import.meta.main` in an entry guard.** It is `undefined` before Node
24.2 and `engines` allows `>=24`, so the guard exits 0 having run nothing.
Compare a realpath'd `process.argv[1]` against `import.meta.url` and throw on a
miss — copy the guard in `contract/run.mjs`.

**Every scheduled workflow needs a failure alarm.** A `schedule:` trigger with
no alarm reds CI. A scheduled run that fails silently reads exactly like one
that passed.

## Publishing

| Package | Registry |
|---|---|
| `@pome-sh/cli`, `@pome-sh/adapter-claude-sdk` | npm, for end users |
| `@pome-sh/checks`, `@pome-sh/sandbox-domains` | npm, consumed by our own services |
| `@pome-sh/wire` | GitHub Packages, sibling repositories only |
| `@pome-sh/sdk`, `@pome-sh/twin-*` | not published — `private: true`, bundled into the tarballs by tsup |

## Vocabulary

| Word | Means |
|---|---|
| `digital twin` | one stateful emulation of a real API. Full phrase on first use per page, `twin` after |
| `sandbox` | the container a user starts — one id, one TTL, the billing unit |
| `task` | one graded run definition — prompt, seed state, criteria. The word it replaced is retired; never reintroduce it |
| `pod` | the per-twin microVM. Internal only |

**Banned in anything a user reads:** `clone` (it means a copy of the customer's
own agent — the opposite thing), `service`, `simulation` as a noun,
`environment` for a twin, `mock`, `stub`, `fake`, `staging layer`,
`self-healing`.

**Never print a twin count without the depth number.** A bare "5 twins" invites
a comparison we lose. Pair it with the tool count and the fidelity claim.

**Identifiers do not move**, whatever the prose says: `pome twin start`,
`MOUNTED_TWINS`, `TWIN_*`, `TwinHttpEvent`, and the `twins` key in the published
`pome.json` schema. `TwinHttpEvent` is stamped into every persisted trace.

The serialized `scenario` / `scenario_*` keys are the one place the retired word
survives, because a server reads them. Leave them alone.

## CI

The `lint` and `gate:*` scripts in the root `package.json` run on every PR,
wired in [`.github/workflows/ci.yml`](.github/workflows/ci.yml). They are the
source of truth for what this repo guarantees — read the rule when one fails
rather than guessing at it.

`npm run lint` is one runner over the rules in
[`scripts/lint/rules/`](scripts/lint/rules/). The runner owns traversal,
reporting and exit codes; a rule is a declaration plus a predicate, and its
module header is where the argument for it lives. `npm run lint -- <rule>` runs
one for local iteration, `npm run lint -- --list` names them all, and
`npm run lint:test` runs each rule's case table — which asserts the RED
direction, because a rule that has quietly stopped failing prints the same line
as a rule with nothing to report.

Adding a rule is one file plus its case table. No npm script, no CI step: the
registry in `scripts/lint/rules.mjs` is the only other edit, and the runner
fails on a rule with no case table at all.

The gates that are NOT rules, because they are different in kind rather than in
rule: `lint:no-cloud-imports` (shell, and in the pre-commit hook), `lint:dead-code`
(knip), `gate:route-inputs` (codegen freshness), `gate:mcp-tools-list`,
`test:pack`, and the tarball audits, which inspect built npm artifacts rather
than the source tree.

The ones that catch people: `lint` (the product boundary lives in its `no-eval`
rule), `lint:no-cloud-imports`, `lint:dead-code`, `gate:route-inputs`,
`gate:mcp-tools-list`, `test:pack`, and the tarball audits.

Secrets: `.github/workflows/secret-scan.yml` runs TruffleHog over the diff,
verified findings only, on `pull_request` and on push to `main`. The PR run is
the required check; the push run covers commits that reach `main` without one.
The local hook (`bash scripts/hooks/install.sh`) wires the boundary and
copy-marker gates and needs nothing installed.

Twin images publish only after `ci`, and `secret-scan` on `main`, pass on the
same SHA, then Trivy. GHCR digests are cosign-signed and carry an SPDX SBOM.

"Zero embedded cloud config" means no credentials and no non-overridable env
wiring. An overridable public API base (`https://api.pome.sh`, via `--api-url`
or `POME_API_URL`) is fine.
