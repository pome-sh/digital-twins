// SPDX-License-Identifier: Apache-2.0
// `@pome-sh/sdk/mcp-tool-fixture` rather than the `@pome-sh/sdk` root: the root
// barrel re-exports `openTwinDatabase`, so importing it EXECUTES `db.ts`'s
// `import { DatabaseSync } from "node:sqlite"`. pome-cloud's fidelity-watch
// loads twin tool tables under bun, which implements no `node:sqlite`, and this
// file's own dependencies are a fixture loader, zod and types. The loader module
// has no imports at all.
import { loadMcpToolFixture } from "@pome-sh/sdk/mcp-tool-fixture";
import { z } from "zod";
import type { StateDelta } from "@pome-sh/wire";
import metaListing from "../fixtures/mcp-tools-list.meta.json" with { type: "json" };
import rawListing from "../fixtures/mcp-tools-list.raw.json" with { type: "json" };
import type { SlackDomain } from "./domain/index.js";
import {
  canvasChanges,
  filterChannels,
  filterEmoji,
  filterMembers,
} from "./tool-adapters.js";

/**
 * The tool table Slack serves. Every name, description, input schema and
 * annotation on the wire comes from this fixture; nothing below declares one
 * (F-1325).
 *
 * Since F-1330 the fixture is SLACK'S — F-1329's live OAuth capture of
 * `https://mcp.slack.com/mcp`, minus the one tool the heat ruling says this
 * twin does not expose. Before it, these were eleven names commit 6abec3c
 * copied out of `modelcontextprotocol/servers-archived/src/slack`; only three
 * of them existed at Slack at all, and even those three took different
 * parameters. An examinee written against real Slack emitted
 * `slack_send_message`, the twin answered only `slack_post_message`, and the
 * exam scored a failure the agent did not commit.
 */
export const slackToolFixture = loadMcpToolFixture({ raw: rawListing, meta: metaListing });

/**
 * How each tool's arguments are validated, keyed by the name the fixture
 * declares.
 *
 * `z.looseObject`, and that is the second half of the F-1330 fix. This table
 * used to be `z.strictObject`, which the old fixture projected to
 * `additionalProperties:false` — so a call that finally got the NAME right and
 * carried a real Slack parameter (`message`, `reply_broadcast`, `oldest`,
 * `cursor`, `response_format`) was hard-rejected anyway. No `inputSchema` in
 * Slack's own listing declares `additionalProperties`, so none of these may
 * reject on one. `toolSchemaConformance()` in `tool-schema-conformance.ts`
 * holds the two together: every key here must be a key Slack declares, the
 * required sets must agree, and every schema must still accept an unknown key.
 *
 * Optionality and type come from the fixture's `required` list and property
 * types. Where Slack says `integer` these say `z.number().int()`.
 */
