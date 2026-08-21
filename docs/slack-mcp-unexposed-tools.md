# The MCP tool Slack declares that twin-slack does not serve

twin-slack's tool table is Slack's own — a live OAuth capture of
`https://mcp.slack.com/mcp`, 19 tools. The twin serves 18 of them. This page is
the ruling on the nineteenth.

It is the mirror of [`github-mcp-twin-only-tools.md`](./github-mcp-twin-only-tools.md),
which answers the opposite question for the opposite twin: that one is about 36
tools the twin serves and the vendor does not declare, reported by the MCP lane
as `mcp-tool-twin-only`. This one is about the lane's other arm,
`mcp-tool-upstream-only` — a name the vendor declares and the twin answers
`unknown_tool` to.

The two arms fail differently, and it is worth saying which is which. A
twin-only tool is a **false pass**: an examinee calls it, the twin answers, and
the exam credits work the vendor would have refused. An upstream-only tool is a
**false failure**: an examinee does the right thing and is marked down for it.
False failures are the louder of the two — the examinee's author sees them —
which is the only reason this direction is the smaller problem. It is still the
product's core claim inverted — the same defect as a twin serving a name the
vendor never had, pointed the other way.

So the bar for leaving a vendor tool unexposed is not "we have not built it
yet." It is a ruling under [`packages/sdk/ENDPOINT-TIERS.md`](../packages/sdk/ENDPOINT-TIERS.md)
that the tool is `cold`, plus a registered entry the lane can read.

## What was read

`fixtures/mcp-tools-list/slack.raw.json`, `rawFileSha256`
`c6b29aba1d382175ca560228d10cc2665a0710b68298895721f7fcb4bcc25974`, captured
2026-08-10 under a user token carrying all 30 scopes `mcp.slack.com` advertises.
19 tools, which is the count Slack's own MCP documentation states.

The other 18 all reach a domain implementation this twin already had, at or
above the fidelity their heat asks for — with one exception, recorded below.

## `slack_send_message_draft` — `cold`, not served

> Creates a draft message in a Slack channel. The draft is saved to the user's
> "Drafts & Sent" in Slack without sending it.

`cold` under the rubric's `client-UI concepts` criterion, and this is not a new
judgement made to justify an absence. `packages/twin-slack/fidelity.inventory.json`
says so independently of Slack's `tools/list`:

> Message drafts have no Web API analog to name a row for (PS, client-UI
> concept) — recorded here, not as a surface.

That is verbatim the rubric's cold criterion, and it is a claim about Slack's
Web API rather than about this twin's effort budget. There is no
`chat.createDraft`. A draft is a state of the Slack **client**: it lives in the
composer, it is synced through internal client APIs, and no public method
creates, lists or sends one. The twin models the Slack Web API, so there is no
surface here to be at any tier of fidelity to.

The tool's own `_meta` in the capture says the same thing from Slack's side —
it is the only one of the 19 that carries one, and it points at a UI resource:

```json
"_meta": { "ui": { "resourceUri": "ui://send-message-input.html" } }
```

An examinee asked to draft rather than send is being asked to do something this
twin has no world for. Answering `unknown_tool` is the honest response, and it
is loud.

**Registration.** The entry belongs in pome-cloud's
`known-divergences/slack.mcp.yaml`, with this page as its reason — the same
arrangement github's two use. The registry is deliberately not in
this repo: turning a lane finding green is a decision about what an exam
measures, and it should not be possible to make it in the same commit that
causes the finding.

## The seven exposed with no prior counterpart, and one exception

Six of the seven are pure wiring over a domain implementation that already
existed:

| tool | heat | backing domain | wiring only? |
| --- | --- | --- | --- |
| `slack_create_conversation` | hot | `conversations.create` / `open` / `invite`, all semantic | yes |
| `slack_schedule_message` | hot | `chat.scheduleMessage`, semantic | yes |
| `slack_read_file` | warm | `files.info`, shape | yes |
| `slack_search_emojis` | warm | `emoji.list`, semantic | yes |
| `slack_create_canvas` | warm | `canvases.create`, shape | yes |
| `slack_update_canvas` | warm | `canvases.edit`, shape | yes |
| `slack_read_canvas` | warm | — | **no** |

**`slack_read_canvas` had no implementation to wire.** `domain/canvases.ts`
carried `create`, `edit` and `delete` and no read; the "5 exports" the gate-1
table counted include the two `coerce*` helpers. Real Slack reads a canvas over
`files.info` — a canvas is a file of type `quip` — but this twin stores canvases
in their own table, so `files.info` does not reach them either.

`canvasesRead` was added at the shape tier the warm ruling asks for. It
reports a `section_id_mapping` of exactly one entry covering the whole document,
because the twin has no section model and per-heading ids that
`slack_update_canvas` could not honour would be worse than one id that it can.
The tool is MCP-only: no REST route was added, because Slack has no REST method
this would be a twin of.

That is a small addition rather than pure wiring, and it does not change the
gate-1 heat ruling. It is recorded here because the ruling's stated basis — "all
seven exposed tools have a REST domain implementation already at or above their
target, verified per tool" — was not true of this one, and a ruling whose
evidence is off by one should say so rather than be quietly right by accident.
