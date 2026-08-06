# `@pome-sh/checks`

The grading vocabulary of Pome's five digital twins: the **check declarations**,
the **seed schemas** and the **default seeds**, plus the **check DSL** they are
written in.

Declarations only. No twin server, no database, no HTTP routes, no tool
dispatch. If you want to *run* a twin, install
[`@pome-sh/cli`](https://www.npmjs.com/package/@pome-sh/cli) (`npx @pome-sh/cli
twin start github`) or pull the twin's container image — this package cannot
start one and does not try to.

```bash
npm install @pome-sh/checks zod
```

`zod` is a **peer dependency**, and installing your own copy is the point: the
seed schemas are zod values, and two copies of zod in one process means two
schema identities — `instanceof` fails and parsed results stop being
interchangeable. One zod, one identity.

## What it is for

A Pome task scores an agent with criteria. A `[code]` criterion is graded by a
**check**: a declared, templated assertion over the twin's final state, its seed
compared against its final state, or the recorded tape of tool calls. This
package is where those declarations live, so the thing that grades a run and the
twin that produced it agree on the vocabulary rather than each keeping its own
copy of it.

## Use

Everything under one specifier, with the seed helpers prefixed by twin:

```ts
import { GITHUB_CHECKS, TWIN_CHECKS, parseGitHubSeed, renderCheck } from "@pome-sh/checks";

const check = GITHUB_CHECKS.find((c) => c.id === "github.issue-closed");
```

Or one twin at a time, keeping that twin's own names:

```ts
import { GITHUB_CHECKS, parseSeed, seedSchema } from "@pome-sh/checks/github";
```

Subpaths: `./github`, `./slack`, `./stripe`, `./gmail`, `./linear`, and `./dsl`
for the DSL alone.

| Export | What |
| --- | --- |
| `GITHUB_CHECKS`, `SLACK_CHECKS`, `STRIPE_CHECKS`, `GMAIL_CHECKS`, `LINEAR_CHECKS` | Each twin's declarations, in authoring order |
| `TWIN_CHECKS` | The five arrays keyed by twin id |
| `CHECKS_TWIN_NAMES`, `ChecksTwinName` | The five twin ids, and the type derived from them |
| `parse<Twin>Seed`, `<twin>SeedSchema`, `default<Twin>Seed` | Seed contract per twin |
| `defineCheck`, `parseCheck`, `renderCheck`, `checkPattern`, `checksDigest`, `templateSlots`, `statePath`, `childStatePath` | The DSL |
| `GitHubCheck`, `GmailCheck`, `LinearCheck`, `SlackCheck`, `StripeCheck` | Each twin's check element type. Every twin declares its own `Check<TArgs>` over its own state, so the barrel prefixes them; the per-twin subpaths keep the plain name `Check` |
| `CheckDefinition`, `Check…State` types | The generic declaration type, and each twin's state shape — what you want when the twin is a parameter rather than known |
| `VACUITY_SENTINEL`, `VACUITY_SENTINEL_NUMBER`, `VACUITY_SENTINEL_SNAKE` | The values that mark an assertion no state can satisfy |

`applySeed` and `loadSeedFromEnv` are **not** exported. The first writes rows
into a live SQLite database and the second reads `process.env`; both are twin
runtime behaviour, not declarations.

## Versioning

Pre-1.0, so `^0.x` caret semantics apply and **minor plays the major role**:

- **Minor (`0.N+1.0`)** — anything a consumer must act on: a check id renamed or
  removed, a template changed, a polarity flipped, a seed schema tightened, an
  `engines` floor bump.
- **Patch (`0.N.x`)** — additive checks or exports, wording that does not change
  a pattern, internal implementation swaps behind an unchanged surface.

A grading vocabulary is a contract in a stricter sense than a normal library: a
renamed check id does not break a build, it silently stops binding, and a
criterion that stops binding scores nothing. Treat every id as public.

## Where the source lives

Nowhere in this package. Every declaration is re-exported from the twin that
owns it (`packages/twin-*/src/check-*.ts`) and the DSL from
`packages/sdk/src/checks.ts`, all in
[pome-sh/digital-twins](https://github.com/pome-sh/digital-twins). Their
compiled output is inlined here at build time, so this package declares no
`@pome-sh/*` dependency and there is no second copy to drift.

Licence: Apache-2.0.
