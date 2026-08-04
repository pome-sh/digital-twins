# Linear twin fixtures (Gate 0 / Gate-1 oracles)

Immutable upstream captures / freezes for `@pome-sh/twin-linear`.

| Path | Role |
| --- | --- |
| `mcp-tools-list.canonical.json` | Launch 22-tool MCP listing oracle (Gate-1 Wave 4) |
| `graphql-surface.json` | Frozen GraphQL query/mutation operation inventory |
| `linear-introspection.json` | Slice of Linear's real introspection; upstream truth for the subset guard (F-1172). Regenerate with `node scripts/regen-linear-introspection.mjs`, never by hand. A type absent from it is unguarded. |

Normal tests must not require Linear credentials. Refresh MCP schemas only with a new Gate ruling.
