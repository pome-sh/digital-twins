# Gmail twin fixtures (Gate 0/1 oracles)

Immutable upstream captures for `@pome-sh/twin-gmail`. Normal tests must not require Google credentials.

## REST

| File | Purpose |
| --- | --- |
| `gmail-discovery-v1.raw.json` | Raw Gmail API v1 discovery document |
| `gmail-discovery-v1.meta.json` | Capture date + SHA-256 |
| `rest-surface.json` | Frozen launch REST method/parameter/media matrix |

## MCP

| File | Purpose |
| --- | --- |
| `mcp-tools-list.raw.json` | Live unauthenticated `tools/list` (13 tools as returned) |
| `mcp-tools-list.canonical.json` | Gate-1 launch 13-tool listing oracle (schemas from live capture) |
| `mcp-tools-list.meta.json` | Endpoint, protocol version, SHA-256, Gate-1 promotions |
| `mcp-initialize.raw.json` / `.meta.json` | Live `initialize` (protocolVersion) |
| `mcp-tools-call-unauth-error.raw.json` | Live unauthenticated `tools/call` error envelope |
| `mcp-tools-call.representative.json` | Schema-derived representative success call shapes |

### This is not the upstream golden — see `fixtures/mcp-tools-list/gmail.*` (F-1326)

Two files in this repo hold a Gmail `tools/list`. They answer different questions and only one of
them tracks the vendor:

| file | authoritative for | freshness |
| --- | --- | --- |
| `mcp-tools-list.canonical.json` (here) | the **twin's launch set** — which tools `@pome-sh/twin-gmail` implements, and the frozen Gate-1 oracle its own suite asserts against | frozen at the 2026-07-20 capture on purpose; moving it is a twin scope change |
| [`fixtures/mcp-tools-list/gmail.*`](../../../fixtures/mcp-tools-list/) | **what Google currently serves** | re-captured on demand by `scripts/capture-mcp-tools-list.mjs` |

Known delta, measured 2026-08-06: same 13 tool names in the same order, but **10 of the 13 differ**
in `description` and/or `inputSchema` (`search_threads` schema 3849→4274 chars, `create_label`
2813→3195, `list_labels` description 393→293). That is upstream drift since this file was captured,
not a twin defect. When F-1325's lane reports schema divergence on those ten, read it as **this
oracle being stale against the vendor** before touching `src/mcp.ts` — and note that re-cutting the
twin against the newer surface means updating this fixture in the same change, or `test/mcp.test.ts`
and `test/gate0-fixtures.test.mjs` will red.

### Provenance notes

- `tools/list` and `initialize` were captured live without OAuth on 2026-07-20 against `https://gmailmcp.googleapis.com/mcp/v1`.
- Authenticated `tools/call` success was **not** available; representative success fixtures are reconstructed from live `outputSchema` + public docs and are marked as such.
- Gate 1 expands the OSS launch set to the full live 13-tool listing, promoting `get_message`, `apply_sensitive_thread_label`, and `apply_sensitive_message_label` that Gate 0 treated as preview drift.
