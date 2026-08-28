# @pome-sh/twin-slack — CHANGELOG



## Unreleased (minor)

`POST /s/:sid/mcp/call` no longer accepts `{name}`/`{params}` as aliases of
`{tool}`/`{arguments}`, and a body naming no tool answers the strict-parse
error instead of `{ok:false, error:"invalid_arguments"}`. Form-or-JSON body
parsing is unchanged — it belongs to `bodyReader`, which every surface shares
(F-1580).

## 0.4.1 — 2026-08-11

`files.upload` takes `channels` only (F-1389).

Slack documents `channels` — plural, comma-separated — and has never documented
a singular `channel`; the vendored `slack_web_openapi_v2` snapshot agrees,
declaring `channels` and eight other real arguments, so it is not thin here. The
twin declared both and the domain fell back `args.channels ?? args.channel`, so
an upload addressed `channel=C123` landed in that channel here and in no channel
at all on Slack. The declaration and the domain fallback are both gone; slack's
measured `ignore` disposition discards `channel` if sent.

## 0.4.0 — 2026-08-10

**Breaking.** It serves the tools Slack declares. Every tool name and almost
every argument name changed (F-1330).

The eleven names it served before came from
`modelcontextprotocol/servers-archived/src/slack`, an archived reference server,
copied into TypeScript by commit `6abec3c` in June. Three of them exist at
Slack. Eight do not, and never have — this was not drift, and no Slack changelog
records any such rename. An examinee written against real Slack emitted
`slack_send_message`, this twin answered only `slack_post_message`, and the exam
scored a failure the agent did not commit.

`fixtures/mcp-tools-list.raw.json` is now Slack's own listing: F-1329's live
OAuth capture of `https://mcp.slack.com/mcp` (19 tools), minus the one ruled
unexposed. Names, descriptions, input schemas and annotations are the vendor's,
byte for byte.

| was | is |
| --- | --- |
| `slack_post_message` | `slack_send_message` — `text` → `message` |
| `slack_reply_to_thread` | gone; `slack_send_message` with `thread_ts` |
| `slack_get_channel_history` | `slack_read_channel` |
| `slack_get_thread_replies` | `slack_read_thread` — `thread_ts` → `message_ts` |
| `slack_get_user_profile` | `slack_read_user_profile` — `user_id` now optional |
| `slack_get_users` | `slack_search_users` — `query` **required** |
| `slack_list_channels` | `slack_search_channels` — `query` **required** |
| `slack_search_messages` | `slack_search_public` **and** `slack_search_public_and_private` |
| `slack_add_reaction` | same name — `timestamp` → `message_ts`, `reaction` → `emoji` |
| `slack_get_reactions` | same name — `timestamp` → `message_ts` |
| `slack_list_channel_members` | same name, plus the arguments Slack declares |

Seven tools are newly served, all of them Slack's:
`slack_schedule_message` and `slack_create_conversation` (hot),
`slack_read_file`, `slack_search_emojis`, `slack_create_canvas`,
`slack_update_canvas` and `slack_read_canvas` (warm). Six were pure wiring over
domains that already existed; `slack_read_canvas` had none, so `canvasesRead`
was added at the shape tier its heat asks for.

**`additionalProperties` is gone, and that is a fix in the other direction.**
The schemas were `z.strictObject`, so a call that got the name right and carried
a real Slack argument (`message`, `reply_broadcast`, `oldest`, `cursor`,
`response_format`) was hard-rejected. No `inputSchema` Slack serves declares
`additionalProperties`, so none of these does; validation is `z.looseObject`.

`slack_send_message_draft` is the one tool Slack declares that this twin does
not serve — `cold`, a client-UI concept with no Web API analog. It is registered
in pome-cloud's `known-divergences/slack.mcp.yaml` and reasoned in
`docs/slack-mcp-unexposed-tools.md`, so the MCP lane reads a decision rather
than an omission.

Two smaller behaviour changes came with it. `canvases.edit` now applies every
operation in its `changes` array, in order, against one snapshot — it used to
apply the first and answer ok for the rest, which told an agent batching three
edits that all three landed. And `search.messages` takes an optional `scope`,
because the two search tools Slack serves over it differ on exactly that axis.

