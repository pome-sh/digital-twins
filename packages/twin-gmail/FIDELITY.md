# Gmail twin fidelity

Heat × fidelity per [`ENDPOINT-TIERS.md`](../sdk/ENDPOINT-TIERS.md). Machine-readable twin: [`fidelity.inventory.json`](fidelity.inventory.json).

## MCP launch tools (13)

| Surface | Heat | Fidelity | Justification |
| --- | --- | --- | --- |
| `create_draft` | hot | semantic | MCP:create_draft (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schem... |
| `list_drafts` | hot | semantic | MCP:list_drafts (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schema... |
| `get_thread` | hot | semantic | MCP:get_thread (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schemas... |
| `get_message` | hot | semantic | MCP:get_message (Gate-1 Developer Preview promotion); TC:inbox-triage. Live capture schemas frozen in fixtures/mcp-to... |
| `search_threads` | hot | semantic | MCP:search_threads (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture sch... |
| `label_thread` | hot | semantic | MCP:label_thread (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schem... |
| `unlabel_thread` | hot | semantic | MCP:unlabel_thread (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture sch... |
| `apply_sensitive_thread_label` | hot | semantic | MCP:apply_sensitive_thread_label (Gate-1 Developer Preview promotion); TC:cleanup\|label-triage. Applies TRASH/SPAM a... |
| `list_labels` | hot | semantic | MCP:list_labels (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schema... |
| `label_message` | hot | semantic | MCP:label_message (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture sche... |
| `unlabel_message` | hot | semantic | MCP:unlabel_message (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture sc... |
| `apply_sensitive_message_label` | hot | semantic | MCP:apply_sensitive_message_label (Gate-1 Developer Preview promotion); TC:cleanup\|label-triage. Applies TRASH/SPAM ... |
| `create_label` | hot | semantic | MCP:create_label (vendor default Gmail MCP toolset); TC:inbox-triage\|compose-draft\|label-triage. Live capture schem... |

## REST (semantic)

In-scope Gmail v1 REST rows share the deterministic domain with MCP. Full list: [`fidelity.inventory.json`](fidelity.inventory.json) (`rest[]`, fidelity `semantic`).

## Named cold / unsupported (loud 501)

| Surface | Heat | Fidelity | Justification |
| --- | --- | --- | --- |
| `POST /resumable/upload/gmail/v1/users/{userId}/messages/send (resumable)` | cold | unsupported | PS: resumable upload for users.messages.send declared by discovery but explicitly unsupported in launch — loud 501, n... |
| `POST /resumable/upload/gmail/v1/users/{userId}/messages (resumable)` | cold | unsupported | PS: resumable upload for users.messages.insert declared by discovery but explicitly unsupported in launch — loud 501,... |
| `POST /resumable/upload/gmail/v1/users/{userId}/messages/import (resumable)` | cold | unsupported | PS: resumable upload for users.messages.import declared by discovery but explicitly unsupported in launch — loud 501,... |
| `POST /resumable/upload/gmail/v1/users/{userId}/drafts (resumable)` | cold | unsupported | PS: resumable upload for users.drafts.create declared by discovery but explicitly unsupported in launch — loud 501, n... |
| `PUT /resumable/upload/gmail/v1/users/{userId}/drafts/{id} (resumable)` | cold | unsupported | PS: resumable upload for users.drafts.update declared by discovery but explicitly unsupported in launch — loud 501, n... |
| `POST /resumable/upload/gmail/v1/users/{userId}/drafts/send (resumable)` | cold | unsupported | PS: resumable upload for users.drafts.send declared by discovery but explicitly unsupported in launch — loud 501, no ... |
| `POST /gmail/v1/users/{userId}/watch` | cold | unsupported | PS: named gap — Pub/Sub watch/stop out of launch scope. Must return loud 501; never fake successful registration. Dis... |
| `POST /gmail/v1/users/{userId}/stop` | cold | unsupported | PS: named gap — Pub/Sub watch/stop out of launch scope. Must return loud 501; never fake successful registration. Dis... |

## Tier-mismatch ledger

_(empty)_

## Notes

- Inventory `gaps[]` is empty: measured unsupported surfaces live in `tools[]` / `rest[]` with `fidelity: unsupported`.
- Do not fake success for watch/stop, resumable upload, or filter `action.forward`.
- Gate 1 expands the MCP launch set from 10 → 13 to match the live Developer Preview `tools/list`.

## Declared input surface (F-1179)

Fidelity is not only about what a surface *answers*; it is also about what it
*accepts*. An agent can call this twin with a parameter the real vendor rejects,
or omit one the vendor requires, and the response shape can be identical either
way — so the output comparison cannot see it. That is the same class of gap as
F-1166, which was only caught because a write round-trip happened to read back a
field nobody had mentioned.

So each route declares its inputs, and **the declaration is the thing the handler
validates against** — not a description of it. `declareRouteInputs()`
([`packages/sdk/src/route-inputs.ts`](../sdk/src/route-inputs.ts)) returns one
object carrying both the machine-readable surface and the `parse()` a handler
receives its values from. A handler is handed no request object to read around
the declaration with, and
[`scripts/lint-route-input-declarations.mjs`](../../scripts/lint-route-input-declarations.mjs)
fails the build if any module a route registrar reaches reads one imperatively.

**This twin declares 205 inputs across 60 published surfaces**
(86 path, 48 query, 71 body), 99 of them required. Each carries its name, location,
requiredness and best-effort type, all *derived from the schemas that validate* —
requiredness by asking the validator whether the input may be absent, and type by
way of JSON Schema. Nothing here is hand-written, so nothing here can drift from
the handler.

This twin had no zod across any of its five `rest-routes*.ts` modules; names existed only at
call sites via `stringField(body, "raw")`-style helpers. All 60 routes are declared now, and
`src/rest-upload.ts` is deleted — its multipart splitting is the shared mechanism's
`bodyEncoding: "media"`, so a JSON resource, a `multipart/related` metadata+media pair and a
bare MIME body all land on the same declared input names.

Google's standard query parameters (`alt`, `fields`, `key`, `prettyPrint`, `quotaUser`,
`userIp`, `oauth_token`, `access_token`, `callback`, `$.xgafv`) are deliberately NOT declared:
the real `@googleapis/gmail` client was instrumented and sends none of them. The same capture
found two body fields it DOES send and the twin silently swallowed —
`labelListVisibility` and `messageListVisibility` on `POST .../labels` — which are declared.

The published artifact is
[`route-inputs.json`](route-inputs.json), regenerated by
`npm run emit:route-inputs` and byte-compared in CI by
`npm run gate:route-inputs`. It is read by pome-cloud's declared-fidelity lane
through the checkout seam it already has, which is what turns 1,130
vendor-declared inputs on matched surfaces from `not-compared` into a real
two-way comparison — and makes `missingRequired` live. Surfaces with no declared
inputs are omitted rather than published with an empty list: comparing nothing
against nothing would render as a match nobody measured.

### Undeclared inputs: `refuse` (F-1372, affirmed)

**Gmail refuses a query parameter it does not know, so the strict default
stays.** Gmail is served through Google's HTTP-to-gRPC transcoder — the 401 it
gives an anonymous caller names its backend method,
`caribou.api.proto.MailboxService` (measured 2026-08-09) — and that layer binds
each query parameter to a field of the request proto, answering 400
`INVALID_ARGUMENT` (`Cannot bind query parameter. Field 'x' could not be found
in request message.`) for one that maps to no field.

Affirmed on published behaviour rather than measured directly: Google checks
credentials before it binds parameters, so an anonymous probe answers 401
whatever it carries, and reaching the binding layer needs a real OAuth token for
a real mailbox. The probes, and what they could not establish, are recorded in
[`docs/undeclared-route-inputs.md`](../../docs/undeclared-route-inputs.md).
