# Slack twin fixtures

| Path | Role |
| --- | --- |
| `mcp-tools-list.raw.json` | The 11-tool MCP listing, verbatim. **This file IS the tool table** — `src/tools.ts` derives it (F-1325) |
| `mcp-tools-list.meta.json` | The provenance contract: substrate, endpoint, protocol version, capture date, `rawFileSha256` |
| `mcp-tools-list.canonical.json` | The same listing re-derived with its provenance attached and readable whitespace |

`src/tools.ts` declares no tool name, description or annotation. It declares
one zod schema per tool for argument validation, and the test suite runs the
frozen draft-7 projection over each of them and demands the fixture's bytes
back — so the validator and the declaration cannot part company.

## What this listing is, and what it is not

Its substrate is `twin-code-transcription`. These eleven names were copied into
TypeScript from `modelcontextprotocol/servers-archived/src/slack` — an archived
reference server — by commit `6abec3c`, and **nothing has ever read Slack's own
`tools/list`**. Eight of them are believed to exist on no Slack deployment.

That is not fixed here, deliberately. `https://mcp.slack.com/mcp` is OAuth-gated
so F-1326 recorded the upstream golden as deferred
(`fixtures/mcp-tools-list/slack.status.json`, F-1329); reporting the divergence
is F-1327's job and renaming the tools is F-1330's. F-1325 moved where the table
lives, not what is in it: every byte this twin serves is identical before and
after it.

`additionalProperties: false` on every `inputSchema` is load-bearing and is
frozen here verbatim — the divergence lane depends on seeing it on the wire.

Refresh these bytes only with a ruling that says what the twin should serve.
`mcp-tools-list.meta.json` carries the sha of the raw file, and
`loadMcpToolFixture` refuses to boot the twin if the two disagree.