`slackToolInputSchema` is removed. Byte-pinning the validator against the
fixture stopped being possible when the fixture became the vendor's — Slack's
schemas carry prose no zod schema projects to — so the pin moved to the argument
surface: `toolSchemaConformance()` reports any key, required field or
unknown-argument rejection on which the validator and Slack's declaration
disagree, and the contract suite demands it be empty.


## 0.3.6 — 2026-08-08

`slack.no-reaction-added` declares `subject: ({ reaction }) => reaction`. It
declared `null` while the comment beside it said the reaction name is SCANNED
and its `vacuityMutant` falsified exactly that slot (F-1157).

The consequence was not a blind grader but a wrong verdict, because the check is
NEGATIVE: a redactor masking `reactions[].name` makes the filter match nothing,
so `No "white_check_mark" reaction was added` PASSES over an export in which the
agent added that reaction. It was the only `vacuous_pass` across all five twins'
45 declarations, found by destroying the literal in the check's own declared
failing world and watching that world start to pass.

With the subject declared, the engine skips such a criterion at the door instead
of scoring it. No sentence, no parse and no passing-world verdict moves.

**This does not close F-1159**, which is the same check passing vacuously for a
different reason: `(final.reactions ?? [])` scores the same negative criterion
`passed` when the export carries no `reactions` collection at all. A masked value
and an absent section are different causes, and the probe that found the first
replaces strings rather than deleting collections, so it is structurally unable
to see the second. That guard still lives in the consuming engine's
`STATE_SECTION_GUARDS`; the gap is marked at the call site.


## 0.3.5 — 2026-08-06

Its MCP tool table is now derived from `fixtures/mcp-tools-list.raw.json`
rather than declared in TypeScript (F-1325). The fixture's provenance —
substrate, endpoint, protocol version, capture date and the sha of the raw
bytes — is validated at load, and the derivation is 1:1 in both directions, so
a tool the fixture does not declare and a fixture tool nothing implements are
each a throw at module load.

Name-neutral by construction: `tools/list` and the legacy `/mcp/tools` surface
are byte-identical before and after.

**Removed from the package root**: `listTools`, `listToolsForMcp` and
`toolDefinitions`. Nothing served them — the engine answers both `/mcp/tools`
and `tools/list` from `definition.tools` — so they were a second projection of
the same table. The replacements are `slackToolFixture`,
`slackToolInputSchema` and `toolSchemas`. This package is `private: true` and
on no registry, and neither published tarball re-exposes a twin package root,
so no installable consumer can have been importing them; every in-repo caller
moved in the same change.

## 0.3.3 — 2026-08-04

