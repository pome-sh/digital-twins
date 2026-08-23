# Linear twin fixtures (Gate 0 / Gate-1 oracles)

Immutable upstream captures / freezes for `@pome-sh/twin-linear`.

| Path | Role |
| --- | --- |
| `mcp-tools-list.raw.json` | The 22-tool MCP listing, verbatim. **This file IS the tool table** — `src/mcp.ts` derives it |
| `mcp-tools-list.meta.json` | The provenance contract: substrate, endpoint, protocol version, capture date, `rawFileSha256` |
| `mcp-tools-list.canonical.json` | The same listing re-derived with its provenance attached and readable whitespace |
| `graphql-surface.json` | Frozen GraphQL query/mutation operation inventory |
| `linear-introspection.json` | Slice of Linear's real introspection; upstream truth for the subset guard. Regenerate with `node scripts/regen-linear-introspection.mjs`, never by hand. A type absent from it is unguarded. |

Normal tests must not require Linear credentials. Refresh MCP schemas only with a new Gate ruling.

## What this listing is, and what it is not

Its substrate is `twin-authored-from-vendor-docs`. The tool **names** come from
Linear's published MCP launch documentation; the **schemas are twin-owned**,
which this fixture's notes always said while its provenance field read
`source: documented_official_linear_mcp_launch_set` — a phrase that looks like a
capture. It was never one.

`https://mcp.linear.app/mcp` is OAuth-gated, so the upstream golden is recorded
as deferred (`fixtures/mcp-tools-list/linear.status.json`). Nothing here has
ever been compared to what Linear serves; re-sourcing it needs that token.
