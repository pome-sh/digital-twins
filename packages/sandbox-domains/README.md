# @pome-sh/sandbox-domains

Pome's twin **domain layer**: each digital twin's domain object, its SQLite
opener, its seed parser and its declared check vocabulary — the in-process
runtime a bound check reads.

Runtime, not server. There is no Hono app, no route table and no MCP tool
listing here; the standalone twin's channel is a signed container image. If you
want the check *declarations* on their own, that is
[`@pome-sh/checks`](../checks).

> **Sandbox, twin — same thing, mid-rename.** The workspace packages this wraps
> are still `@pome-sh/twin-*` and the docs around it still say *twin*. This
> package is named for where the vocabulary is going, because an npm name is
> permanent and an internal symbol is not. Symbols re-exported from elsewhere
> (`toTwinHttpEventRow`, `TwinStripeDatabase`) keep their upstream spelling.

```bash
npm install @pome-sh/sandbox-domains zod
```

`zod` is a **peer** dependency on purpose — see *One zod* below. Node ≥ 24 is
required (`node:sqlite`).

## Use

```ts
import { GitHubDomain, openGitHubCloneDatabase, parseSeed } from "@pome-sh/sandbox-domains/github";

const db = openGitHubCloneDatabase(":memory:");
const domain = new GitHubDomain(db);
const seed = parseSeed(mySeed);
```

Every twin names its seed parser `parseSeed`, so the barrel prefixes them and
the per-twin subpaths keep the plain name:

```ts
import { SANDBOX_DOMAINS, parseGitHubSeed, parseStripeSeed } from "@pome-sh/sandbox-domains";

const { Domain, openDatabase } = SANDBOX_DOMAINS[twinName];
```

### Entries

| entry | exports |
| -- | -- |
| `.` | all five, per-twin prefixed, plus `SANDBOX_DOMAINS` / `SANDBOX_DOMAIN_NAMES` |
| `./github` | `GitHubDomain`, `openGitHubCloneDatabase`, `parseSeed`, `GITHUB_CHECKS` |
| `./gmail` | `GmailDomain`, `openGmailTwinDatabase`, `parseSeed`, `GMAIL_CHECKS` |
| `./linear` | `LinearDomain`, `openLinearTwinDatabase`, `parseSeed`, `LINEAR_CHECKS` |
| `./slack` | `SlackDomain`, `openSlackTwinDatabase`, `parseSeed`, `SLACK_CHECKS` |
| `./stripe` | `StripeDomain`, `openTwinStripeDatabase`, `parseSeed`, `applySeed`, `STRIPE_CHECKS` |
| `./server` | `toTwinHttpEventRow` — the unified `TwinHttpEvent` tape-row wrapper |

## Why this package exists

Pome grades a `[code]` criterion by resolving it to a check *declaration* and
evaluating that declaration against twin *state*. Those are two artifacts, in
two layers, and a grader needs both to agree: a criterion that binds to a
declaration whose runtime cannot produce the state it describes scores nothing
and says so quietly.

The five `@pome-sh/twin-*` packages are `private: true` and stay that way —
publishing them had put two copies of the same zod schemas in one process, which
breaks `instanceof` and makes parsed results stop being interchangeable
(F-942). `@pome-sh/checks` restored a path for the declarations by *bundling*
them rather than depending on them. This package does the same for the runtime,
so both halves publish from the same commit on the same lane and agree by
construction rather than by anyone remembering.

## One zod

`zod` is a `peerDependency` and is never bundled. The seed schemas are zod
values, and a consumer hands `parseSeed` a seed it built with its own zod. Two
copies of zod means two schema identities in one process — `instanceof` fails,
`.parse()` results stop being interchangeable — and unlike a missing dependency
it works just well enough to be found later. A peer dependency is what
guarantees your graph holds exactly one.

## What is bundled and what is not

Every `@pome-sh/*` package is inlined, so this tarball declares **no**
`@pome-sh/*` dependency and installs without access to a private registry.

`hono` and the two upstream shape anchors (`@octokit/openapi-types`, `stripe`)
are ordinary declared dependencies: hono because the domains arrive through
their twins' package roots, and the anchors because they appear in the shipped
declarations' method signatures. They carry no runtime code you call.

`scripts/ci/check-sandbox-domains-tarball.mjs` asserts all of it against the packed
artifact — every bare specifier in the shipped bytes is a declared dependency,
every declared dependency is imported, `node:sqlite` is present exactly once,
zod is external, and every entry above exports what the table says.

## License

Apache-2.0
