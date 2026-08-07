# GitHub twin fixtures

| Path | Role |
| --- | --- |
| `mcp-tools-list.raw.json` | The 65-tool MCP listing, verbatim. **This file IS the tool table** — `src/tools.ts` derives it (F-1325) |
| `mcp-tools-list.meta.json` | The provenance contract: substrate, endpoint, protocol version, capture date, `rawFileSha256` |
| `mcp-tools-list.canonical.json` | The same listing re-derived with its provenance attached and readable whitespace |

`src/tools.ts` declares no tool name and no description. It declares one zod
schema per tool for argument validation, and the test suite runs
`githubToolInputSchema` over each of them and demands the fixture's bytes back —
so the validator and the declaration cannot part company.

## What this listing is, and what it is not

Its substrate is `twin-code-transcription`: it was read off **this twin**, not
off GitHub. Nothing here has ever been compared to what
`api.githubcopilot.com/mcp/` serves.

**The 65 is deliberate.** F-1326's upstream golden
(`fixtures/mcp-tools-list/github.canonical.json`, at the repo root) records 44
tools for the `default` toolset that `examples/support-triage` actually points
at. That gap is real and this fixture does not close it: reporting divergence
between the two is F-1327's job, and F-1325 changed where this twin's table
lives, not what is in it. Every byte this twin serves is identical before and
after it.

Refresh these bytes only with a ruling that says what the twin should serve.
`mcp-tools-list.meta.json` carries the sha of the raw file, and
`loadMcpToolFixture` refuses to boot the twin if the two disagree.
