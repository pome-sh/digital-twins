// SPDX-License-Identifier: Apache-2.0
import { loadMcpToolFixture } from "@pome-sh/sdk/mcp-tool-fixture";
import { z } from "zod";
import type { ToolCallContext } from "@pome-sh/sdk";
import metaListing from "../fixtures/mcp-tools-list.meta.json" with { type: "json" };
import rawListing from "../fixtures/mcp-tools-list.raw.json" with { type: "json" };
import type { TelegramDomain } from "./domain.js";
import { accountFrom } from "./tool-adapters.js";

export const telegramToolFixture = loadMcpToolFixture({ raw: rawListing, meta: metaListing });

export const toolSchemas = {
  get_me: z.looseObject({ account: z.string().optional() }),
  list_accounts: z.looseObject({}),
  _manifest: z.looseObject({}),
  list_chats: z.looseObject({ account: z.string().optional() }),
  get_chat: z.looseObject({ account: z.string().optional(), chat_id: z.number().int() }),
  get_history: z.looseObject({
    account: z.string().optional(),
    chat_id: z.number().int(),
  }),
  send_message: z.looseObject({
    account: z.string().optional(),
    chat_id: z.number().int(),
    text: z.string(),
  }),
  reply_to_message: z.looseObject({
    account: z.string().optional(),
    chat_id: z.number().int(),
    message_id: z.number().int(),
    text: z.string(),
  }),
};

export const MUTATING_TOOL_NAMES = new Set(["send_message", "reply_to_message"]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name);
}

export function executeTool(
  domain: TelegramDomain,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): unknown {
  switch (name) {
    case "get_me":
      return domain.getMe({ kind: "user", account: accountFrom(args as { account?: string }, ctx) });
    case "list_accounts":
      return domain.listAccounts();
    case "_manifest":
      return domain.manifest();
    case "list_chats":
      return domain.listChats(accountFrom(args as { account?: string }, ctx));
    case "get_chat":
      return domain.getChat(
        { kind: "user", account: accountFrom(args as { account?: string }, ctx) },
        (args as { chat_id: number }).chat_id,
      );
    case "get_history":
      return domain.getHistory(accountFrom(args as { account?: string }, ctx), (args as { chat_id: number }).chat_id);
    case "send_message":
      return domain.sendMessage(
        { kind: "user", account: accountFrom(args as { account?: string }, ctx) },
        { chat_id: (args as { chat_id: number }).chat_id, text: (args as { text: string }).text },
        ctx.reportDelta,
      );
    case "reply_to_message":
      return domain.sendMessage(
        { kind: "user", account: accountFrom(args as { account?: string }, ctx) },
        {
          chat_id: (args as { chat_id: number }).chat_id,
          text: (args as { text: string }).text,
          reply_to_message_id: (args as { message_id: number }).message_id,
        },
        ctx.reportDelta,
      );
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
