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

Local, stateful twins of GitHub, Slack, Stripe, Gmail and Linear. Your agent, or your own code, calls a twin exactly as it calls the real API, over REST or MCP, with no test account, no OAuth app and no API key. Every request lands on a tape, so a step that was only claimed shows up as one.

## One command

You need Node.js 24 or newer.

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

Connect your agent (pick one):

Claude Code:
  claude mcp add --transport http pome-github http://127.0.0.1:3333/s/standalone/mcp --header "Authorization: Bearer eyJ…"
…
```

It goes on with the same for Codex (`~/.codex/config.toml`), for `.mcp.json`, and for the vendor's own SDK. The twin starts with one repository, `acme/api`, and one open issue, so there is something to act on before you write a seed of your own. Several twins at once is one command, `twin start github slack linear`, with one connect block for all of them. The values are also written to `.pome/twin-status.json` in the folder you ran it from, readable only by you.

## Connect your agent

Paste the block for your client, exactly as printed. Claude Code takes the one-liner. Codex takes the table. Any client that reads `.mcp.json` takes the stanza, with the token coming from `POME_AUTH_TOKEN` in your shell, so run the printed `export` line first. Your own code takes the SDK line: GitHub's Octokit, Slack's `WebClient`, Stripe's client, googleapis for Gmail and Linear's SDK each get theirs. The [connect guide](https://docs.pome.sh/docs/mcp/connect) covers Cursor and the other clients.

Then ask the agent for something small: "Open an issue in acme/api for the login page returning 500 after the deploy."

## See what it actually did

```bash
npx @pome-sh/cli@latest twin tape --diff
```

```text
github twin at http://127.0.0.1:3333/s/standalone — 3 requests

TIME          REQUEST            STATUS  FIDELITY  STATE
13:35:30.474  list_issues        200     semantic  read
13:35:30.485  create_issue       200     semantic  changed
13:35:30.495  add_issue_comment  404     semantic  no change  ← write did not land (404); error: Issue not found

3 requests: 1 changed state · 1 write did not land · 1 read

State diff since boot (seed → now):
  repositories                   ~1 changed: acme/api
  repositories[acme/api].issues  +1 added: #2
```

One line per request. `changed` means the write landed in the twin's state. `no change` on a write is a step the agent may have reported as done that did not happen. `unsupported` is a route the twin does not model, answered with `501` rather than a guess. The diff is what the run left behind, against the state the twin booted with. `--json` prints the same as one object.

## Run it in CI

The same command works in a GitHub Actions job. Start the twin, wait for it, hand its address and token to your tests, and print the tape at the end:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
- name: Start the GitHub twin
  run: |
    npx @pome-sh/cli@latest twin start github > twin.log 2>&1 &
    for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3333/healthz >/dev/null 2>&1 && break; sleep 1; done
    echo "POME_GITHUB_REST_URL=$(jq -r .rest_url .pome/twin-status.json)" >> "$GITHUB_ENV"
    echo "POME_GITHUB_MCP_URL=$(jq -r .mcp_url .pome/twin-status.json)" >> "$GITHUB_ENV"
    echo "POME_AUTH_TOKEN=$(jq -r .auth_token .pome/twin-status.json)" >> "$GITHUB_ENV"
- run: npm test
- name: What the tests did
  if: always()
  run: npx @pome-sh/cli@latest twin tape --diff
```

No account and no secret in the repository: the token is minted by the twin on the runner and dies with it. Your tests read `POME_GITHUB_REST_URL` and `POME_AUTH_TOKEN` the way they would read a real base URL and token.

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
| A tape of every request your code made | No | No | Yes |
| Fidelity measured against the vendor and published | No | No | Yes, daily |
| MCP surface for agents | No | No | Yes, 115 tools |

Emulate as read on 2026-09-16. It is built for application code in a dev loop, and it is Apache-2.0 like this repo.

## Going further

- Your own world: `pome twin new-seed github --out seed.json`, edit it, then `pome twin start github --seed seed.json`. Several twins from one file: `pome twin new-seed github slack --out seed.json`, then `pome twin start github slack --seed seed.json`. See the [local twin guide](https://docs.pome.sh/run-a-twin).
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

Contributions are welcome, and the easiest first ones are seeds and showcases; [`CONTRIBUTING.md`](./CONTRIBUTING.md) says where to start and what a pull request needs. A new twin is a package that satisfies the runtime contract in [`CONTRACT.md`](./CONTRACT.md). A bug report is most useful with the tape attached (`pome twin tape --json`); a security problem goes to [`SECURITY.md`](./SECURITY.md), not to a public issue.

## Telemetry

The CLI sends one anonymous usage event per day, at most: a random id it minted once and keeps in `~/.pome/telemetry.json`, the CLI version, the OS, the Node major, and the command's name (`twin start`, `init`). Never an argument, a path, a repo name, a seed, a token or anything from a tape. The first send prints a one-line notice. Turn it off with `POME_TELEMETRY=0`; `DO_NOT_TRACK=1` is honoured too, and nothing is sent when `CI` is set or from a build made without an ingest key. The code is [`cli/src/cli/usageTick.ts`](./cli/src/cli/usageTick.ts).

## Status and license

Pome is in beta. CLI behavior and dependencies can change before version 1.0.

This repository uses the [Apache-2.0 license](./LICENSE).
