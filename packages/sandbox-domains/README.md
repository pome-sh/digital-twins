# `@pome-sh/sandbox-domains`

`@pome-sh/sandbox-domains` exports the in-process domain layer for each Pome digital twin. It includes domain objects, SQLite openers, seed parsers, and check declarations. It creates no sandbox and exposes no Hono app, HTTP routes, or MCP tool table.

Use [`@pome-sh/checks`](../checks/) if you need declarations without runtime domain code.

## Install

```bash
npm install @pome-sh/sandbox-domains zod
```

Node.js 24 or later is required because the package uses `node:sqlite`. `zod` is a peer dependency and is not bundled.

## Use

Use a twin subpath when the twin is known:

```ts
import {
  GitHubDomain,
  openGitHubCloneDatabase,
  parseSeed,
} from "@pome-sh/sandbox-domains/github";

const db = openGitHubCloneDatabase(":memory:");
const domain = new GitHubDomain(db);
const seed = parseSeed(mySeed);
domain.seed(seed);
```

Use the root map when the twin name is dynamic:

```ts
import { SANDBOX_DOMAINS } from "@pome-sh/sandbox-domains";

const { Domain, openDatabase } = SANDBOX_DOMAINS[twinName];
```

## Entries

| Entry | Main exports |
| --- | --- |
| `.` | Prefixed exports for all twins, `SANDBOX_DOMAINS`, and `SANDBOX_DOMAIN_NAMES` |
| `./github` | `GitHubDomain`, `openGitHubCloneDatabase`, `parseSeed`, `GITHUB_CHECKS` |
| `./gmail` | `GmailDomain`, `openGmailTwinDatabase`, `parseSeed`, `GMAIL_CHECKS` |
| `./linear` | `LinearDomain`, `openLinearTwinDatabase`, `parseSeed`, `LINEAR_CHECKS` |
| `./slack` | `SlackDomain`, `openSlackTwinDatabase`, `parseSeed`, `SLACK_CHECKS` |
| `./stripe` | `StripeDomain`, `openTwinStripeDatabase`, `parseSeed`, `applySeed`, `STRIPE_CHECKS` |
| `./server` | `toTwinHttpEventRow` and the `RecorderEvent` type |

The root barrel prefixes names that would otherwise conflict. Each twin subpath keeps the original names.

## Packaging

The build bundles all internal `@pome-sh/*` code. The published manifest has no runtime `@pome-sh/*` dependencies.

The package keeps `zod` external. It declares `hono`, `@octokit/openapi-types`, and `stripe` as dependencies because shipped type surfaces refer to them.

License: Apache-2.0.
