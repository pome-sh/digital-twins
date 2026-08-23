# Slack twin fixtures

| Path | Role |
| --- | --- |
| `mcp-tools-list.raw.json` | The 18-tool MCP listing, verbatim. **This file IS the tool table** — `src/tools.ts` derives it |
| `mcp-tools-list.meta.json` | The provenance contract: substrate, endpoint, protocol version, capture date, `rawFileSha256` |
| `mcp-tools-list.canonical.json` | The same listing re-derived with its provenance attached and readable whitespace |

`src/tools.ts` declares no tool name, description or annotation. It declares
one zod schema per tool for argument validation, and the test suite holds the
two together — see [Why the schemas are not byte-pinned](#why-the-schemas-are-not-byte-pinned-any-more).

## What this listing is

**Slack's.** `mcp-tools-list.raw.json` is
[`fixtures/mcp-tools-list/slack.raw.json`](../../../fixtures/mcp-tools-list/) —
a live OAuth capture of `https://mcp.slack.com/mcp`, taken 2026-08-10
under a token carrying all 30 scopes the server advertises — minus the one tool
this twin does not expose. Every surviving name, description, `inputSchema` and
annotation is the vendor's, byte for byte.

Regenerate it with:

```bash
npm run fixture:mcp -w @pome-sh/twin-slack          # write
npm run gate:mcp-fixture -w @pome-sh/twin-slack     # compare only (CI)
```

`scripts/adopt-upstream-mcp-fixture.ts` **can only subtract**. It re-hashes the
upstream golden before reading it, refuses a suppression naming a tool the
capture does not carry, and copies everything else through untouched. It cannot
rename, re-describe or re-shape a schema, and it cannot add a tool Slack does
not serve. That constraint is the point — see below.

### What it used to be

This file was once a transcription of `src/tools.ts`: eleven names
commit [`6abec3c`](https://github.com/pome-sh/digital-twins/commit/6abec3c)
copied out of `modelcontextprotocol/servers-archived/src/slack`, an archived
reference server. **Three of them existed at Slack**, and even those three took
different arguments. An examinee written against real Slack emitted
`slack_send_message`; the twin answered only `slack_post_message`; the exam
scored a failure the agent did not commit.

Two properties of that failure are worth keeping in view, because a producer
that could invent is what allowed both:

- **It was never drift.** No Slack changelog records any such rename. The names
  were wrong on the day they were written and stayed green for seven weeks,
  because every test that checked them was generated from the same declaration.
- **`additionalProperties: false` made it worse in both directions.** The old
  schemas were `z.strictObject`, so even a call that got the name right and
  carried a real Slack parameter (`message`, `reply_broadcast`, `oldest`,
  `cursor`, `response_format`) was hard-rejected. None of Slack's own schemas
  declares `additionalProperties`, so none of these does now, and `src/tools.ts`
  validates with `z.looseObject` to match.

### The one tool Slack declares and this twin does not serve

`slack_send_message_draft`, ruled `cold` — a Slack-client concept with no Web
API analog, so there is no surface here to be at any tier of fidelity to. It is
registered in pome-cloud's `known-divergences/slack.mcp.yaml` and reasoned per
tool in [`docs/slack-mcp-unexposed-tools.md`](../../../docs/slack-mcp-unexposed-tools.md),
so the MCP lane reads a decision rather than an omission.

### One thing served verbatim that is wrong about this twin

Five descriptions name the **capture workspace's** logged-in user
(`U0B79GFLEH0`): `slack_send_message`, `slack_search_public`,
`slack_search_public_and_private`, `slack_search_users` and
`slack_list_channel_members`. Slack templates that ID per installation, and this
twin's seeded agent is a different user, so those sentences do not describe the
world an examinee is in.

They are served unedited on purpose. No constant is correct across seeds, so
substituting one would trade the vendor's provenance for the twin's guess —
which is the class of defect this fixture exists to remove. Making descriptions
seed-aware is a change to what the twin serves and belongs to a ticket that
rules on it.

## Why the schemas are not byte-pinned any more

While this fixture was a transcription of `src/tools.ts`, the two could be
pinned by bytes: run `z.toJSONSchema()` over the validator and demand the
fixture back. That stops being possible once the fixture is the vendor's —
Slack's `inputSchema` carries prose no zod schema projects to, including 4KB of
canvas markdown rules.

So the pin moved from bytes to **argument surface**, which is the thing an
examinee can actually collide with. `toolSchemaConformance()` in `src/tools.ts`
reports, per tool: a key the validator knows that Slack does not declare, a key
Slack declares that the validator does not model, a required-set disagreement in
either direction, and a validator that would reject an unknown argument Slack's
schema permits. `test/mcp-contract.test.ts` demands it be empty.

## Refreshing against a newer capture

Re-run the upstream-golden producer to refresh it, then re-run the adopt
script. Both steps are gated: `mcp-tools-list.meta.json` carries the sha of the
raw file and `loadMcpToolFixture` refuses to boot the twin if the two disagree,
and `--check` diffs all three files against the golden.

A refresh that changes tool names is a change to what this twin serves, and
needs the same thing the 2026-08-10 adoption needed: a ruling that says so, the
corpus migrated in the same batch, and `FIDELITY.md` re-cut.
