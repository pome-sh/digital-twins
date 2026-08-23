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
| `mcp-tools-list.raw.json` | Live unauthenticated `tools/list` (13 tools as returned). **This file IS the tool table** — `src/mcp.ts` derives it |
| `mcp-tools-list.canonical.json` | The same listing re-derived with its provenance attached and readable whitespace |
| `mcp-tools-list.meta.json` | The provenance contract: substrate, endpoint, protocol version, capture date, `rawFileSha256`, assumed configuration |
| `mcp-initialize.raw.json` / `.meta.json` | Live `initialize` (protocolVersion) |
| `mcp-tools-call-unauth-error.raw.json` | Live unauthenticated `tools/call` error envelope |
| `mcp-tools-call.representative.json` | Schema-derived representative success call shapes |

### This IS the upstream golden — `fixtures/mcp-tools-list/gmail.*`, adopted

`mcp-tools-list.raw.json` is byte-for-byte
[`fixtures/mcp-tools-list/gmail.raw.json`](../../../fixtures/mcp-tools-list/), and the two
`rawFileSha256` values are the same number. Nothing is subtracted, nothing is re-described, and the
capture date here is the capture's own — copied by the producer, not kept by hand.

```bash
node scripts/capture-mcp-tools-list.mjs --twin gmail   # re-read Google, from the repo root
npm run fixture:mcp -w @pome-sh/twin-gmail             # adopt it here
npm run gate:mcp-fixture -w @pome-sh/twin-gmail        # --check: what CI runs
```

**It was not always so, and the cost is the reason this section exists.** These files shipped for
seventeen days as a 2026-07-20 read of an endpoint that had moved. Nothing related the two files, so
the fixture's own sha stayed green — a stale capture is internally consistent — and pome-cloud's
`mcp_diff` reported **34 findings across 11 tools**, every one of them Google's listing moving. The 2
tools it called matched were the 2 Google had left byte-identical.

**Adopting the text alone would have been the defect, not the fix.** The newer listing declares
`Message.bccRecipients`, `Label.messagesTotal`/`messagesUnread`, and a `list_labels` that returns ALL
labels (the July prose said "all user-defined") taking no page arguments at all. Serving those words
over the old handlers would advertise three capabilities the twin does not have, which is the
false-capability shape the adopt-then-move-handlers rule exists to stop, arrived at
from the other direction. `test/mcp.test.ts` holds the handlers to the listing, reading the advertised
property set out of the fixture rather than naming fields, so the next field Google adds is a red here
and not a silent absence.

What this lane still cannot see: because the served table IS the vendored capture, the only divergence
it can ever report is capture staleness. Whether the twin behaves like the tools it serves is answered
by pome-cloud's read leg and write round trip.

### Provenance notes

- `tools/list` was captured live without OAuth on **2026-08-10** against `https://gmailmcp.googleapis.com/mcp/v1`; `initialize` on 2026-07-20 against the same endpoint (protocolVersion `2025-03-26`, unchanged).
- Authenticated `tools/call` success was **not** available; representative success fixtures are reconstructed from live `outputSchema` + public docs and are marked as such.
- Gate 1 expanded the OSS launch set to the full live 13-tool listing, promoting `get_message`, `apply_sensitive_thread_label`, and `apply_sensitive_message_label` that Gate 0 treated as preview drift. All 13 survive in the adopted capture, in the same order.