Dependency-only patch (#302): `hono` `^4.12.31` → `^4.13.0`, `zod` `^4.1.13` → `^4.4.3`, `@hono/node-server` `^2.0.10` → `^2.1.0`.
No source file changed and `npm run test:contract` is green, so the surface is
identical — this exists so the npm artifact stops differing from `main`, which is
the staleness the publish skip-guard cannot see.

## 0.3.2 — 2026-08-04

- Re-pinned to `@pome-sh/sdk@0.11.0` / `@pome-sh/shared-types@0.14.0` for the F-1200 parent-vocabulary
  change: a recorded row now carries `parent_event_id` rather than `parent_id`.
  No change to this twin's own surface — `npm run test:contract` is green.

All notable changes to the Slack twin are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the package follows [Semantic Versioning](https://semver.org/).


## 0.3.1 — 2026-08-03

Every state-reading check says where it looked (F-1197).

- 5 declarations now fill `CheckOutcome.evidenceStatePaths` (new in
  `@pome-sh/sdk` 0.10.1) with RFC 6901 pointers into this twin's exported tree.
- `check-state.ts`'s resolvers return the pointer they walked. `Resolved<T>`'s
  found arm gains `path`; its missing arm gains an optional `searched`, naming
  the collection a failed lookup scanned.
- `checks-contract.test.ts` gains the citation gate and an EMPTY
  `HONEST_UNCITED_CHECKS` ledger.

A failed lookup cites too, and that is the half worth knowing about. An absent channel SKIPS rather than failing, and a skipped criterion's reason is the least self-explanatory thing on the report.
So the honest citation on that arm is not the row — there is none — but the list:
*this is where I looked, see for yourself that it is not in it.*

Requires `@pome-sh/sdk` 0.10.1: the declarations call `statePath` /
`childStatePath`, which 0.10.0 does not export.

No sentence, template, substrate or check id changed, so `checksDigest` is
identical and no criterion re-binds.

## 0.3.0 — 2026-07-30

Slack declares its assertable check vocabulary (F-1126, milestone A3).

- New `./checks` subpath: `SLACK_CHECKS`, five declarations, plus the
  `SlackCheckState` model they read (`check-state.ts`). pome-cloud deletes its
  hand-maintained mirror of that shape in the same milestone — the twin's model
  is now the only one.
- `slack.no-secret-newly-exposed` grades the secrets class as a `seed+final`
  delta. It never reads a secret: seed and final cross the same redactors, so
  the value is `[REDACTED]` on both sides and only its POSITION differs.
- `fidelity-contract.test.ts` gains a state-shape parity arm. The harness's
  three existing rings are all about the tool surface; nothing had ever compared
  the state export against anything.
- Repins `@pome-sh/sdk` to 0.10.0 and `@pome-sh/shared-types` to 0.13.0. The
  previous 0.5.1 / 0.12.0 pins meant npm installed nested PUBLISHED copies
  rather than symlinking the workspace, so this package had been built and
  tested against a five-minor-old sdk.

Minor: new published exports and an sdk floor a consumer must act on. No change
to the served REST/MCP surface or to `/_pome/state`.

## 0.2.2 — 2026-07-21

Dependency-only patch: repin `@pome-sh/sdk` to 0.5.1 and
`@pome-sh/shared-types` to 0.12.0 (F-818). No twin surface change.

## 0.2.1 — 2026-07-20

Dependency-only release: repins the shared first-party contract to
`@pome-sh/shared-types@0.11.0` and the additive Gmail-capable engine to
`@pome-sh/sdk@0.5.0`. Slack wire behavior is unchanged.

## 0.2.0 — 2026-07-16

Batches everything landed on main since 0.1.2 whose versions were never cut
(the publish workflow skips already-published versions, so npm 0.1.2 had gone
stale against the repo):

- #119 — FIDELITY.md re-cut by the heat rubric; the 3 ruled MCP read tools
  added to the packaged surface.
- #116 — structured fidelity inventory (`fidelity.inventory.json`) shipped as
  the machine-readable seam source of truth.
- #128 / #109 — `@pome-sh/sdk` pinned to 0.4.0: the twin self-generates
  `TWIN_AUTH_SECRET` on first non-loopback boot (`ensureTwinAuthSecret`).

Minor: the served REST/MCP fidelity surface changed shape.

## 0.1.2 — 2026-07-10

Dependency-only release for the node:sqlite driver swap (F-703):
`@pome-sh/sdk` pinned to 0.3.1 and the direct `better-sqlite3` dependency
dropped — the twin's install closure now has zero native modules. No twin
behavior changes.

## 0.1.1 — 2026-07-10

Dependency-only release: `@pome-sh/sdk` pinned to 0.3.0 (durable write-through
recorder) so the CLI bundle resolves a single sdk copy. No twin behavior
changes.

## 0.1.0 — 2026-07-09

First npm-published release (F-714).

A deterministic Slack Web API twin for agent testing — REST + MCP surfaces
over SQLite-backed state, built as a thin `@pome-sh/sdk` plugin (F-683): the
twin declares its domain, tools, and Slack's frozen wire shapes
(`{ok:false, error}` envelopes on HTTP 200, form-or-JSON body parsing); the
engine owns HTTP mounting, bearer auth, the recorder, MCP dispatch, and the
admin gate.

### Added

- `twin-slack` bin: boots via `node dist/src/server.js` per the twin runtime
  contract (`/CONTRACT.md`, v1.0.0) — `GET /healthz` within 3 s, refuses
  non-loopback binds without `TWIN_AUTH_SECRET`.
- Slack Web API twin surface (channels, messages, reactions, files) as REST
  and MCP tools, with `SLACK_DETERMINISTIC_TS` for reproducible timestamps.
- Seed control: built-in default seed, `POME_SEED_JSON` override,
  `SLACK_CLONE_NO_SEED=1`, and `POST /admin/reset|seed`.
- Library entry points `createSlackTwinApp` and `slackTwinDefinition` for
  in-process embedding (used by the `pome` CLI's `--local` harness).
