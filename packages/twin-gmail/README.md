# `@pome-sh/twin-gmail`

`@pome-sh/twin-gmail` is a stateful digital twin of the Gmail API. It stores mailbox data in SQLite and exposes Gmail-shaped REST routes and 13 MCP tools.

This package is private implementation code. It is bundled with [`@pome-sh/cli`](../../cli/) and is not a separate install surface.

## Start the twin

```bash
npx @pome-sh/cli twin start gmail
```

The default port is `3336`. The command prints `POME_GMAIL_REST_URL`, `POME_GMAIL_MCP_URL`, `POME_AUTH_TOKEN`, and `POME_GMAIL_TOKEN`.

```bash
curl http://127.0.0.1:3336/healthz
```

## Authentication

Pome authenticates requests with a session JWT. This JWT is not a Google OAuth access token.

| Item | Value |
| --- | --- |
| Mailbox claim | `gmail_email` |
| Default mailbox | `pome-agent@pome-twin.test` |
| Token variables | `POME_AUTH_TOKEN`, `POME_GMAIL_TOKEN` |

Mailbox routes accept `me` or the exact `gmail_email` value. A request for another mailbox returns Gmail's not-found response shape.

The twin does not implement Google consent, OAuth codes, refresh tokens, JWKS, or scope issuance.

## API

Gmail REST routes are under `/s/:sid/gmail/v1/*`. Upload routes are under `/s/:sid/upload/gmail/v1/*`.

The MCP endpoint is `POST /s/:sid/mcp`. It implements stateless Streamable HTTP and exposes these tools:

```text
create_draft
list_drafts
get_thread
get_message
search_threads
label_thread
unlabel_thread
apply_sensitive_thread_label
list_labels
label_message
unlabel_message
apply_sensitive_message_label
create_label
```

The tool names, order, descriptions, and schemas come from the captured Gmail MCP listing in [`fixtures/mcp-tools-list.raw.json`](fixtures/mcp-tools-list.raw.json).

`list_labels` takes no arguments and returns system and user labels.

## Unsupported surfaces

The twin returns a clear 501 response for these named gaps:

- `users.watch` and `users.stop`
- resumable upload initiation and chunks
- filter forwarding through `action.forward`
- `processForCalendar=true` on insert or import
- `deleted=true` on insert or import

The twin does not deliver mail over external SMTP. It does not implement Pub/Sub, Calendar, Drive, Contacts, S/MIME, delegation, client UI, or HTTP batch requests.

## Fidelity and limits

[`FIDELITY.md`](FIDELITY.md) records the REST and MCP fidelity levels. [`fidelity.inventory.json`](fidelity.inventory.json) contains the machine-readable inventory.

[`REFERENCE-DIVERGENCES.md`](REFERENCE-DIVERGENCES.md) records differences from the rejected reference implementation. [`LIMITS.md`](LIMITS.md) records request and state limits.

## Contributor commands

Run package scripts from `packages/twin-gmail`:

```bash
npm run dev
npm run typecheck
npm run fidelity:parity
npm run gate:mcp-fixture
```

Run this test command from the repository root:

```bash
npx vitest run --project twin-gmail
```

To update the captured MCP listing, use the repository capture process. Do not edit the tool table in TypeScript.
