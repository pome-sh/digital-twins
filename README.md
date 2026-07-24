<div align="center">

<img src="./assets/pome-logo.svg" alt="Pome" width="76" height="76" />

# Pome Digital Twins

**Simulation testing infrastructure for AI agents.**
Stateful, local digital twins of the APIs your agent calls — GitHub, Stripe, Slack, Gmail, and Linear.

[![CI](https://github.com/pome-sh/pome-twins/actions/workflows/ci.yml/badge.svg)](https://github.com/pome-sh/pome-twins/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40pome-sh%2Fcli?label=%40pome-sh%2Fcli)](https://www.npmjs.com/package/@pome-sh/cli)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2024-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

[Docs](https://docs.pome.sh) · [Platform](https://pome.sh) · [CLI reference](./cli/README.md)

</div>

## What is Pome?

A **digital twin** is a local emulation of a production API. It answers the exact
same **REST, GraphQL, and MCP calls** your AI agent makes in production, backed by a
real SQLite database — so every run is stateful, deterministic, and resettable.
Use it to test and evaluate agents against 137 MCP tools without touching live
infrastructure, rate limits, or shared sandbox accounts.

Every route and tool is tiered — `semantic` (real, tested behavior), `shape`
(faithful response shape), or a loud `501`. A twin never silently fakes success.

## The twins

Five twins, **137 MCP tools** in total. Each documents its surface route-by-route in its `FIDELITY.md`.

| Twin | MCP tools | API surface | |
| --- | --- | --- | --- |
| ![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white) [`twin-github`](./packages/twin-github/) | 65 (63 semantic) | 62 REST routes — repos, issues, PRs, reviews, merges (push-access gated) | [FIDELITY](./packages/twin-github/FIDELITY.md) |
| ![Stripe](https://img.shields.io/badge/Stripe-635BFF?logo=stripe&logoColor=white) [`twin-stripe`](./packages/twin-stripe/) | 26 (all semantic) | 43 REST routes — card + x402 crypto PaymentIntents, refunds, charges, balance, events | [FIDELITY](./packages/twin-stripe/FIDELITY.md) |
| ![Slack](https://img.shields.io/badge/Slack-4A154B?logo=slack&logoColor=white) [`twin-slack`](./packages/twin-slack/) | 11 (all semantic) | 50 REST routes — channels, messages, threads, reactions, search | [FIDELITY](./packages/twin-slack/FIDELITY.md) |
| ![Gmail](https://img.shields.io/badge/Gmail-EA4335?logo=gmail&logoColor=white) [`twin-gmail`](./packages/twin-gmail/) | 13 | Frozen Gmail v1 REST — messages, drafts, threads, labels, uploads | [FIDELITY](./packages/twin-gmail/FIDELITY.md) |
| ![Linear](https://img.shields.io/badge/Linear-5E6AD2?logo=linear&logoColor=white) [`twin-linear`](./packages/twin-linear/) | 22 | GraphQL + OAuth (PKCE) + signed webhooks — the first GraphQL twin | [FIDELITY](./packages/twin-linear/FIDELITY.md) |

## Quickstart

Prerequisites: [Node.js ≥ 24](https://nodejs.org/). No install, no clone.

```bash
npx @pome-sh/cli init                                  # scaffold tasks + example agent
npx @pome-sh/cli run --local scenarios/01-bug-happy-path.md   # boots a twin, runs it, records a trace
npx @pome-sh/cli inspect latest                        # read the trace back
```

Or start a standalone twin to point your own agent at it:

```bash
npx @pome-sh/cli twin start github    # http://127.0.0.1:3333 — prints MCP URL + POME_AUTH_TOKEN
```

For a persistent `pome` command: `npm install -g @pome-sh/cli`.

## Running an agent

`pome run --local` records a run — the trace plus before/after state — for you to
read back. The CLI is **capture-only**: it never scores locally. Evaluation
against a task's pass/fail criteria is a hosted feature; `pome eval` uploads a
captured trace for a cloud verdict.

```bash
pome run --local scenarios/      # self-hosted: records a raw trace
pome eval runs/<task>/<run-id>   # uploads it for a cloud verdict
pome login && pome run scenarios/  # hosted: records + evaluates in one go
```

The bundled task library includes GitHub, Stripe, Slack, Gmail, and Linear flows —
several **adversarial** (identity spoofing, prompt injection, merging a backdoored
PR, fabricating green CI). Browse with `pome scenarios`. Four worked example agents
live under [`examples/`](./examples/).

## Build your own twin

The five twins are thin domain plugins on [`@pome-sh/sdk`](./packages/sdk/). The
engine supplies HTTP mounting, auth, the trace recorder, MCP dispatch, SQLite
state, and the admin reset gate — so a twin is just its domain logic and tools:

```ts
import { defineTwin } from "@pome-sh/sdk";
import { serve } from "@pome-sh/sdk/server";

const twin = defineTwin({
  id: "my-service",
  version: "0.1.0",
  domain: ({ db, seed }) => createMyDomain(db, seed),
  tools: [/* ToolSpec[] — name, zod schema, handler */],
});

await serve(twin, { port: 3333 });
```

Every twin honors the frozen [`CONTRACT.md`](./CONTRACT.md) runtime contract. Start
from the [SDK README](./packages/sdk/README.md).

---

> ⚠️ Pome is in **Beta** — the CLI and dependencies may change while the API
> stabilizes toward v1. Questions or suggestions: `founders@pome.sh`.

Full documentation lives at [docs.pome.sh](https://docs.pome.sh). Licensed [Apache-2.0](./LICENSE).
