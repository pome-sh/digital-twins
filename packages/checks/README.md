# `@pome-sh/checks`

`@pome-sh/checks` contains the check declarations and seed contracts for Pome digital twins. It also exports the check DSL.

This package does not contain a twin server, database, HTTP route, or MCP dispatcher. Use [`@pome-sh/cli`](https://www.npmjs.com/package/@pome-sh/cli) to run a twin.

## Install

```bash
npm install @pome-sh/checks zod
```

Node.js 24 or later is required. `zod` is a peer dependency and is not bundled.

## Use

Import all twin declarations from the package root:

```ts
import { GITHUB_CHECKS, TWIN_CHECKS, parseGitHubSeed, renderCheck } from "@pome-sh/checks";

const check = GITHUB_CHECKS.find((candidate) => candidate.id === "github.issue-state");
```

Import one twin through its subpath when you need its unprefixed seed exports:

```ts
import { GITHUB_CHECKS, parseSeed, seedSchema } from "@pome-sh/checks/github";
```

Available subpaths are `./github`, `./gmail`, `./linear`, `./slack`, `./stripe`, and `./dsl`.

## Main exports

| Export | Purpose |
| --- | --- |
| `GITHUB_CHECKS`, `GMAIL_CHECKS`, `LINEAR_CHECKS`, `SLACK_CHECKS`, `STRIPE_CHECKS` | Check declarations for each twin |
| `TWIN_CHECKS` | Check arrays keyed by twin ID |
| `CHECKS_TWIN_NAMES`, `ChecksTwinName` | Supported twin IDs and their type |
| `parse<Twin>Seed`, `<twin>SeedSchema`, `default<Twin>Seed` | Prefixed seed exports |
| `defineCheck`, `parseCheck`, `renderCheck`, `checkPattern`, `checksDigest` | Core check DSL |
| `statePath`, `childStatePath`, `templateSlots` | DSL helpers |
| `GitHubCheck`, `GmailCheck`, `LinearCheck`, `SlackCheck`, `StripeCheck` | Twin-specific check types |
| `CheckDefinition`, `Check...State` | Generic check and state types |
| `VACUITY_SENTINEL`, `VACUITY_SENTINEL_NUMBER`, `VACUITY_SENTINEL_SNAKE` | Values that no state can satisfy |

`applySeed` and `loadSeedFromEnv` are not exported. They modify runtime state or read process configuration.

## Source and packaging

The source declarations remain with their owning twins in `packages/twin-*/src/check*.ts`. The DSL source is in [`packages/sdk/src/checks.ts`](../sdk/src/checks.ts).

The build bundles those declarations into this package. The published manifest has no runtime `@pome-sh/*` dependencies.

Check IDs are public contract values. A renamed ID can stop a criterion from binding without a type error.

License: Apache-2.0.