export const toolSchemas = {
  slack_send_message: z.looseObject({
    channel_id: z.string(),
    message: z.string(),
    thread_ts: z.string().optional(),
    reply_broadcast: z.boolean().optional(),
    draft_id: z.string().optional(),
    unfurl_app_links: z.boolean().optional(),
  }),
  slack_schedule_message: z.looseObject({
    channel_id: z.string(),
    message: z.string(),
    post_at: z.number().int(),
    thread_ts: z.string().optional(),
    reply_broadcast: z.boolean().optional(),
  }),
  slack_add_reaction: z.looseObject({
    channel_id: z.string(),
    message_ts: z.string(),
    emoji: z.string(),
  }),
  slack_create_conversation: z.looseObject({
    user_ids: z.array(z.string()).optional(),
    channel_name: z.string().optional(),
    is_private: z.boolean().optional(),
  }),
  slack_create_canvas: z.looseObject({
    title: z.string(),
    content: z.string(),
  }),
  slack_update_canvas: z.looseObject({
    canvas_id: z.string(),
    sections: z
      .array(
        z.looseObject({
          edit_type: z.enum(["append", "prepend", "replace", "delete"]),
          section_id: z.string().optional(),
          content: z.string().optional(),
        })
      )
      .optional(),
    action: z.enum(["append", "prepend", "replace"]).optional(),
    content: z.string().optional(),
    section_id: z.string().optional(),
  }),
  slack_search_public: z.looseObject({
    query: z.string(),
    content_types: z.string().optional(),
    context_channel_id: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    include_bots: z.boolean().optional(),
    sort: z.string().optional(),
    sort_dir: z.string().optional(),
    response_format: z.string().optional(),
    include_context: z.boolean().optional(),
    max_context_length: z.number().int().optional(),
    only_my_channels: z.boolean().optional(),
  }),
  slack_search_public_and_private: z.looseObject({
    query: z.string(),
    channel_types: z.string().optional(),
    content_types: z.string().optional(),
    context_channel_id: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    include_bots: z.boolean().optional(),
    sort: z.string().optional(),
    sort_dir: z.string().optional(),
    response_format: z.string().optional(),
    include_context: z.boolean().optional(),
    max_context_length: z.number().int().optional(),
    only_my_channels: z.boolean().optional(),
  }),
  slack_search_channels: z.looseObject({
    query: z.string(),
    channel_types: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.number().int().optional(),
    response_format: z.string().optional(),
    include_archived: z.boolean().optional(),
  }),
  slack_search_users: z.looseObject({
    query: z.string(),
    cursor: z.string().optional(),
    limit: z.number().int().optional(),
    response_format: z.string().optional(),
  }),
  slack_read_channel: z.looseObject({
    channel_id: z.string(),
    limit: z.number().int().optional(),
    cursor: z.string().optional(),
    latest: z.string().optional(),
    oldest: z.string().optional(),
    response_format: z.string().optional(),
  }),
  slack_read_thread: z.looseObject({
    channel_id: z.string(),
    message_ts: z.string(),
    limit: z.number().int().optional(),
    cursor: z.string().optional(),
    latest: z.string().optional(),
    oldest: z.string().optional(),
    response_format: z.string().optional(),
  }),
  slack_read_canvas: z.looseObject({
    canvas_id: z.string(),
  }),
  slack_read_user_profile: z.looseObject({
    user_id: z.string().optional(),
    include_locale: z.boolean().optional(),
    response_format: z.string().optional(),
  }),
  slack_list_channel_members: z.looseObject({
    channel_id: z.string(),
    limit: z.number().int().optional(),
    cursor: z.string().optional(),
    response_format: z.string().optional(),
    include_deleted: z.boolean().optional(),
    include_bots: z.boolean().optional(),
  }),
  slack_read_file: z.looseObject({
    file_id: z.string(),
  }),
  slack_search_emojis: z.looseObject({
    query: z.string(),
  }),
  slack_get_reactions: z.looseObject({
    channel_id: z.string(),
    message_ts: z.string(),
  }),
} as const satisfies Record<string, z.ZodType>;

/**
 * The six tools Slack annotates `readOnlyHint: false`. This is recorder truth
 * for `state_mutation`, so it is asserted against the fixture's annotations in
 * the contract suite rather than kept in step by hand.
 */
export const MUTATING_TOOL_NAMES = new Set<string>([
  "slack_send_message",
  "slack_schedule_message",
  "slack_add_reaction",
  "slack_create_conversation",
  "slack_create_canvas",
  "slack_update_canvas",
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name);
}

