# Stripe twin fixtures

| Path | Role |
| --- | --- |
| `mcp-tools-list.raw.json` | The 26-tool MCP listing, verbatim. **This file IS the tool table** — `src/tools.ts` derives it |
| `mcp-tools-list.meta.json` | The provenance contract: substrate, endpoint, protocol version, capture date, `rawFileSha256` |
| `mcp-tools-list.canonical.json` | The same listing re-derived with its provenance attached and readable whitespace |

`src/tools.ts` declares no tool name and no description. It declares one zod
schema per tool for argument validation, and the test suite runs
`stripeToolInputSchema` over each of them and demands the fixture's bytes back —
so the validator and the declaration cannot part company.

## What this listing is, and what it is not

Its substrate is `twin-code-transcription`: the bytes were read off **this
twin**, not off Stripe. That is a claim about where the content came from, and
it stays true — but it no longer means nothing has ever been compared to it.

There is now something to compare it to, and the overlap is thin for a reason.
A golden was captured live off `https://mcp.stripe.com` on 2026-08-10
(`fixtures/mcp-tools-list/stripe.meta.json` — `live-wire-oauth`, 11 tools), and
This table was read against it: of the 36 union names exactly **1 is
shared** (`create_refund`), `twin_only=25`, `upstream_only=10`.

One of 36 is the honest measurement, not a failed comparison. `@stripe/mcp` is
a proxy that declares no tools of its own, and the served listing is a function
of the caller's Restricted API Key rather than of the deployment — so that
golden declares its completeness `credential-scoped` and its unguarded
direction `BOTH`. A name this twin serves that the golden lacks is therefore
not evidence Stripe lacks it. A consumer must read the 25 as `not-compared`,
never as twin-only divergence and never as full coverage.

The one compared name is load-bearing: `create_refund.reason` was narrowed
to the enum that golden carries.

Refresh these bytes only with a ruling that says what the twin should serve.
`mcp-tools-list.meta.json` carries the sha of the raw file, and
`loadMcpToolFixture` refuses to boot the twin if the two disagree.
