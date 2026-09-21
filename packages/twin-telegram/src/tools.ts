// SPDX-License-Identifier: Apache-2.0
import { loadMcpToolFixture } from "@pome-sh/sdk/mcp-tool-fixture";
import { z } from "zod";
import type { ToolCallContext } from "@pome-sh/sdk";
import metaListing from "../fixtures/mcp-tools-list.meta.json" with { type: "json" };
import rawListing from "../fixtures/mcp-tools-list.raw.json" with { type: "json" };
import type { TelegramDomain } from "./domain.js";
import { accountFrom } from "./tool-adapters.js";

export const telegramToolFixture = loadMcpToolFixture({ raw: rawListing, meta: metaListing });

const account = { account: z.string().optional() };

export const toolSchemas = {
  get_me: z.looseObject(account),
  list_accounts: z.looseObject({}),
  _manifest: z.looseObject({}),
  list_chats: z.looseObject(account),
  get_chat: z.looseObject({ ...account, chat_id: z.number().int() }),
  get_history: z.looseObject({ ...account, chat_id: z.number().int() }),
  send_message: z.looseObject({ ...account, chat_id: z.number().int(), text: z.string() }),
  reply_to_message: z.looseObject({
    ...account,
    chat_id: z.number().int(),
    message_id: z.number().int(),
    text: z.string(),
  }),
  get_messages: z.looseObject({
    ...account,
    chat_id: z.number().int(),
    message_id: z.number().int(),
    limit: z.number().int().optional(),
  }),
  search_messages: z.looseObject({ ...account, chat_id: z.number().int(), query: z.string() }),
  search_global: z.looseObject({ ...account, query: z.string() }),
  edit_message: z.looseObject({
    ...account,
    chat_id: z.number().int(),
    message_id: z.number().int(),
    text: z.string(),
  }),
  delete_message: z.looseObject({
    ...account,
    chat_id: z.number().int(),
    message_id: z.number().int(),
    revoke: z.boolean().optional(),
  }),
  forward_message: z.looseObject({
    ...account,
    chat_id: z.number().int(),
    from_chat_id: z.number().int(),
    message_id: z.number().int(),
  }),
  get_message_context: z.looseObject({
    ...account,
    chat_id: z.number().int(),
    message_id: z.number().int(),
    limit: z.number().int().optional(),
  }),
  message_from_link: z.looseObject({ ...account, link: z.string() }),
  get_message_link: z.looseObject({ ...account, chat_id: z.number().int(), message_id: z.number().int() }),
  mark_as_read: z.looseObject({ ...account, chat_id: z.number().int(), message_id: z.number().int() }),
  get_message_viewers: z.looseObject({ ...account, chat_id: z.number().int(), message_id: z.number().int() }),
};

export const MUTATING_TOOL_NAMES = new Set([
  "send_message",
  "reply_to_message",
  "edit_message",
  "delete_message",
  "forward_message",
  "mark_as_read",
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name);
}

export function executeTool(
  domain: TelegramDomain,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): unknown {
  const accountName = () => accountFrom(args as { account?: string }, ctx);
  const actor = () => ({ kind: "user" as const, account: accountName() });
  switch (name) {
    case "get_me":
      return domain.getMe(actor());
    case "list_accounts":
      return domain.listAccounts();
    case "_manifest":
      return domain.manifest();
    case "list_chats":
      return domain.listChats(accountName());
    case "get_chat":
      return domain.getChat(actor(), args.chat_id as number);
    case "get_history":
      return domain.getHistory(accountName(), args.chat_id as number);
    case "send_message":
      return domain.sendMessage(actor(), { chat_id: args.chat_id as number, text: args.text as string }, ctx.reportDelta);
    case "reply_to_message":
      return domain.sendMessage(
        actor(),
        {
          chat_id: args.chat_id as number,
          text: args.text as string,
          reply_to_message_id: args.message_id as number,
        },
        ctx.reportDelta,
      );
    case "get_messages":
    case "get_message_context":
      return domain.getMessages(accountName(), {
        chat_id: args.chat_id as number,
        message_id: args.message_id as number,
        limit: args.limit as number | undefined,
      });
    case "search_messages":
      return domain.searchMessages(accountName(), { chat_id: args.chat_id as number, query: args.query as string });
    case "search_global":
      return domain.searchMessages(accountName(), { query: args.query as string });
    case "edit_message":
      return domain.editMessageText(
        actor(),
        { chat_id: args.chat_id as number, message_id: args.message_id as number, text: args.text as string },
        ctx.reportDelta,
      );
    case "delete_message":
      return domain.deleteMessage(actor(), {
        chat_id: args.chat_id as number,
        message_id: args.message_id as number,
        revoke: args.revoke as boolean | undefined,
      });
    case "forward_message":
      return domain.forwardMessage(
        actor(),
        {
          chat_id: args.chat_id as number,
          from_chat_id: args.from_chat_id as number,
          message_id: args.message_id as number,
        },
        ctx.reportDelta,
      );
    case "message_from_link":
      return domain.messageFromLink(accountName(), args.link as string);
    case "get_message_link":
      return domain.getMessageLink(accountName(), {
        chat_id: args.chat_id as number,
        message_id: args.message_id as number,
      });
    case "mark_as_read":
      return domain.markAsRead(accountName(), { chat_id: args.chat_id as number, message_id: args.message_id as number });
    case "get_message_viewers":
      return domain.getMessageViewers(accountName(), {
        chat_id: args.chat_id as number,
        message_id: args.message_id as number,
      });
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