export function executeTool(
  domain: SlackDomain,
  name: string,
  args: Record<string, unknown>,
  onDelta?: (delta: StateDelta) => void,
  actor: { login?: string } = {}
): unknown {
  const schema = (toolSchemas as Record<string, z.ZodType | undefined>)[name];
  if (!schema) throw new Error(`Unknown tool: ${name}`);
  const parsed = schema.parse(args);
  const delta = (d: StateDelta) => onDelta?.(d);
  switch (name) {
    case "slack_send_message": {
      const p = parsed as {
        channel_id: string;
        message: string;
        thread_ts?: string;
        reply_broadcast?: boolean;
      };
      // One tool, two of the old ones: Slack folded the thread reply into the
      // send via `thread_ts`, which is where `chat.postMessage` always put it.
      return domain.chatPostMessage(
        {
          channel: p.channel_id,
          text: p.message,
          thread_ts: p.thread_ts,
          reply_broadcast: p.reply_broadcast,
        },
        actor,
        delta
      );
    }
    case "slack_schedule_message": {
      const p = parsed as {
        channel_id: string;
        message: string;
        post_at: number;
        thread_ts?: string;
      };
      return domain.chatScheduleMessage(
        { channel: p.channel_id, text: p.message, post_at: p.post_at, thread_ts: p.thread_ts },
        actor,
        delta
      );
    }
    case "slack_add_reaction": {
      const p = parsed as { channel_id: string; message_ts: string; emoji: string };
      return domain.reactionsAdd(
        { channel: p.channel_id, timestamp: p.message_ts, name: p.emoji },
        actor,
        delta
      );
    }
    case "slack_create_conversation": {
      const p = parsed as { user_ids?: string[]; channel_name?: string; is_private?: boolean };
      if (p.channel_name) {
        const created = domain.conversationsCreate(
          { name: p.channel_name, is_private: p.is_private },
          actor,
          delta
        ) as { channel?: { id?: string } };
        const channelId = created.channel?.id;
        if (p.user_ids && p.user_ids.length > 0 && channelId) {
          domain.conversationsInvite({ channel: channelId, users: p.user_ids.join(",") }, actor, delta);
          return domain.conversationsInfo({ channel: channelId }, actor);
        }
        return created;
      }
      if (p.user_ids && p.user_ids.length > 0) {
        return domain.conversationsOpen({ users: p.user_ids.join(","), return_im: true }, actor, delta);
      }
      // Slack's own error vocabulary for the call that picked neither mode.
      throw new Error("invalid_arguments");
    }
    case "slack_create_canvas": {
      const p = parsed as { title: string; content: string };
      return domain.canvasesCreate(
        { title: p.title, document_content: { type: "markdown", markdown: p.content } },
        actor,
        delta
      );
    }
    case "slack_update_canvas": {
      const p = parsed as {
        canvas_id: string;
        sections?: Array<{ edit_type: string; section_id?: string; content?: string }>;
        action?: string;
        content?: string;
        section_id?: string;
      };
      return domain.canvasesEdit({ canvas_id: p.canvas_id, changes: canvasChanges(p) }, actor, delta);
    }
    case "slack_search_public": {
      const p = parsed as { query: string; limit?: number; sort?: string; sort_dir?: string };
      return domain.searchMessages(
        { query: p.query, count: p.limit, sort: p.sort, sort_dir: p.sort_dir, scope: "public" },
        actor
      );
    }
    case "slack_search_public_and_private": {
      const p = parsed as { query: string; limit?: number; sort?: string; sort_dir?: string };
      return domain.searchMessages(
        { query: p.query, count: p.limit, sort: p.sort, sort_dir: p.sort_dir, scope: "all" },
        actor
      );
    }
    case "slack_search_channels": {
      const p = parsed as {
        query: string;
        channel_types?: string;
        limit?: number;
        cursor?: string;
        include_archived?: boolean;
      };
      return filterChannels(
        domain.conversationsList({
          types: p.channel_types,
          limit: p.limit,
          cursor: p.cursor,
          // Slack's flag is the inverse of the Web API's, and its default is
          // to leave archived channels out — so an absent `include_archived`
          // has to become `exclude_archived: true`, not `undefined`.
          exclude_archived: p.include_archived !== true,
        }),
        p.query
      );
    }
    case "slack_search_users": {
      const p = parsed as { query: string; limit?: number; cursor?: string };
      return filterMembers(domain.usersList({ limit: p.limit, cursor: p.cursor }), p.query);
    }
    case "slack_read_channel": {
      const p = parsed as {
        channel_id: string;
        limit?: number;
        cursor?: string;
        latest?: string;
        oldest?: string;
      };
      return domain.conversationsHistory(
        {
          channel: p.channel_id,
          limit: p.limit,
          cursor: p.cursor,
          latest: p.latest,
          oldest: p.oldest,
        },
        actor
      );
    }
    case "slack_read_thread": {
      const p = parsed as {
        channel_id: string;
        message_ts: string;
        limit?: number;
        cursor?: string;
        latest?: string;
        oldest?: string;
      };
      return domain.conversationsReplies(
        {
          channel: p.channel_id,
          ts: p.message_ts,
          limit: p.limit,
          cursor: p.cursor,
          latest: p.latest,
          oldest: p.oldest,
        },
        actor
      );
    }
    case "slack_read_canvas": {
      const p = parsed as { canvas_id: string };
      return domain.canvasesRead({ canvas_id: p.canvas_id }, actor);
    }
    case "slack_read_user_profile": {
      const p = parsed as { user_id?: string; include_locale?: boolean };
      // `user_id` is optional upstream and defaults to the calling user, which
      // is what `usersProfileGet` already does with an absent `user`.
      void p.include_locale;
      return domain.usersProfileGet({ user: p.user_id }, actor);
    }
    case "slack_list_channel_members": {
      const p = parsed as { channel_id: string; limit?: number; cursor?: string };
      return domain.conversationsMembers(
        { channel: p.channel_id, limit: p.limit, cursor: p.cursor },
        actor
      );
    }
    case "slack_read_file": {
      const p = parsed as { file_id: string };
      return domain.filesInfo({ file: p.file_id });
    }
    case "slack_search_emojis": {
      const p = parsed as { query: string };
      return filterEmoji(domain.emojiList(), p.query);
    }
    case "slack_get_reactions": {
      const p = parsed as { channel_id: string; message_ts: string };
      return domain.reactionsGet({ channel: p.channel_id, timestamp: p.message_ts }, actor);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
