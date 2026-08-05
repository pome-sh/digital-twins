# `packages/`

npm workspaces (`packages/*` in root `package.json`).

## Product twins (what we sell)

Four packages — each a shippable digital twin runtime:

| Directory | npm name |
| --- | --- |
| [`twin-github/`](./twin-github/) | `@pome-sh/twin-github` |
| [`twin-stripe/`](./twin-stripe/) | `@pome-sh/twin-stripe` |
| [`twin-slack/`](./twin-slack/) | `@pome-sh/twin-slack` |
| [`twin-gmail/`](./twin-gmail/) | `@pome-sh/twin-gmail` |

Each directory above has its own README with images, ports, and the shared contract.

## Support packages (not twins)

| Directory | npm name | Role |
| --- | --- | --- |
| [`wire/`](./wire/) | `@pome-sh/wire` | Zod schemas for recorder events, OTel spans, redaction |
| [`sdk/`](./sdk/) | `@pome-sh/sdk` | Twin authoring SDK |
| [`adapter-claude-sdk/`](./adapter-claude-sdk/) | `@pome-sh/adapter-claude-sdk` | Claude Agent SDK adapter |

The end-user **`pome` CLI** lives at repo root [`cli/`](../cli/), not under `packages/`.
