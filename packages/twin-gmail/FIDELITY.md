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

## Known divergences from real Gmail

These are the places where the twin's answer differs from what real Gmail
answered. Each bullet has a structured entry in the Twin Fidelity Watch's
`known-divergences/gmail.yaml` (maintained in pome-cloud); a lint keeps the two
1:1.

**These numbers are stable identifiers, not positions**, on the same convention
twin-github's list uses: a retired divergence leaves its number behind rather
than renumbering the ones after it, so a gap here means a retirement. The lint
matches on each bullet's bold title and never on its number.

Unlike the other four twins' lists, every bullet below was **measured, not read
off the twin's source**. The upstream half is a real human-attended capture
against a throwaway Gmail mailbox on 2026-08-11 (F-1377), committed as
`sandboxes/gmail/fixtures/upstream-golden.json` in pome-cloud; the twin half is
the twin's own answer to the same 14 L1 read surfaces. So
`verified_against_upstream_at` carries a real date on all seven rather than the
honest `null` the unmeasured registries carry.

**All seven are registered pending triage (F-1463), which is a disposition and
not a verdict.** Registration is what stops an unregistered divergence reporting
as new drift every day; it does not say the twin is right. Which of these get a
real twin fix — bullets 1 and 2 are the substantial candidates, since an agent
that walks `payload.parts` for an HTML body or reads `Received` / `DKIM-Signature`
to make a decision sees a structurally different object here than in Gmail — is a
later ruling on F-1463. Each fix deletes its entry and its bullet together.

1. **Message payloads are single-part where Gmail returns `payload.parts`.** A
   delivered Gmail message is `multipart/alternative` with a `text/plain` and a
   `text/html` part under `payload.parts`; the twin emits one `text/plain`
   payload and no `parts` key at all. Measured on the seeded welcome message,
   on both messages of a thread, and on a draft. An agent that reaches for the
   HTML alternative finds nothing to reach into.

2. **The twin synthesizes a fixed eight-header set, so its header count is
   wrong in both directions.** The twin always emits the same eight
   (`From`, `To`, `Date`, `Message-ID`, `Subject`, `MIME-Version`,
   `Content-Type`, `Content-Transfer-Encoding`). A message Gmail actually
   delivered carries **26** — the transport and authentication record the twin
   models none of: `Received` ×3, `Received-SPF`, `Authentication-Results`,
   `ARC-Seal` / `ARC-Message-Signature` / `ARC-Authentication-Results` ×2,
   `DKIM-Signature`, `X-Google-DKIM-Signature`, `Return-Path`, `Delivered-To`,
   the `X-Gm-*` family. An unsent draft carries **7**, where the twin still
   emits its eight (`Content-Transfer-Encoding` is the extra). The divergence
   is one fact — a uniform synthesized set — with two opposite consequences.

3. **`messages.list` does not count drafts.** The mailbox holds one unsent
   draft. Gmail's `users.messages.list` returns 5 message ids; the twin returns
   4, omitting the draft's. An agent that lists a mailbox and expects to see its
   own unsent drafts sees a shorter list here than in Gmail.

4. **`threads.list` does not count a draft's thread.** The same fact one level
   up: Gmail returns 4 threads, the twin 3.

5. **The label set omits Gmail's `CHAT` system label.** Gmail returns 16 labels
   to the twin's 15. The system-label gap is exactly one — `CHAT`, which Gmail
   still returns on every mailbox and the twin does not model. The remaining
   difference is identity, not modelling: the user labels are Gmail-minted
   opaque ids (`Label_8665618256210763520`) upstream and the twin's own readable
   ids (`Label_build`) here, which is inherent to a seeded twin and not
   something a fix would change.

6. **A thread message's `labelIds` carries the twin's own labels and its own
   read state.** On the captured thread, Gmail's first message is
   `["Label_8665618256210763520", "INBOX"]` (2) and the twin's is
   `["INBOX", "Label_build", "UNREAD"]` (3). Two differences sit behind the one
   count: the label id (see bullet 5) and `UNREAD`, which the twin sets on a
   seeded inbox message where the captured mailbox's had been read. Seed state,
   not a serializer gap.

7. **`sendAs` entries omit `replyToAddress`.** Gmail returns `replyToAddress` on
   every send-as entry — present and empty (`""`) when no reply-to is
   configured, which is the case on the captured mailbox. The twin omits the key
   entirely, on both `settings/sendAs` and `settings/sendAs/{sendAsEmail}`. The
   twin's own `verificationStatus` and `treatAsAlias`, which Gmail did not
   return, are the twin-adds direction and are informational, not drift.

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
