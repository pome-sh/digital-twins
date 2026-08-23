# GitHub twin fixtures

| Path | Role |
| --- | --- |
| `mcp-tools-list.raw.json` | The 65-tool MCP listing, verbatim. **This file IS the tool table** — `src/tools.ts` derives it |
| `mcp-tools-list.meta.json` | The provenance contract: substrate, endpoint, protocol version, capture date, `rawFileSha256` |
| `mcp-tools-list.canonical.json` | The same listing re-derived with its provenance attached and readable whitespace |
| `operation-docs.raw.json` | Which GitHub operation each of the twin's 66 REST surfaces and 36 MCP tools stands for, and the `documentation_url` GitHub puts on that operation's errors |
| `operation-docs.meta.json` | Its provenance: the pinned `github/rest-api-description` commit and spec SHA-256, `rawFileSha256`, and the reason for every door that names no operation |

## `operation-docs.*` — a slice, not a dump

Every url in it is `externalDocs.url` out of GitHub's published OpenAPI
description; none is typed from the docs site, because the anchors
(`/rest/repos/contents#…`, `/rest/branches/branches#…`) are not derivable from
the path. The description is 12.9 MB over 808 paths and is **not committed** —
`scripts/vendor-operation-docs.ts` pins it by commit and SHA-256 and derives the
63 operations this twin's doors actually need.

```bash
npm run vendor:operation-docs -w @pome-sh/twin-github -- --fetch   # re-derive
npm run gate:operation-docs -w @pome-sh/twin-github                # --check: what CI runs
```

`--check` needs no description: it re-derives every pairing the producer decides,
demands the REST keys be exactly the surfaces the twin mounts and the MCP keys
exactly the tools it serves, and checks each url against its own committed
`category`/`subcategory`. Hand it `--spec <path>` and it re-derives the urls too.

`src/tools.ts` declares no tool name and no description. It declares one zod
schema per tool for argument validation, and the test suite runs
`githubToolInputSchema` over each of them and demands the fixture's bytes back —
so the validator and the declaration cannot part company.

## What this listing is, and what it is not

Its substrate is `twin-code-transcription`: it was read off **this twin**, not
off GitHub. Nothing here has ever been compared to what
`api.githubcopilot.com/mcp/` serves.

**The 65 is deliberate.** The upstream golden
(`fixtures/mcp-tools-list/github.canonical.json`, at the repo root) records 44
tools for the `default` toolset that `agent-examples/support-triage` actually points
at. That gap is real and this fixture does not close it: reporting divergence
between the two is the staleness lane's job, and the change that moved where
this twin's table lives did not change what is in it. Every byte this twin
serves is identical before and after it.

Refresh these bytes only with a ruling that says what the twin should serve.
`mcp-tools-list.meta.json` carries the sha of the raw file, and
`loadMcpToolFixture` refuses to boot the twin if the two disagree.
