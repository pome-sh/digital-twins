# `packages/`

npm workspaces (`packages/*` in root `package.json`). **Internal repo layout —
not an install surface.** The only thing end users install is
[`@pome-sh/cli`](../cli/) (`npx @pome-sh/cli …`), which ships the twin engine,
`@pome-sh/wire`, and all five twins inside its tarball. This doc is the
internal architecture map for contributors — what each package is, why it's
shaped the way it is, and which of the eight are actually reachable from
outside this repo. (`@pome-sh/wire` is additionally published to GitHub
Packages for sibling *repositories*, not for users — see "Private vs.
published".)

## The registry: one typed source of truth for five twins

[`cli/src/twin/registry.ts`](../cli/src/twin/registry.ts) is where a twin
becomes something the CLI can boot. Before it existed, adding a twin meant
editing four hand-maintained lists that had to agree with each other (a
`switch` in the run harness, a standalone-twin allowlist, a default-seed
lookup, a default-port lookup) plus a lint that diffed them — and they still
drifted. Now:

- `TWIN_NAME_LIST` (`["github", "slack", "stripe", "gmail", "linear"]`) is the
  single source `TwinName` is derived from, so a misspelled or missing twin
  id is a compile error, not a runtime surprise.
- `TWIN_REGISTRY: Record<TwinName, TwinEntry>` holds every other per-twin
  fact in one place: its env prefix (`POME_<NAME>_{REST,MCP}_URL`), its
  `CONTRACT.md` default port, its own package version (inlined at build time
  from the twin's `package.json`, because runs report the *twin's* version,
  never the CLI's), a `defaultSeed()`, and a `boot()`.
- Each entry's `boot()` reaches its twin package through a **dynamic
  `import()` inside the method**, never a top-level import. That buys two
  things: the bundler emits one lazily-loaded chunk per twin instead of
  pulling all five twins (and five SQLite schemas) into the CLI's startup
  path, and `pome twin start github` only pays for github.

If you're adding a sixth twin, this file is the whole surface for **booting**
it — no other boot-time list to keep in sync. Two coordinated updates still
live outside the registry, by design (they're not "does this twin exist",
they're "what does this specific twin need"): `cli/src/doctor/scan.ts`'s
per-twin egress hostname (for preflight network checks) and
`cli/src/runner/runTaskHosted.ts`'s per-twin hosted-credential branch (each
twin's provider-credential shape differs — github/stripe get a bearer token,
slack uses the plain agent token, gmail has no `provider_credentials` shape
at all). Adding a twin means updating those two alongside the registry.

## `@pome-sh/wire` — the shared trace surface

[`wire/`](./wire/) is the vocabulary every process in this repo agrees on for
describing a run: Zod schemas and types for recorder events, the OpenTelemetry
span extension of that union, and secret redaction. The CLI, the twin engine
(`@pome-sh/sdk`), [`@pome-sh/adapter-claude-sdk`](./adapter-claude-sdk/), and
three of the five twins (`twin-github`, `twin-slack`, `twin-stripe`) import
from it directly; `twin-gmail` and `twin-linear` only reach it transitively
through `@pome-sh/sdk`. It's the one place a wire-shape change has to happen
for every producer and consumer to see it consistently.

It exists because that vocabulary used to live in a package called
`@pome-sh/shared-types`, which drifted: internal consumers pinned an *exact*
version against each other, the pins fell out of sync, and npm ended up
installing two copies of the same Zod schemas at one runtime (two schema
identities that were supposed to be identical — F-942). `@pome-sh/shared-types`
was dissolved: the trace-wire half became `@pome-sh/wire`, and the
control-plane half (sessions, tasks, runs, the `/v1` REST surface, error
envelopes, the `pome.json` manifest — none of which is a *trace* shape) moved
to [`cli/src/contract/`](../cli/src/contract/), which isn't a workspace
package at all, just CLI-internal TypeScript. Every internal `@pome-sh/*`
dependency is now `"*"` (workspace-resolved), not an exact pin, precisely so
that drift can't recur (see `AGENTS.md`).

`wire/trace-contract.json` is the machine-readable version of its own trace
surface — generated from the Zod event union rather than hand-typed, so a new
event kind with no fixture fails CI instead of silently shipping unrecorded
(see `wire/README.md`).

## `@pome-sh/sdk` — the twin engine

[`sdk/`](./sdk/) is the mechanism every twin is a thin plugin on: HTTP
mounting, bearer auth, the trace recorder (which redacts secrets before a
custom store ever sees a row), MCP dispatch, SQLite-backed state, and the
admin reset/seed gate. A twin's own code is just its domain model and tools;
`@pome-sh/sdk` is everything else. See `sdk/README.md` for the recorder
internals.

## Twin runtimes

Five packages — each a digital twin runtime, booted by the CLI (via the
registry above) and by the per-twin `dist/src/server.js` entry that
pome-cloud's sandbox images run directly:

| Directory | Workspace name |
| --- | --- |
| [`twin-github/`](./twin-github/) | `@pome-sh/twin-github` |
| [`twin-stripe/`](./twin-stripe/) | `@pome-sh/twin-stripe` |
| [`twin-slack/`](./twin-slack/) | `@pome-sh/twin-slack` |
| [`twin-gmail/`](./twin-gmail/) | `@pome-sh/twin-gmail` |
| [`twin-linear/`](./twin-linear/) | `@pome-sh/twin-linear` |

Each directory has its own README (ports, env, runtime contract) and a
`FIDELITY.md` documenting its surface route-by-route. Every twin honors the
frozen [`CONTRACT.md`](../CONTRACT.md) — entry point, env surface, `/healthz`
shape, auth, and MCP surfaces.

## `@pome-sh/checks` — the grading vocabulary, as its own artifact

[`checks/`](./checks/) contains no declarations of its own. It re-exports each
twin's `check-*.ts` vocabulary and seed contract, plus the check DSL from
`@pome-sh/sdk/checks`, and tsup inlines their compiled output into its `dist/`.
One package, one version line, zero `@pome-sh/*` runtime dependencies.

It exists because the twins are `private: true` and pome-cloud grades every
`[code]` criterion out of these declarations from a **different repository**
(F-1308). Privatising the twins fixed a real bug — two zod schema identities for
one wire type (F-942) — but it also meant a corrected check declaration could
never reach the thing that grades with it. Publishing the declaration layer on
its own restores that path without reversing the fix.

Two properties are load-bearing and gated by
[`scripts/ci/check-checks-tarball.mjs`](../scripts/ci/check-checks-tarball.mjs):

- **zod is a `peerDependency`, never bundled.** The seed schemas are zod values;
  two copies means two schema identities, which is F-942 again in a new package.
- **the twin engine is not inlined.** `twin-stripe`'s seed needs one zod schema
  that `@pome-sh/sdk/server` also re-exports, and importing that barrel pulls
  hono, `hono/jwt` and `node:sqlite` — 14 runtime modules — into a package whose
  job is to hand out declarations. `@pome-sh/sdk/failure-injection` is the narrow
  subpath that exists so it doesn't.

`applySeed` and `loadSeedFromEnv` are deliberately not re-exported: they write
SQLite rows and read `process.env`. The twin *runtime* channel is GHCR and stays
GHCR; only the *vocabulary* travels by npm.

## Private vs. published

Three packages in this repo are published to **npm**: two for end users
(`@pome-sh/cli`, `@pome-sh/adapter-claude-sdk`) and one for the cloud grader
(`@pome-sh/checks`). One (`@pome-sh/wire`) is published to **GitHub Packages**
for internal cross-repo consumers. Everything else under `packages/` is
`private: true` and reaches users only as bytes inlined into one of those
tarballs — there is no `npm install` for it, ever.

| Directory | Workspace name | Role | Published? |
| --- | --- | --- | --- |
| [`checks/`](./checks/) | `@pome-sh/checks` | Grading vocabulary — the five twins' check declarations, seed schemas and default seeds, plus the check DSL | **Yes** — npm, for pome-cloud (F-1308) |
| [`sdk/`](./sdk/) | `@pome-sh/sdk` | Twin engine — HTTP mount, auth, recorder, MCP dispatch, SQLite | No — bundled into `@pome-sh/cli` |
| [`wire/`](./wire/) | `@pome-sh/wire` | Trace surface — recorder-events, redaction, OTel schemas | **Both** — bundled into `@pome-sh/cli` and `@pome-sh/adapter-claude-sdk`, *and* published to GitHub Packages (`npm.pkg.github.com`) for pome-cloud (F-949) |
| [`twin-github/`](./twin-github/), `twin-stripe/`, `twin-slack/`, `twin-gmail/`, `twin-linear/` | `@pome-sh/twin-*` | The five digital twins | No — bundled into `@pome-sh/cli`; also published as signed GHCR container images for pome-cloud |
| [`adapter-claude-sdk/`](./adapter-claude-sdk/) | `@pome-sh/adapter-claude-sdk` | Claude Agent SDK adapter for user agent code | **Yes** — npm |

"Bundled" means tsup's `noExternal: [/^@pome-sh\//]` inlines the internal
package's compiled output straight into the publishing package's own `dist/`
at build time (`cli/tsup.config.ts`); the internal package never appears in the
published `package.json`'s `dependencies` and is never fetched from the
registry at install time. The end-user **`pome` CLI** itself lives at repo
root [`cli/`](../cli/), not under `packages/` — it's the other npm-published
package, alongside `@pome-sh/adapter-claude-sdk` here.

`@pome-sh/wire` is the only row that is both, and the distinction matters
because the two paths never meet. `cli/` and `adapter-claude-sdk/` depend on it
as a **devDependency** at `"*"` and tsup inlines it, so an end user's install
graph contains no `@pome-sh/wire` at all — which is load-bearing, because the
GitHub Packages copy requires a GitHub token even to read and would 401 for
them. The GitHub Packages copy exists for exactly one reason: `pome-cloud`
lives in a different repository and needs the same trace vocabulary, and
duplicating Zod schemas across a repo boundary is what produced the two-schema-
identities bug that dissolved `@pome-sh/shared-types` in the first place. See
[`RELEASING.md`](../RELEASING.md) for the publish model and the one-time
package-visibility step.

For how the three published packages version and release, see
[`RELEASING.md`](../RELEASING.md) at the repo root.
