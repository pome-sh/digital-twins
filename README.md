<div align="center">

<img src="./assets/pome-logo.svg" alt="Pome" width="76" height="76" />

# Pome Digital Twins

**Test mode for your integrations, built for the way agents build.**

[![CI](https://github.com/pome-sh/digital-twins/actions/workflows/ci.yml/badge.svg)](https://github.com/pome-sh/digital-twins/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40pome-sh%2Fcli?label=%40pome-sh%2Fcli)](https://www.npmjs.com/package/@pome-sh/cli)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2024-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

[Documentation](https://docs.pome.sh) · [Pome](https://pome.sh) · [CLI reference](./cli/README.md)

</div>

Stateful local twins of GitHub, Stripe, Slack, Gmail and Linear. Your agent, or your own code, calls a twin the way it calls the real API, over REST or MCP, with no test account, no OAuth app and no API key. Every request lands on a tape, every write lands in state you can read back, and when it works you point the same code at the real API.

## One command

You need Node.js >= 24.

```bash
npx @pome-sh/cli@latest twin start github
```

It prints:

```text
Pome github twin listening at http://127.0.0.1:3333/s/standalone
Seed: the github twin's default (pass --seed <path>, or write one with `pome twin new-seed github`).
POME_GITHUB_REST_URL=http://127.0.0.1:3333/s/standalone
POME_GITHUB_MCP_URL=http://127.0.0.1:3333/s/standalone/mcp
POME_AUTH_TOKEN=eyJ…
Health check (no auth): curl http://127.0.0.1:3333/healthz
Ctrl-C to stop.
```

The same values are written to `.pome/twin-status.json` in the folder you ran it from, readable only by you. The twin starts seeded with one repository, `acme/api`, and one open issue, so there is something to act on before you write a seed of your own. The other four start the same way: `twin start slack`, `stripe`, `gmail`, `linear`.

## Connect your agent

Export the `POME_*` lines the twin printed, then pick your client.

Claude Code:

```bash
claude mcp add --transport http pome-github "$POME_GITHUB_MCP_URL" \
  --header "Authorization: Bearer $POME_AUTH_TOKEN"
```

Any client that reads `.mcp.json`:

```json
{
  "mcpServers": {
    "pome-github": {
      "type": "http",
      "url": "http://127.0.0.1:3333/s/standalone/mcp",
      "headers": { "Authorization": "Bearer <POME_AUTH_TOKEN>" }
    }
  }
}
```

Your own code, through the vendor's SDK:

```ts
const octokit = new Octokit({
  baseUrl: process.env.POME_GITHUB_REST_URL,
  auth: process.env.POME_AUTH_TOKEN,
});
```

Slack's `WebClient` takes `slackApiUrl`, Stripe's client takes `host`, `port` and `protocol`, Linear's takes `apiUrl`. The [connect guide](https://docs.pome.sh/docs/mcp/connect) covers Codex, Cursor and the other clients.

Then ask the agent for something small: "Open an issue in acme/api for the login page returning 500 after the deploy."

## See what it actually did

The tape is one row per request:

```bash
curl -sS -H "Authorization: Bearer $POME_AUTH_TOKEN" "$POME_GITHUB_REST_URL/_pome/events" \
  | jq -r '.[] | [.ts, (.tool // .path), .status, .fidelity, .state_mutation] | @tsv'
```

```text
2026-09-15T19:54:25.119Z	create_issue	200	semantic	true
```

`tool` or `path` is what was called, `status` is what the twin answered, `fidelity` is that route's level (see below), and `state_mutation` is `true` only when the write landed in the twin's state. A step the agent reports as done that shows `state_mutation: false` did not happen. The state itself is at `$POME_GITHUB_REST_URL/_pome/state`; `--seed` decides where it starts.

## Supported twins

Pome includes 5 digital twins and 115 MCP tools. Each twin publishes a route-by-route fidelity record, and Pome compares supported behavior with the provider APIs each day. See [status.pome.sh](https://status.pome.sh) for current results.

| Twin | MCP tools | Main API coverage | Details |
| --- | ---: | --- | --- |
| [GitHub](./packages/twin-github/) | 36 | Repositories, issues, pull requests, reviews, and merges | [Fidelity](./packages/twin-github/FIDELITY.md) |
| [Stripe](./packages/twin-stripe/) | 26 | PaymentIntents, refunds, charges, balances, events, and x402 payments | [Fidelity](./packages/twin-stripe/FIDELITY.md) |
| [Slack](./packages/twin-slack/) | 18 | Channels, messages, threads, reactions, and search | [Fidelity](./packages/twin-slack/FIDELITY.md) |
| [Gmail](./packages/twin-gmail/) | 13 | Messages, drafts, threads, labels, and uploads | [Fidelity](./packages/twin-gmail/FIDELITY.md) |
| [Linear](./packages/twin-linear/) | 22 | GraphQL, OAuth with PKCE, and signed webhooks | [Fidelity](./packages/twin-linear/FIDELITY.md) |

Each route has one of these fidelity levels:

- `semantic`: The route implements and tests provider behavior.
- `shape`: The response has the provider's shape.
- `unsupported`: The twin returns `501`.

## Swap to the real API

Three things change, and nothing else in your code should:

1. The base URL. `POME_GITHUB_REST_URL` becomes `https://api.github.com`; the MCP URL becomes the vendor's own MCP server, or yours.
2. The credential. The twin's bearer becomes a real token with real scopes.
3. Vendor-side setup the twin never asked for: OAuth apps, app installation, webhook registration. Gmail needs a Google OAuth client; the twin does not.

A green run on a twin says your integration behaves against the API as measured; it does not say the vendor will behave the same tomorrow. Run one smoke test against the real API after the swap.

## Why not mocks, why not Emulate

| | Hand-written mocks | Vercel Emulate | Pome twins |
| --- | --- | --- | --- |
| State that persists across calls | No | Yes | Yes |
| A tape of every inbound request | No | No | Yes |
| Fidelity measured against the vendor and published | No | No | Yes, daily |
| MCP surface for agents | No | No | Yes, 115 tools |

Emulate as read on 2026-09-15. It is built for application code in a dev loop, and it is Apache-2.0 like this repo.

## Going further

- Your own world: `pome twin new-seed github --out seed.json`, edit it, then `pome twin start github --seed seed.json`. A multi-twin seed is one object with a key per twin. See the [local twin guide](https://docs.pome.sh/run-a-twin).
- Graded tasks, locally: `npx @pome-sh/cli@latest init` scaffolds a project, `pome run --local tasks/01-bug-happy-path.md` records a run, `pome inspect latest` reads it. A local run records evidence and does not score.
- Scoring: `pome login` then `pome run tasks/01-bug-happy-path.md` records and grades in one hosted workflow; or score a local tape with Braintrust or LangSmith, see [`integration-examples/`](./integration-examples/shared/README.md).

## Examples

- [`agent-examples/`](./agent-examples/) contains complete agents and graded tasks.
- [`integration-examples/`](./integration-examples/) connects Pome to Braintrust and LangSmith.
- [`showcases/`](./showcases/) demonstrates individual twin behaviors without an agent or grading.
- [`skills/`](./skills/) contains skills that help coding agents author and run Pome tasks.

## Repository layout

`@pome-sh/cli` contains the CLI and the twin runtimes. Users do not install the twin packages separately.

The shared runtime provides HTTP routing, bearer authentication, MCP dispatch, recording, and SQLite state. Each twin adds its provider-specific domain behavior.

See [`packages/README.md`](./packages/README.md) for the package map. See [`CONTRACT.md`](./CONTRACT.md) for the twin runtime contract.

Contributions are welcome, and the easiest first ones are seeds and showcases. A new twin is a package that satisfies the runtime contract in [`CONTRACT.md`](./CONTRACT.md). A bug report is most useful with the tape attached.

## Status and license

Pome is in beta. CLI behavior and dependencies can change before version 1.0.

This repository uses the [Apache-2.0 license](./LICENSE).
