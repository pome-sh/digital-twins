# Stripe twin fixtures

| Path | Role |
| --- | --- |
| `mcp-tools-list.raw.json` | The 26-tool MCP listing, verbatim. **This file IS the tool table** — `src/tools.ts` derives it (F-1325) |
| `mcp-tools-list.meta.json` | The provenance contract: substrate, endpoint, protocol version, capture date, `rawFileSha256` |
| `mcp-tools-list.canonical.json` | The same listing re-derived with its provenance attached and readable whitespace |

`src/tools.ts` declares no tool name and no description. It declares one zod
schema per tool for argument validation, and the test suite runs
`stripeToolInputSchema` over each of them and demands the fixture's bytes back —
so the validator and the declaration cannot part company.

## What this listing is, and what it is not

Its substrate is `twin-code-transcription`: it was read off **this twin**, not
off Stripe, and it has never been compared to anything.

There is currently nothing to compare it to. `@stripe/mcp` is a proxy that
declares no tools of its own, and the served listing is a function of the
caller's Restricted API Key rather than of the deployment — so F-1326 recorded
stripe as `not-captured` (`fixtures/mcp-tools-list/stripe.status.json`) instead
of inventing a deployment-invariant table. A consumer must read this twin as
`not-compared`, never as full coverage.

Refresh these bytes only with a ruling that says what the twin should serve.
`mcp-tools-list.meta.json` carries the sha of the raw file, and
`loadMcpToolFixture` refuses to boot the twin if the two disagree.
