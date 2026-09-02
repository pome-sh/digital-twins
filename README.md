<div align="center">

<img src="./assets/pome-logo.svg" alt="Pome" width="76" height="76" />

# Pome digital twins

**Test AI agents without changing live accounts.**

[![CI](https://github.com/pome-sh/digital-twins/actions/workflows/ci.yml/badge.svg)](https://github.com/pome-sh/digital-twins/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40pome-sh%2Fcli?label=%40pome-sh%2Fcli)](https://www.npmjs.com/package/@pome-sh/cli)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2024-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

[Documentation](https://docs.pome.sh) · [Pome](https://pome.sh) · [CLI reference](./cli/README.md)

</div>

## What is Pome?

A digital twin is a stateful emulation of a real API. Each twin uses SQLite and starts from a known state.

Your agent sends the same types of REST, GraphQL, and MCP requests that it sends in production. The twin records each request and state change on a tape that the agent does not control.

You can reset the state and run the same task again. The starting state and deterministic checks stay fixed while the agent remains the variable.

Each route has one of these fidelity levels:

- `semantic`: The route implements and tests provider behavior.
- `shape`: The response has the provider's shape, but behavior is limited.
- `unsupported`: The twin returns `501` instead of reporting false success.

## Supported twins

Pome includes 5 digital twins with 115 MCP tools and 263 REST and GraphQL surfaces.

| Twin | MCP tools | Main API coverage | Details |
| --- | ---: | --- | --- |
| [GitHub](./packages/twin-github/) | 36 | Repositories, issues, pull requests, reviews, and merges | [Fidelity](./packages/twin-github/FIDELITY.md) |
| [Stripe](./packages/twin-stripe/) | 26 | PaymentIntents, refunds, charges, balances, events, and x402 payments | [Fidelity](./packages/twin-stripe/FIDELITY.md) |
| [Slack](./packages/twin-slack/) | 18 | Channels, messages, threads, reactions, and search | [Fidelity](./packages/twin-slack/FIDELITY.md) |
| [Gmail](./packages/twin-gmail/) | 13 | Messages, drafts, threads, labels, and uploads | [Fidelity](./packages/twin-gmail/FIDELITY.md) |
| [Linear](./packages/twin-linear/) | 22 | GraphQL, OAuth with PKCE, and signed webhooks | [Fidelity](./packages/twin-linear/FIDELITY.md) |

Pome compares supported behavior with the provider APIs each day. See [status.pome.sh](https://status.pome.sh) for current results.

## Quick start

You need Node.js 24 or later. Local runs do not require a Pome account or a provider account.

Run these commands in an empty directory:

```bash
npx @pome-sh/cli@latest init
npx @pome-sh/cli@latest run --local tasks/01-bug-happy-path.md
npx @pome-sh/cli@latest inspect latest
```

This command starts a local twin, runs the example agent, and records the trace and state. It does not grade the run.

Install the CLI globally if you want to use the `pome` command:

```bash
npm install -g @pome-sh/cli
```

## Start one twin

Start a local GitHub twin in the foreground:

```bash
npx @pome-sh/cli@latest twin start github
```

The command prints the REST URL, MCP URL, and bearer token. It also writes these values to `.pome/twin-status.json`.

Create a seed when you need a different starting state:

```bash
pome twin new-seed github --out seed.json
pome twin start github --seed seed.json
```

A seed replaces the default state. It does not merge with the default state.

A single-twin seed contains that twin's fields. A multi-twin seed uses an object with one key for each twin.

See the [local twin guide](https://docs.pome.sh/run-a-twin) for complete examples.

## Run and evaluate an agent

Local Pome records evidence but does not assign a score:

```bash
pome run --local tasks/example.md
pome inspect latest
```

You can score the recorded tape with your evaluator. You can also upload the run for a hosted Pome verdict:

```bash
pome login
pome eval runs/<task>/<run-id>
```

A hosted run records and grades in one workflow:

```bash
pome login
pome run tasks/example.md
```

A task defines the starting state, agent instruction, and success criteria. `[code]` criteria use deterministic checks. `[model]` criteria provide optional model-based interpretation.

Use `pome tasks` to browse the bundled task library.

## Examples

- [`agent-examples/`](./agent-examples/) contains complete agents and graded tasks.
- [`integration-examples/`](./integration-examples/) connects Pome to Braintrust and LangSmith.
- [`showcases/`](./showcases/) demonstrates individual twin behaviors without an agent or grading.
- [`skills/`](./skills/) contains skills that help coding agents author and run Pome tasks.

## Repository layout

`@pome-sh/cli` contains the CLI and 5 twin runtimes with 115 MCP tools. Users do not install the twin packages separately.

The shared runtime provides HTTP routing, bearer authentication, MCP dispatch, recording, and SQLite state. Each twin adds its provider-specific domain behavior.

See [`packages/README.md`](./packages/README.md) for the package map. See [`CONTRACT.md`](./CONTRACT.md) for the twin runtime contract.

Third-party twin authoring is not a supported product surface. Contact `founders@pome.sh` if you need this capability.

## Status and license

Pome is in beta. CLI behavior and dependencies can change before version 1.0.

This repository uses the [Apache-2.0 license](./LICENSE).
