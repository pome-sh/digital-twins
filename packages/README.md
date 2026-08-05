# `packages/`

npm workspaces (`packages/*` in root `package.json`). **Internal repo layout —
not an install surface.** The only thing end users install is
[`@pome-sh/cli`](../cli/) (`npx @pome-sh/cli …`), which ships the twin engine and
all five twins inside its tarball.

## Twin runtimes (internal to the CLI)

Five packages — each a digital twin runtime, booted by the CLI and by the
per-twin `dist/src/server.js` entry that pome-cloud's sandbox images run:

| Directory | Workspace name |
| --- | --- |
| [`twin-github/`](./twin-github/) | `@pome-sh/twin-github` |
| [`twin-stripe/`](./twin-stripe/) | `@pome-sh/twin-stripe` |
| [`twin-slack/`](./twin-slack/) | `@pome-sh/twin-slack` |
| [`twin-gmail/`](./twin-gmail/) | `@pome-sh/twin-gmail` |
| [`twin-linear/`](./twin-linear/) | `@pome-sh/twin-linear` |

Each directory has its own README (ports, env, runtime contract) and a
`FIDELITY.md` documenting its surface route-by-route.

## Support packages

| Directory | Workspace name | Role | Published? |
| --- | --- | --- | --- |
| [`sdk/`](./sdk/) | `@pome-sh/sdk` | Twin engine — HTTP mount, auth, recorder, MCP dispatch, SQLite | internal |
| [`shared-types/`](./shared-types/) | `@pome-sh/shared-types` | Zod schemas, recorder/task/trace types | internal |
| [`adapter-claude-sdk/`](./adapter-claude-sdk/) | `@pome-sh/adapter-claude-sdk` | Claude Agent SDK adapter for user agent code | published |

The end-user **`pome` CLI** lives at repo root [`cli/`](../cli/), not under
`packages/`.
