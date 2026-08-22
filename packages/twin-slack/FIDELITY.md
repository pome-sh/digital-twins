# Slack Twin Fidelity

`@pome-sh/twin-slack` is a high-fidelity test double of the Slack Web API —
not a universal clone. This page documents exactly which surfaces are
faithful to real Slack today, at what tier, and how fidelity is verified.

Last verified: 2026-08-10.

## What "fidelity" means here

Each MCP tool and REST route is classified into one of three tiers:

- **`semantic`** — the stateful behavior is implemented locally and covered
  by tests. Message threading, channel membership, reaction uniqueness, ts
  monotonicity, and the rest behave the way agents expect when they call
  real Slack.
- **`shape`** — the response envelope matches real Slack but some
  underlying behavior is simplified. Useful for agents that only inspect
  fields, not safe for agents that rely on side effects.
- **`unsupported`** — not implemented. The twin returns a loud 501 envelope
  with `_twin.fidelity: "unsupported"` so an agent never silently succeeds
  against a missing surface.

Fidelity ("how deep a surface *is*") is one of two orthogonal dimensions; the
other is **heat** ("how deep it *should* be", `hot`/`warm`/`cold`, ruled per
milestone). The engine-level rubric — tier criteria, target mapping, gap and
tier-mismatch semantics — lives at
[`packages/sdk/ENDPOINT-TIERS.md`](../sdk/ENDPOINT-TIERS.md). The `Tier`
column below means fidelity; the `Heat` column carries the twin-slack ruling
(F-729 `[DECISION]`, 2026-07-11, implemented by F-736). Where ruled heat is
below current fidelity, the surface is listed in the
[tier-mismatch ledger](#tier-mismatch-ledger); ruled-but-unimplemented warm
surfaces and named cold surfaces live in
[their own table](#ruled-gaps-and-named-cold-surfaces).

The bar is: **agents written against real Slack run unchanged against the
local twin for the surfaces below**, and trip a loud failure for anything
outside them.

For the build / runtime / cloud consumer invariants the hosted snapshot build
depends on (port `:3333`, `/healthz`, `SLACK_CLONE_HOST`, `npm install`-able
package, `node dist/src/server.js`), see
[Runtime contract (for snapshot consumers)](README.md#runtime-contract-for-snapshot-consumers)
in the package README. Changing any of those is a breaking change for
`pome-cloud` and requires a matching cloud consumer PR.

## MCP Tools

| Tool | Backing surface | Heat | Tier | Tests | Known deviations |
| --- | --- | --- | --- | --- | --- |
| `slack_send_message` | SQLite messages | hot | semantic | `mcp-contract.test.ts`, `domain-chat.test.ts`, `recorder-state-delta.test.ts` | Takes `message`, not `text`. `thread_ts` makes it a reply — Slack has no separate thread-reply tool. Block-kit rendering is not validated; `draft_id` and `unfurl_app_links` are accepted and ignored (no draft store, no app-link unfurler). |
| `slack_schedule_message` | SQLite scheduled_messages | hot | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts` | Over `chat.scheduleMessage`. No fire path — a scheduled message persists until explicitly deleted, so `post_at` is stored, not honoured. |
| `slack_add_reaction` | SQLite reactions | hot | semantic | `mcp-contract.test.ts`, `domain.test.ts`, `concurrency.test.ts` | Takes `message_ts` and `emoji`. Reactions are unique per `(channel, ts, name, user)`; skin-tone modifier suffixes are preserved as-is. |
| `slack_create_conversation` | SQLite channels | hot | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts`, `domain-conversations.test.ts` | Both modes: `channel_name` creates and optionally invites `user_ids`; `user_ids` alone opens a DM or group DM. Naming neither answers `invalid_arguments`. |
| `slack_create_canvas` | SQLite canvases | warm | shape | `mcp-contract.test.ts`, `tools-execute.test.ts`, `domain-wave3.test.ts` | Markdown blob + title. Canvas-flavored Markdown is stored verbatim, never parsed — user/channel card syntax and Salesforce records are not rendered. |
| `slack_update_canvas` | SQLite canvases | warm | shape | `mcp-contract.test.ts`, `tools-execute.test.ts`, `domain-wave3.test.ts` | Every operation in `sections` applies, in order, against one snapshot; the flat `action`/`content`/`section_id` form is accepted too. No section model, so `section_id` targets are coarse whole-document ops (divergence #16). |
| `slack_search_public` | SQLite messages (LIKE search) | hot | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts` | Public channels only. Substring match, not Slack's query grammar (divergence #8); the search-refinement arguments (`content_types`, `after`/`before`, `sort`, `include_context`, `response_format`) are accepted and ignored. |
| `slack_search_public_and_private` | SQLite messages (LIKE search) | hot | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts` | Same engine, actor-scoped: public channels plus the private channels, DMs and group DMs the caller is in. Same accepted-and-ignored refinement arguments. |
| `slack_search_channels` | SQLite channels | hot | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts`, `performance.test.ts` | `query` is required and filters on name/topic/purpose by case-insensitive substring. `channel_types` maps to `conversations.list`'s `types`; cursor pagination is applied before the filter, as Slack's is. |
| `slack_search_users` | SQLite users | hot | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts` | `query` is required and filters on name/real_name/email/title. Deleted users are included with `deleted: true`. |
| `slack_read_channel` | SQLite messages | hot | semantic | `mcp-contract.test.ts`, `domain.test.ts`, `performance.test.ts` | `oldest`/`latest`/`cursor` supported; per-message metadata follows the real Slack envelope. `response_format` is accepted and ignored — the envelope is always the detailed one. |
| `slack_read_thread` | SQLite messages | hot | semantic | `mcp-contract.test.ts`, `domain.test.ts`, `domain-chat.test.ts` | Takes `message_ts`. Parent decorated with `thread_ts === ts`, `subscribed: false`, `is_locked: false` per real Slack invariant. |
| `slack_read_canvas` | SQLite canvases | warm | shape | `mcp-contract.test.ts`, `tools-execute.test.ts` | Returns the markdown and a `section_id_mapping` of exactly one entry covering the whole document — the twin has no section model, and reporting per-heading ids an edit could not honour would be worse than reporting one that it can. |
| `slack_read_user_profile` | SQLite users.profile_json | hot | semantic | `mcp-contract.test.ts`, `domain.test.ts` | `user_id` is optional and defaults to the calling user. Returns the full profile JSON; custom fields preserved verbatim through the round-trip. |
| `slack_list_channel_members` | SQLite channel_members | hot | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts` | Over `conversations.members`; returns user IDs with cursor pagination. `response_format`, `include_deleted` and `include_bots` are accepted and ignored — the twin returns ids, never inlined profiles. |
| `slack_read_file` | SQLite files | warm | shape | `mcp-contract.test.ts`, `tools-execute.test.ts` | Over `files.info`: metadata only, no binary storage, so no `mimeType`-tagged content or base64 body. Shape is at the warm target. |
| `slack_search_emojis` | SQLite emoji | warm | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts` | Over `emoji.list`, filtered by case-insensitive substring across comma-separated terms as Slack documents. Semantic is above the warm target: see the tier-mismatch ledger. |
| `slack_get_reactions` | SQLite reactions | hot | semantic | `mcp-contract.test.ts`, `tools-execute.test.ts` | Takes `message_ts`. Returns the message with its grouped reactions. |

The visible MCP tool count is pinned at 18 in `test/mcp-contract.test.ts`,
and the names, required fields and mutating set are Slack's own — read off
F-1329's live OAuth capture of `https://mcp.slack.com/mcp` and adopted by
F-1330. `fixtures/mcp-tools-list.raw.json` is that capture minus the one tool
ruled unexposed, produced by a script that can only subtract; the contract test
additionally asserts that the eight names commit `6abec3c` invented are served
by nothing. No `inputSchema` declares `additionalProperties`, because none of
Slack's does — the pre-F-1330 `additionalProperties:false` hard-rejected calls
that got the name right and carried a real Slack parameter. Any drift breaks the
contract test loudly.

**The one tool Slack declares and this twin does not serve** is
`slack_send_message_draft`, ruled `cold` (a client-UI concept with no Web API
analog). It is registered in pome-cloud's `known-divergences/slack.mcp.yaml`
with that reason and reasoned per-tool in
[`docs/slack-mcp-unexposed-tools.md`](../../docs/slack-mcp-unexposed-tools.md),
so the MCP divergence lane reads a decision rather than an omission.

## REST routes

| Endpoint | Heat | Tier | Tests | Notes |
| --- | --- | --- | --- | --- |
| `auth.test` | hot | semantic | `app.test.ts`, `auth.test.ts` | Returns `{ok, url, team, user, team_id, user_id, bot_id?}`. |
| `chat.postMessage` | hot | semantic | `app.test.ts`, `domain-chat.test.ts`, `recorder-state-delta.test.ts` | Form-encoded + JSON body; persists `username`, `icon_emoji`, `icon_url`; emits `bot_id`, `bot_profile`, `app_id` for bot authors. |
| `chat.update` | hot | semantic | `domain-chat.test.ts`, `app-routes.test.ts` | `edited_ts` allocated via the workspace-unique ts counter — no collisions. Hot per SL1: agents edit their own progress messages. |
| `chat.delete` | hot | semantic | `app.test.ts`, `actor-session.test.ts`, `domain.test.ts` | Hard delete (matches real Slack); thread parent `reply_count` decrements transactionally. No admin override. Hot per SL1. |
| `chat.scheduleMessage` / `chat.deleteScheduledMessage` | hot | semantic | `domain.test.ts`, `app-routes.test.ts` | No fire path — scheduled messages persist until explicit delete. |
| `conversations.list` | hot | semantic | `app.test.ts`, `recorder-state-delta.test.ts` | Cursor pagination, `types` filter, `exclude_archived`. |
| `conversations.info` | hot | semantic | `app-routes.test.ts` | `include_num_members` supported. |
| `conversations.create` | hot | semantic | `app.test.ts`, `domain-conversations.test.ts` | Granular error codes: `invalid_name_required` / `_maxlength` / `_specials` / `_punctuation`. |
| `conversations.history` | hot | semantic | `app.test.ts`, `performance.test.ts` | Newest-first ordering; `pin_count` included. |
| `conversations.replies` | hot | semantic | `domain-chat.test.ts`, `domain.test.ts` | Parent decorated with `thread_ts === ts`, `subscribed:false`, `is_locked:false`. |
| `conversations.invite` / `join` / `members` | hot | semantic | `app-routes.test.ts`, `domain.test.ts`, `domain-conversations.test.ts` | Membership setup + the member read behind `slack_list_channel_members`. |
| `conversations.leave` / `kick` / `archive` | warm | semantic | `app-routes.test.ts`, `domain.test.ts`, `domain-conversations.test.ts` | `cant_kick_self`, `cant_kick_from_general`, `cant_leave_general`, `cant_archive_general` matched. Warm-ruled: see the tier-mismatch ledger. |
| `conversations.open` | hot | semantic | `domain-conversations.test.ts`, `concurrency.test.ts` | Deterministic DM channel id by sorted member-id signature with a partial UNIQUE index. |
| `reactions.add` / `get` | hot | semantic | `app.test.ts`, `domain.test.ts`, `concurrency.test.ts` | `already_reacted` error code; `get` backs `slack_get_reactions`. |
| `reactions.remove` | warm | semantic | `app.test.ts`, `domain.test.ts` | `no_reaction` error code. Warm-ruled undo step: see the tier-mismatch ledger. |
| `users.list` / `users.info` / `users.lookupByEmail` / `users.profile.get` | hot | semantic | `domain.test.ts`, `app-routes.test.ts` | `users_not_found` error code on email miss. |
| `users.profile.set` | warm | semantic | `domain.test.ts`, `app-routes.test.ts` | Warm-ruled (no vendor MCP write): see the tier-mismatch ledger. |
| `pins.add` / `remove` / `list` | warm | semantic | `domain.test.ts`, `app-routes.test.ts` | `already_pinned` / `no_pin` codes; SQL constraint-mapped on race. Warm-ruled: see the tier-mismatch ledger. |
| `search.messages` | hot | semantic | `domain.test.ts`, `performance.test.ts` | Substring (LIKE-based) match; query syntax is intentionally smaller than real Slack search. |
| `files.upload` / `info` / `list` / `delete` | warm | shape | `domain.test.ts`, `app-routes.test.ts`, `seed-files.test.ts` | Metadata-only; no binary storage. URL fields point to deterministic `pome-twin-files.slack.com` hosts. Since F-1509 the seed's `files` key can plant rows, so these read on a populated table without a prior upload; the file object's leaf set is divergence #24. Shape is at the warm target (SL5). |
| `bookmarks.add` / `remove` / `list` | warm | semantic | `domain.test.ts`, `app-routes.test.ts` | `link` type accepted; other bookmark types are unsupported per real Slack 2024 changelog. Warm-ruled: see the tier-mismatch ledger. |
| `team.info` | warm | semantic | `app-routes.test.ts` | Returns workspace metadata; enterprise fields are NULL for non-Enterprise twins. Warm-ruled context read: see the tier-mismatch ledger. |
| `canvases.create` / `canvases.edit` / `canvases.delete` | warm | shape | `domain-wave3.test.ts`, `app-routes.test.ts` | Wave 3 (SL3). Markdown title/content persistence; section_id-relative edits are coarse whole-document ops (shape at warm target). Since F-1330 `edit` applies every operation in `changes`, in order, against one snapshot — it used to apply the first and answer ok for the rest. Reading a canvas is MCP-only (`slack_read_canvas`); real Slack reads one over `files.info`, which this twin backs from a separate table. |
| `conversations.setTopic` / `conversations.setPurpose` | warm | semantic | `domain-wave3.test.ts`, `domain-conversations.test.ts` | Wave 3 (SL4). Membership required; `too_long` at 250 chars; IM/MPIM → `method_not_supported_for_channel_type`. Warm-ruled: see the tier-mismatch ledger. |
| `emoji.list` | warm | semantic | `domain-wave3.test.ts`, `app-routes.test.ts` | Wave 3 (SL4). Seeded custom emoji map; `alias:` protocol preserved. Warm-ruled: see the tier-mismatch ledger. |

Routes not listed return **501 + `_twin.fidelity:"unsupported"`** so agents
fail loudly rather than silently no-op. Cold surfaces agents plausibly probe
carry named rows below, so the loud 501 is documented and test-backed; the
rest of the upstream API is implicitly cold via the catch-all.

## Ruled gaps and named cold surfaces

Per the F-729 twin-slack ruling, the hot and warm sets are exhaustive. Wave 3
filled the remaining warm gaps (SL3 canvases, SL4 topic/purpose + emoji.list).
Named cold rows document the loud 501 for surfaces agents plausibly probe.
Message drafts are deliberately absent: a client-UI concept with no Web API
analog to name a row for (PS). Slack's MCP server does declare a
`slack_send_message_draft` tool, and since F-1330 that absence is registered
rather than silent — see the MCP tools section above.

| Endpoint | Heat | Tier | Notes |
| --- | --- | --- | --- |
| `chat.postEphemeral` | cold | unsupported | The twin has no per-viewer visibility model (PS). 501 test-backed. |
| `files.getUploadURLExternal` / `files.completeUploadExternal` | cold | unsupported | Modern upload flow; the twin serves legacy v1 upload (divergence #7). Promotion candidate when v1 sunsets. 501 test-backed. |
| `admin.*` | cold | unsupported | No admin scopes modeled (divergence #6) (PS). Representative 501 probes test-backed. |
| `usergroups.*` | cold | unsupported | Outside the single-workspace twin scope (PS). 501 test-backed. |
| `views.*` | cold | unsupported | Client-UI modal surface, not on an agent chain (PS). 501 test-backed. |

## Tier-mismatch ledger

Surfaces whose ruled heat is **warm** but whose measured fidelity is
`semantic` — implementation deeper than the ruling demands. Per the M5
additive-only project `[DECISION]` (2026-07-11), nothing here is demoted in
code this milestone (the Twin Fidelity Watch launch gate F-440 is counting
consecutive green runs); each entry becomes a demotion-review follow-up
ticket after that gate closes. The ledger makes over-investment visible; it
does not trigger removals.

| Surface | Heat | Fidelity today | Target | Why it stays for now |
| --- | --- | --- | --- | --- |
| `reactions.remove` | warm | semantic | shape | Undo step; F-440 additive-only window. |
| `conversations.leave` | warm | semantic | shape | Rare cleanup chain; F-440 additive-only window. |
| `conversations.kick` | warm | semantic | shape | Rare moderation chain; F-440 additive-only window. |
| `conversations.archive` | warm | semantic | shape | Rare cleanup chain; F-440 additive-only window. |
| `users.profile.set` | warm | semantic | shape | Plausible set-own-status chain, no vendor write tool; F-440 additive-only window. |
| `pins.add` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `pins.remove` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `pins.list` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `bookmarks.add` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `bookmarks.remove` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `bookmarks.list` | warm | semantic | shape | Occasional chain, absent from the vendor server; F-440 additive-only window. |
| `team.info` | warm | semantic | shape | Context read adjacent to hot chains; F-440 additive-only window. |
| `conversations.setTopic` | warm | semantic | shape | Classic agent task; Wave 3 fill above warm shape target; F-440 additive-only window. |
| `conversations.setPurpose` | warm | semantic | shape | Topic sibling; Wave 3 fill above warm shape target; F-440 additive-only window. |
| `emoji.list` | warm | semantic | shape | Vendor emoji-search adjacency; Wave 3 fill above warm shape target; F-440 additive-only window. |
| `slack_search_emojis` | warm | semantic | shape | The MCP tool F-1330 wired over `emoji.list`; inherits its depth, so it inherits its mismatch. F-440 additive-only window. |

## Fidelity-watch coverage (status.pome.sh)

The daily watchdog reports twin-slack at **19 of 45 semantic surfaces**, 26 rolling
out. The number is built from source, never hand-typed
(the Twin Fidelity Watch in pome-cloud); here is exactly what it counts.

> **Denominator reconcile deferred (SL5).** The 45 predates the F-736 re-cut:
> it counts `files.info` / `files.list` / `files.delete` as semantic (the
> table above rules them shape ×4 — the table wins) and does not yet include
> the three F-736 MCP read tools (`slack_get_reactions`,
> `slack_list_channel_members`, and the search tool then called
> `slack_search_messages`). It also predates F-1330, which took the tool table
> from 11 fabricated names to Slack's 18 — so every MCP name in the
> denominator below is stale, not just the count. Reconciling
> pome-cloud's `sandboxes/slack/surfaces.ts` is deliberately deferred until
> the F-440 launch gate finishes its consecutive-green count (additive-only
> collision), tracked by F-737.

- **Denominator (45)** — the full semantic surface inventory: 8 MCP tools + 37
  semantic REST methods (`files.upload` is shape-tier, excluded). MCP tools and
  REST methods are counted as **distinct public contracts**: an agent calls
  `slack_search_channels`, a REST client calls `conversations.list`. They share a
  backend, but each is a surface we hold to fidelity on its own. Source:
  the Twin Fidelity Watch's `sandboxes/slack/surfaces.ts` (`SEMANTIC_SURFACES`, in pome-cloud).
- **Numerator (19)** — surfaces with their own external-verification evidence,
  counted in distinct methods/tools (not capture instances):
  - **16 REST read methods**, shape-diffed daily against real Slack (the committed
    upstream golden). `conversations.info` and `conversations.history` are each
    captured under two scenarios (public/private channel, empty/non-empty history),
    so the table shows 18 read rows but 16 distinct methods.
  - **3 mutating MCP tools** (the two names F-1330 folded into
    `slack_send_message`, plus `slack_add_reaction`), write round-tripped
    against the seeded twin **oracle**
    (L2). This is L2-vs-oracle, **not** L1-vs-real-Slack — the daily cron does no
    mutating writes against the real workspace.
- **Rolling out (26)** — 5 read MCP tools (their underlying REST reads are verified;
  the MCP-envelope check rolls out next), 20 mutating REST methods (no write
  round-trip yet — including the `chat.postMessage` / `reactions.add` that back the
  3 verified MCP write tools, since the REST contract is verified separately), and
  `files.info` (not yet an L1 capture row; see the L1 read exception). A surface
  is counted only once it has its own evidence — never credited by proxy.

## Known divergences from real Slack

Each bullet has exactly one structured entry in the Twin Fidelity Watch's
`known-divergences/slack.yaml` (in pome-cloud)
(the `SL-DIV-NNN` machine mirror, enforced 1:1 by the fidelity lint, D9). The
read-subset / accepted-divergence bullets (9–15) were derived from the FDRS-473
real-Slack L1 reconciliation: the twin capture diffed against the committed
real-Slack golden, then triaged into upstream-only leaves the twin faithfully
omits (read_subset) and genuine identity / controlled-sandbox differences the
twin cannot reproduce (accepted_divergence). Twin-only OVER-returned fields were
FIXED in the twin source, not documented away.

_Behavioral / envelope choices:_

1. **Auth errors return HTTP 401** instead of real Slack's 200 + `{ok:false,
   error:"not_authed"}`. The choice aligns with RFC 6750 Bearer-Token
   semantics and is what the `@slack/web-api` SDK expects on bad tokens;
   401 is also what every MCP client expects. Application-level errors
   (e.g. `channel_not_found`, `name_taken`) DO return HTTP 200 to match
   real Slack and keep the SDK parseable.
2. **Hard delete** for `chat.delete` (matches Slack) — thread replies of a
   deleted parent are orphaned with their `thread_ts` pointing at a gone
   row. Real Slack soft-deletes the parent with a tombstone placeholder.
3. **No admin override** on `chat.update` / `chat.delete`. Real Slack also
   does not provide an admin override at the API layer; this is documented
   for clarity.
4. **`ts` is workspace-globally-unique** (matches real Slack); two channels'
   first messages produce distinct ts values.
5. **No RTM / Events / Socket Mode** — only HTTP REST + MCP JSON-RPC.
6. **No Slack Connect, Enterprise Grid, or admin scopes.**
7. **`files.upload` is the legacy v1 endpoint.** Real Slack's 2024-04
   deprecation of v1 in favor of `files.getUploadURLExternal` +
   `files.completeUploadExternal` is not yet implemented.
8. **`search.messages`** uses substring matching (LIKE), not Slack's
   query-grammar (modifiers like `in:`, `from:`, `before:` are not parsed).

_Read-subset field omissions (twin returns a documented subset):_

9. **Team objects omit Slack enterprise/internal flags.** `team.info` omits
   `is_verified`, `lob_sales_home_enabled`, and `is_sfdc_auto_slack` — the
   verified-org badge and Slack-internal Salesforce/auto-provision flags a
   non-Enterprise twin does not model. (`avatar_base_url` is `*_url` hypermedia,
   INFO categorically.)
10. **Channel objects omit Slack-Connect/viewer-state/rename metadata.**
    `conversations.list` / `.info` channel objects omit the Slack-Connect leaves
    (`is_ext_shared`, `shared_team_ids`, `pending_connected_team_ids`), the
    per-viewer state (`is_member`, `is_open`, `last_read`), the server `updated`
    mtime, the `properties` blob, and `previous_names` (the twin models no rename
    history — it omits the key rather than emitting an empty array).
11. **Message objects omit bot-identity/block/thread-fanout metadata.**
    `conversations.history` / `.replies` / `reactions.get` message objects omit
    `bot_id` / `app_id` / `bot_profile` (the seeded author is a user, not a bot
    app), the rich-text `blocks`, the thread-fanout convenience leaves
    (`thread_ts` on a parent, `reply_users`, `parent_user_id`, `is_locked`), and
    the `permalink` / `team` decoration.
12. **User-profile objects omit contact-card and derived-status leaves.** The
    `users.*` profile omits the unseed-ed contact card (`first_name`, `last_name`,
    `title`, `phone`, `skype`), the custom-`fields` blob, the derived status
    leaves (`status_text_canonical`, `status_emoji_display_info`,
    `status_clear_on_focus_end`), and `always_active`. (The per-endpoint
    `email`/`team` shape was FIXED in the twin to match real Slack.)
13. **Search match objects omit internal-search and shared-channel metadata.**
    `search.messages` matches omit Slack's `db_message` / `score` internals, the
    `blocks` / `no_reactions` leaves, and the per-match embedded `channel`'s full
    shared-channel flag set (`is_channel`, `is_group`, `is_im`, `is_mpim`,
    `is_shared`, `is_org_shared`, `is_ext_shared`, `is_archived`,
    `pending_shared`, `is_pending_ext_shared`).

_Accepted divergences (identity / controlled-sandbox):_

14. **`auth.test` `bot_id` reflects the capturing bot token, not the seeded user.**
    The golden was captured with a bot app token, so real Slack returns a `bot_id`
    string; the twin's seeded auth user is a regular user, so it returns
    `bot_id: null`. An inherent identity divergence — the bot id is a
    workspace-minted id the twin cannot reproduce.
15. **`conversations.members` #general count reflects the seed (3) vs the free workspace (bot+1).**
    The seed models three users in #general; the real free workspace's #general has
    only the bot plus the single creating human (a free workspace cannot be seeded
    with extra human members via a bot token). Unavoidable controlled-sandbox vs
    free-workspace membership difference, not a serializer bug.

_Shape-anchoring divergences (compile-time anchor to `@slack/web-api`):_

16. **Serializers are anchored to `@slack/web-api`, a source that lags real Slack on some fields.**
    The shape anchor (`src/upstream-types.ts`, FDRS-477) is the SDK's published
    response types, not real Slack's live wire format. The SDK trails Slack on some
    leaves (un-typed fresh fields, removed-but-still-served legacy fields), so a
    twin field the SDK does not type still surfaces as an emitted-not-in-upstream
    divergence even when real Slack returns it. The anchor is a compile-time subset
    guard, not a fidelity oracle — live capture (the FDRS-473 golden) outranks it.
17. **`serializePin` is left to live capture — `@slack/web-api`'s pin type is too thin.**
    `PinsListResponse.Item` models only `{comment, created, created_by, file, type}`:
    it has NO `message` and NO `channel`. The twin emits a MESSAGE pin
    (`type:"message"`, `channel`, `message`, `created`, `created_by`) whose two
    distinguishing fields are absent upstream, so the type would anchor only
    `created`/`created_by`/`type`. Anchoring it adds no real guard; `serializePin` is
    deliberately UNANCHORED and verified against the live golden instead.
18. **`serializeUserProfile` emits a twin-only `team` field.** `team` is not on the
    `@slack/web-api` profile type; the twin carries it for cross-endpoint convenience.
    Held out of the anchored `base` literal and spread back on the open Record.
19. **Channel objects emit twin-only `parent_conversation` and `members`.**
    `serializeChannel` carries `parent_conversation` (always `null` — the twin models
    no thread-parent conversations) and a conditional `members` count, neither on the
    anchored `SlackChannel`. Both are assigned on the Record after the anchor.
20. **Messages emit a twin-only `permalink`.** `serializeMessage` decorates a fetched
    message with a deterministic `permalink` the upstream `SlackMessage` does not
    carry. Held out of the anchored literal and merged on the Record.
21. **Scheduled messages emit a twin-only `thread_ts`.** `serializeScheduledMessage`
    carries `thread_ts` for scheduled thread replies; it is absent from
    `@slack/web-api`'s `ChatScheduledMessagesListResponse` item, so it is held out of
    the anchored `base` and spread back.

22. **`users.list` member count reflects the seeded world, not the live sandbox
    workspace.** The twin serves the users its seed declares;
    `pome-twin-sandbox.slack.com` holds whoever is installed in it, and it gained
    a bot user on 2026-08-10 when a second Slack app was installed. The L1
    upstream oracle fires `array-length-changed` on any exact count mismatch, so
    those two numbers can only ever agree by coincidence — and they did, until
    the 2026-08-11 re-baseline removed the coincidence. The COUNT is accepted in
    pome-cloud's registry and the per-member SHAPE is still compared; the same
    reasoning already covers `conversations.members`. F-1434.

23. **A plain-text message carries no `blocks` key; real Slack synthesises a `rich_text` block.**
    `serializeMessage` folds `blocks` into the message object only when the
    stored array is non-empty (`serializers.ts`: `...(blocks.length > 0 ?
    { blocks } : {})`), and `seed.ts` seeds no message with blocks — so every
    plain-text message, written or seeded, comes back with no `blocks` KEY at
    all. Real Slack BUILDS one instead. Measured live against
    `pome-twin-sandbox` on 2026-08-13: a text-only write returns a synthesised
    `rich_text` → `rich_text_section` block on `chat.postMessage`, `chat.update`
    AND `chat.scheduleMessage` — all three called separately, because F-1487
    established that these three validate independently, so one result does not
    generalise — and it PERSISTS into `conversations.history` with the same
    structure and a re-minted `block_id`. When the caller DOES send `blocks` no
    `rich_text` is added and only the caller's own block comes back, so the
    divergence is strictly the no-blocks case. NOT imitated, and that is the
    ruling rather than the cheap option: the synthesis is a PARSER, not a
    projection of the string the twin already stores. The same probe measured
    `*bold* _italic_ ~strike~` becoming styled elements
    (`{"type":"text","text":"bold","style":{"bold":true}}`), a bare URL becoming
    `{"type":"link","url":"https://example.invalid/path"}`, and `<#C0B77EBAB1C>`
    becoming `{"type":"channel","channel_id":"C0B77EBAB1C"}` — three element
    types no twin derives from a stored `text` string without shipping a mrkdwn
    parser, a URL detector and an entity resolver. A PARTIAL one emits a
    plausible-but-wrong block an agent mis-parses with confidence, which is
    strictly harder to detect than an honest absent key. The no-blocks case is
    asserted from pome-cloud by `sandboxes/slack/rest-writes.ts`, which until
    this entry only ever asserted the block text it SENT. F-1496.

24. **File objects omit thumbnail, collaborative-edit, per-file-ACL and
    Slack-AI metadata.** `serializeFile` emits 27 leaves; the file real Slack
    returns on `files.list` carries 41, and the 15 it has that the twin does not
    split cleanly in two. ELEVEN are leaves `@slack/web-api` types and this
    package's own compile-time anchor already declares deliberate omissions —
    they are in `File_Allow` (`test/upstream-coverage.types.ts`), which is the
    twin saying "known, not emitted": the per-file permission level `access`,
    the collaborative-edit trio `editors` / `edit_timestamp` /
    `update_notification`, the server-side `updated` mtime, the unread hint
    `show_badge`, the sharing-policy pair `teams_shared_with` /
    `is_restricted_sharing_enabled`, and the canvas-document leaves
    `quip_thread_id` / `title_blocks` / `url_static_preview`. FOUR are leaves the
    SDK does not type at all, so the anchor never saw them and only live capture
    could: `canvas_creator_id`, `canvas_readtime`, `is_ai_suggested` and
    `is_modified_by_ai` — the same SDK-lags-Slack situation divergence #16
    describes, one object over. The twin's `files` table is metadata-only (no
    binary storage, no thumbnails, no ACL model, no edit history), so all 15 are
    absent rather than wrong, and NONE is fabricated: `access: "write"` or an
    `updated` copied off `created` would be a plausible-but-wrong value an agent
    trusts, which is strictly harder to detect than an honest absent key (the
    same reasoning as #23). On an L1 READ surface an upstream-only leaf the twin
    omits is INFO, not drift. Measured 2026-08-13 against
    `pome-twin-sandbox`; unmeasurable before that, because the twin served
    `files: []` and the diff engine compares NO elements when either array side
    is empty. F-1509.

25. **A canvas is a FILE to real Slack and a separate entity here, so
    `files.list` does not enumerate canvases.** Real Slack stores a canvas in the
    file table: the only file in `pome-twin-sandbox` on 2026-08-13 was one, and
    it came back from `files.list` as an ordinary file row with
    `filetype: "quip"`, `mode: "quip"`, `pretty_type: "Canvas"` and
    `mimetype: "application/vnd.slack-docs"`. This twin keeps canvases in their
    own `canvases` table (`domain/canvases.ts`) — which is why reading one is
    `slack_read_canvas` rather than `files.info`, as the Wave-3 row in the
    capability table above already says — and `filesList` selects from `files`
    only. So `canvases.create` followed by `files.list` shows nothing, where real
    Slack shows the new canvas. NOT imitated here, and the reason is blast radius
    rather than difficulty: projecting a canvas row into a file row is
    mechanical, but it changes what `files.list` / `files.info` / `slack_read_file`
    return for every already-saved task whose criteria count or address files,
    and a criterion that silently starts seeing one more entity is the failure
    mode a twin change must not ship as a side effect. Registered as the fact it
    is; imitating it is its own decision, with its own re-verification of the
    task corpus. F-1509.

## Shape anchoring (compile-time, `@slack/web-api@7.16.0`)

The serializers are pinned to Slack's official response types at compile time
(`src/upstream-types.ts`, FDRS-477; mirrors twin-github FDRS-475/476). Each
serializer's literal `satisfies DeepPartial<Slack…>`, so a wrong-named or
mistyped field is a COMPILE error while omitting a field stays legal (the twin
is a faithful subset). The anchor target is `@slack/web-api@7.16.0`.

**Anchored (9 serializers).** `serializeWorkspace`, `serializeUserProfile`,
`serializeUser`, `serializeChannel`, `serializeMessage`, `groupReactions`
(array-element anchor), `serializeFile`, `serializeBookmark`, and
`serializeScheduledMessage` all `satisfies DeepPartial<…>` against their
`@slack/web-api` type. `serializeBookmark` is a perfect 1:1 (no held-out keys).
Where the row type is wider than upstream (`safeJsonArray` returns `unknown[]`,
nullable columns), the value is cast to the upstream leaf type; twin-only fields
(bullets 18–21) are held off the anchored literal and assigned on the Record.

**Left to live capture (1 serializer).** `serializePin` is unanchored: the SDK's
`PinsListResponse.Item` is too thin to model a message pin (bullet 17), so it is
verified against the FDRS-473 real-Slack golden instead of the type.

**Inverse weighting (live capture > anchor on Slack).** The `@slack/web-api`
types are a published SDK artifact that lags the live API, so they are a weaker
oracle here than the committed real-Slack golden. The anchor is the cheap
compile-time floor (catches typos and an upstream field-rename at build time);
the golden is the source of truth for what real Slack actually returns. When the
two disagree, the golden wins and the anchor's gap is recorded as a divergence
above — never the reverse.

## Verification commands

```bash
cd packages/twin-slack
npm run typecheck                       # zero TS errors
npx vitest run --project twin-slack     # all tests pass
npm run test:coverage -w @pome-sh/twin-slack  # ≥ 90% lines, ≥ 90% funcs
npm run validate:mcp                    # JSON-RPC SDK round-trip
npm run fidelity:parity                 # every MCP tool through /mcp/call (F-730)
TWIN_AUTH_SECRET=dev SLACK_DETERMINISTIC_TS=1 npm run smoke
npm run verify:cloud-token              # cloud xoxb-pome-* token validates
```

The tables above are 1:1-linted against the structured inventory
[`fidelity.inventory.json`](fidelity.inventory.json) (which also carries the
hot/warm/cold heat tier per F-729) by `test/fidelity-contract.test.ts`; the
same test enforces the heat discipline (no unclassified surfaces, hot ⇒
semantic, cold ⇒ unsupported, and the tier-mismatch ledger exactly matching
the warm-above-target set). The shared parity runner (`@pome-sh/sdk/parity`)
asserts the same inventory matches the live tool list and that a declarative
scenario exercises every tool.

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

**This twin declares 242 inputs across 62 published surfaces**
(69 query, 173 body), 0 of them required. Each carries its name, location,
requiredness and best-effort type, all *derived from the schemas that validate* —
requiredness by asking the validator whether the input may be absent, and type by
way of JSON Schema. Nothing here is hand-written, so nothing here can drift from
the handler.

This twin had no zod at all: every handler took a merged query+body bag from `readArgs(c)` and
picked fields out of it by name (`asString(args.channel)`), so the input names existed only as
property accesses. `/emoji.list` forwarded the whole bag to the domain untouched — the silent
hole F-1179 names. Slack mounts its reads on GET and POST both, so 44 endpoints are 62
declared surfaces; arguments are declared as `query` on GET and as `body` on POST, which is
what Slack's own documentation describes and what every client does. `token` is declared on
all 62 because the engine's query and form token resolvers both accept it.

The published artifact is
[`route-inputs.json`](route-inputs.json), regenerated by
`npm run emit:route-inputs` and byte-compared in CI by
`npm run gate:route-inputs`. It is read by pome-cloud's declared-fidelity lane
through the checkout seam it already has, which is what turns 1,130
vendor-declared inputs on matched surfaces from `not-compared` into a real
two-way comparison — and makes `missingRequired` live. Surfaces with no declared
inputs are omitted rather than published with an empty list: comparing nothing
against nothing would render as a match nobody measured.

### Undeclared inputs: `ignore` (F-1372)

**Slack accepts an argument it does not know and gets on with the call, so this
twin discards it too.** Measured 2026-08-09: `api.test` — the one Web API method
that answers without a token — returned
`{"ok":true,"args":{"pome_undeclared_probe":"x"}}` for the probe as a GET query
key and again as a POST form field. Slack's own Web API page names three ways to
pass arguments and no way to have one rejected, and its error vocabulary has no
`unknown_argument`; `invalid_arguments` — the code this twin refused with — is
for arguments a method HAS whose values are wrong. The transcript is in
[`docs/undeclared-route-inputs.md`](../../docs/undeclared-route-inputs.md).

This twin had the most to lose from the strict default: `token` is declared on
all 62 surfaces because it rides on every method, so a client sending one extra
field alongside it met a refusal everywhere at once.

Nothing above this heading changes. The handler still sees only what the
declaration names, and the 242 published inputs are byte-identical.
