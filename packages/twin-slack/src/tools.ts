// SPDX-License-Identifier: Apache-2.0
import { loadMcpToolFixture } from "@pome-sh/sdk";
import { z } from "zod";
import type { StateDelta } from "@pome-sh/wire";
import metaListing from "../fixtures/mcp-tools-list.meta.json" with { type: "json" };
import rawListing from "../fixtures/mcp-tools-list.raw.json" with { type: "json" };
import type { SlackDomain } from "./domain/index.js";

/**
 * The tool table Slack serves. Every name, description, input schema and
 * annotation on the wire comes from this fixture; nothing below declares one
 * (F-1325).
 *
 * Its substrate is `twin-code-transcription` and its provenance says so
 * plainly: these eleven names were copied into TypeScript from an archived
 * reference server by commit 6abec3c and have never been compared to Slack's
 * own `tools/list`. Eight of them are believed to exist on no Slack
 * deployment. This file is deliberately not the place that gets fixed —
 * reporting the divergence is F-1327 and renaming is F-1330.
 */
export const slackToolFixture = loadMcpToolFixture({ raw: rawListing, meta: metaListing });

/**
 * How each tool's arguments are validated. `z.strictObject` is load-bearing:
 * the frozen draft-7 projection in `slackToolInputSchema` turns it into the
 * `additionalProperties:false` the fixture carries, and `toolSchemasMatchFixture`
 * in the test suite pins the two together so a schema edit here cannot drift
 * from the listing Slack advertises.
 */
export const toolSchemas = {
  slack_post_message: z
    .strictObject({
      channel_id: z.string(),
      text: z.string(),
    })
    .strict(),
  slack_reply_to_thread: z
    .strictObject({
      channel_id: z.string(),
      thread_ts: z.string(),
      text: z.string(),
    })
    .strict(),
  slack_add_reaction: z
    .strictObject({
      channel_id: z.string(),
      timestamp: z.string(),
      reaction: z.string(),
    })
    .strict(),
  slack_get_channel_history: z
    .strictObject({
      channel_id: z.string(),
      limit: z.number().optional(),
    })
    .strict(),
  slack_get_thread_replies: z
    .strictObject({
      channel_id: z.string(),
      thread_ts: z.string(),
    })
    .strict(),
  slack_list_channels: z
    .strictObject({
      limit: z.number().optional(),
      cursor: z.string().optional(),
    })
    .strict(),
  slack_get_users: z
    .strictObject({
      cursor: z.string().optional(),
      limit: z.number().optional(),
    })
    .strict(),
  slack_get_user_profile: z
    .strictObject({
      user_id: z.string(),
    })
    .strict(),
  slack_search_messages: z
    .strictObject({
      query: z.string(),
      count: z.number().optional(),
      page: z.number().optional(),
    })
    .strict(),
  slack_get_reactions: z
    .strictObject({
      channel_id: z.string(),
      timestamp: z.string(),
    })
    .strict(),
  slack_list_channel_members: z
    .strictObject({
      channel_id: z.string(),
      limit: z.number().optional(),
      cursor: z.string().optional(),
    })
    .strict(),
} as const satisfies Record<string, z.ZodType>;

export const MUTATING_TOOL_NAMES = new Set<string>([
  "slack_post_message",
  "slack_reply_to_thread",
  "slack_add_reaction",
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name);
}

type ToolJsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

/**
 * The frozen wire projection of a Slack tool's arguments: draft-7, with
 * `additionalProperties:false` forced on. This is how every `inputSchema` in
 * `mcp-tools-list.raw.json` was produced. Nothing serves it any more — the
 * fixture does — but the test suite still runs it over every schema above and
 * compares, so the validator and the declaration cannot part company.
 */
export function slackToolInputSchema(schema: z.ZodType): ToolJsonSchema {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return {
    type: "object",
    properties: (json.properties as Record<string, unknown>) ?? {},
    required: (json.required as string[]) ?? [],
    additionalProperties: false,
  };
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
    case "slack_post_message": {
      const p = parsed as { channel_id: string; text: string };
      return domain.chatPostMessage({ channel: p.channel_id, text: p.text }, actor, delta);
    }
    case "slack_reply_to_thread": {
      const p = parsed as { channel_id: string; thread_ts: string; text: string };
      return domain.chatPostMessage(
        { channel: p.channel_id, thread_ts: p.thread_ts, text: p.text },
        actor,
        delta
      );
    }
    case "slack_add_reaction": {
      const p = parsed as { channel_id: string; timestamp: string; reaction: string };
      return domain.reactionsAdd(
        { channel: p.channel_id, timestamp: p.timestamp, name: p.reaction },
        actor,
        delta
      );
    }
    case "slack_get_channel_history": {
      const p = parsed as { channel_id: string; limit?: number };
      return domain.conversationsHistory({ channel: p.channel_id, limit: p.limit }, actor);
    }
    case "slack_get_thread_replies": {
      const p = parsed as { channel_id: string; thread_ts: string };
      return domain.conversationsReplies({ channel: p.channel_id, ts: p.thread_ts }, actor);
    }
    case "slack_list_channels": {
      const p = parsed as { limit?: number; cursor?: string };
      return domain.conversationsList({ limit: p.limit, cursor: p.cursor });
    }
    case "slack_get_users": {
      const p = parsed as { cursor?: string; limit?: number };
      return domain.usersList({ cursor: p.cursor, limit: p.limit });
    }
    case "slack_get_user_profile": {
      const p = parsed as { user_id: string };
      return domain.usersProfileGet({ user: p.user_id }, actor);
    }
    case "slack_search_messages": {
      const p = parsed as { query: string; count?: number; page?: number };
      return domain.searchMessages({ query: p.query, count: p.count, page: p.page }, actor);
    }
    case "slack_get_reactions": {
      const p = parsed as { channel_id: string; timestamp: string };
      return domain.reactionsGet({ channel: p.channel_id, timestamp: p.timestamp }, actor);
    }
    case "slack_list_channel_members": {
      const p = parsed as { channel_id: string; limit?: number; cursor?: string };
      return domain.conversationsMembers(
        { channel: p.channel_id, limit: p.limit, cursor: p.cursor },
        actor
      );
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
