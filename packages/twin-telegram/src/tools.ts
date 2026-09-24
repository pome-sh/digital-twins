// SPDX-License-Identifier: Apache-2.0
// Source names, descriptions, JSON schemas, and annotations come only from the
// source-derived fixture. Implementations below provide the twin-local behavior.
import { deriveMcpToolTable, loadMcpToolFixture, type McpToolImplementation } from "@pome-sh/sdk/mcp-tool-fixture";
import { z } from "zod";
import rawListing from "../fixtures/mcp-tools-list.raw.json" with { type: "json" };
import metaListing from "../fixtures/mcp-tools-list.meta.json" with { type: "json" };
import type { TelegramDomain } from "./domain.js";
import { telegramFail } from "./errors.js";
import { listStickerSets, resolveCatalogFile, resolveChatPhoto, type CatalogFile } from "./media-catalog.js";
import { accountFrom } from "./tool-adapters.js";

export const telegramMcpToolFixture = loadMcpToolFixture({ raw: rawListing, meta: metaListing });

type SourceResult = { result: string };
type SourceAccount = { account?: string };
type SourceChatId = number | string;
type InlineButton = { text: string; callback_data: string };

const accountSchema = z.string().optional();
const chatIdSchema = z.union([z.number().int(), z.string()]);

function sourceResult(value: unknown): SourceResult {
  // telegram-mcp's registered output schema is `{ result: string }`. Preserve
  // source text when the source operation returns text; structured twin values
  // are encoded in that string envelope.
  return { result: typeof value === "string" ? value : JSON.stringify(value) };
}

function numericChatId(chatId: SourceChatId): number {
  if (typeof chatId === "number") return chatId;
  if (/^-?\d+$/.test(chatId)) return Number(chatId);
  // The captured source also accepts usernames. The twin has no username-to-
  // chat mapping, so retain its normal member-visible-chat failure instead of
  // silently routing an unrecognized identifier somewhere else.
  telegramFail(400, 400, "Bad Request: chat not found");
}

function requireSourceAccount(args: SourceAccount, ctx: Parameters<McpToolImplementation<TelegramDomain>["handler"]>[2]): string {
  return accountFrom(args, ctx);
}

function inlineMessages(domain: TelegramDomain, account: string, chatId: number, limit: number): Array<{ message_id: number; buttons: InlineButton[] }> {
  const bounded = Math.max(0, limit);
  return domain
    .getHistory(account, chatId)
    .reverse()
    .flatMap((message) => {
      const messageId = message.message_id;
      if (typeof messageId !== "number") return [];
      const buttons = domain.listInlineButtons(account, { chat_id: chatId, message_id: messageId });
      return buttons.length > 0 ? [{ message_id: messageId, buttons }] : [];
    })
    .slice(0, bounded);
}

function inlineTarget(
  domain: TelegramDomain,
  account: string,
  chatId: number,
  messageId: number | string | null | undefined,
): { messageId: number; buttons: InlineButton[] } {
  if (messageId !== undefined && messageId !== null) {
    const numericMessageId = typeof messageId === "number" ? messageId : Number(messageId);
    if (!Number.isInteger(numericMessageId)) telegramFail(400, 400, "Bad Request: inline button not found");
    return {
      messageId: numericMessageId,
      buttons: domain.listInlineButtons(account, { chat_id: chatId, message_id: numericMessageId }),
    };
  }
  const [recent] = inlineMessages(domain, account, chatId, 1);
  if (!recent) telegramFail(400, 400, "Bad Request: inline button not found");
  return { messageId: recent.message_id, buttons: recent.buttons };
}

function limitReactionUsersPerCategory(reactions: Record<string, unknown>[], limit: number): Record<string, unknown>[] {
  const categoryCounts = new Map<string, number>();
  return reactions.filter((reaction) => {
    const category = JSON.stringify(reaction.reaction);
    const count = categoryCounts.get(category) ?? 0;
    if (count >= limit) return false;
    categoryCounts.set(category, count + 1);
    return true;
  });
}

const implementations: Record<string, McpToolImplementation<TelegramDomain>> = {
  list_accounts: {
    schema: z.looseObject({}),
    mutation: false,
    handler: (domain) =>
      sourceResult(
        domain
          .listAccounts()
          .map(({ account, first_name }) => `${account}: ${first_name} (+N/A) — unknown`)
          .join("\n"),
      ),
    contentText: (output) => (output as SourceResult).result,
  },
  get_me: {
    schema: z.looseObject({ account: accountSchema }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const account = requireSourceAccount(args as SourceAccount, ctx);
      return sourceResult(domain.getMe({ kind: "user", account }));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  pin_message: {
    schema: z.looseObject({ chat_id: chatIdSchema, message_id: z.number().int(), account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; message_id: number } & SourceAccount;
      const account = requireSourceAccount(input, ctx);
      const chatId = numericChatId(input.chat_id);
      const result = domain.pinChatMessage({ kind: "user", account }, { chat_id: chatId, message_id: input.message_id }, ctx.reportDelta);
      return sourceResult(result);
    },
    contentText: (output) => (output as SourceResult).result,
  },
  unpin_message: {
    schema: z.looseObject({ chat_id: chatIdSchema, message_id: z.number().int(), account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; message_id: number } & SourceAccount;
      const account = requireSourceAccount(input, ctx);
      const chatId = numericChatId(input.chat_id);
      const result = domain.unpinChatMessage({ kind: "user", account }, { chat_id: chatId, message_id: input.message_id }, ctx.reportDelta);
      return sourceResult(result);
    },
    contentText: (output) => (output as SourceResult).result,
  },
  unpin_all_messages: {
    schema: z.looseObject({ chat_id: chatIdSchema, account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId } & SourceAccount;
      const account = requireSourceAccount(input, ctx);
      const result = domain.unpinAllChatMessages({ kind: "user", account }, { chat_id: numericChatId(input.chat_id) }, ctx.reportDelta);
      return sourceResult(result);
    },
    contentText: (output) => (output as SourceResult).result,
  },
  get_pinned_messages: {
    schema: z.looseObject({ chat_id: chatIdSchema, account: accountSchema }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId } & SourceAccount;
      return sourceResult(domain.getPinnedMessages(requireSourceAccount(input, ctx), { chat_id: numericChatId(input.chat_id) }));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  create_poll: {
    schema: z.looseObject({
      chat_id: z.number().int(),
      question: z.string(),
      // The captured source schema deliberately leaves option items unconstrained.
      options: z.array(z.unknown()),
      multiple_choice: z.boolean().optional(),
      quiz_mode: z.boolean().optional(),
      public_votes: z.boolean().optional(),
      close_date: z.string().nullable().optional(),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as {
        chat_id: number;
        question: string;
        options: unknown[];
        multiple_choice?: boolean;
        quiz_mode?: boolean;
        public_votes?: boolean;
        close_date?: string | null;
      } & SourceAccount;
      if (input.quiz_mode || input.close_date !== undefined && input.close_date !== null) {
        telegramFail(400, 400, "Bad Request: quiz mode and close date are unsupported");
      }
      if (!input.options.every((option): option is string => typeof option === "string")) {
        telegramFail(400, 400, "Bad Request: poll options must be strings");
      }
      const result = domain.createPollForUser(requireSourceAccount(input, ctx), {
        chat_id: input.chat_id,
        question: input.question,
        options: input.options,
        allows_multiple_answers: input.multiple_choice,
        is_anonymous: input.public_votes === undefined ? undefined : !input.public_votes,
      }, ctx.reportDelta);
      return sourceResult(result);
    },
    contentText: (output) => (output as SourceResult).result,
  },
  send_reaction: {
    schema: z.looseObject({ chat_id: chatIdSchema, message_id: z.number().int(), emoji: z.string(), big: z.boolean().optional(), account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; message_id: number; emoji: string; big?: boolean } & SourceAccount;
      if (input.big) telegramFail(400, 400, "Bad Request: big reactions are unsupported");
      const account = requireSourceAccount(input, ctx);
      const result = domain.setMessageReaction({ kind: "user", account }, {
        chat_id: numericChatId(input.chat_id),
        message_id: input.message_id,
        reaction: [{ type: "emoji", emoji: input.emoji }],
      }, ctx.reportDelta);
      return sourceResult(result);
    },
    contentText: (output) => (output as SourceResult).result,
  },
  remove_reaction: {
    schema: z.looseObject({ chat_id: chatIdSchema, message_id: z.number().int(), account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; message_id: number } & SourceAccount;
      const account = requireSourceAccount(input, ctx);
      const result = domain.setMessageReaction({ kind: "user", account }, {
        chat_id: numericChatId(input.chat_id),
        message_id: input.message_id,
        reaction: [],
      }, ctx.reportDelta);
      return sourceResult(result);
    },
    contentText: (output) => (output as SourceResult).result,
  },
  get_message_reactions: {
    schema: z.looseObject({ chat_id: chatIdSchema, message_id: z.number().int(), limit: z.number().int().optional(), account: accountSchema }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; message_id: number; limit?: number } & SourceAccount;
      const reactions = domain.getMessageReactions(requireSourceAccount(input, ctx), {
        chat_id: numericChatId(input.chat_id),
        message_id: input.message_id,
      });
      return sourceResult(limitReactionUsersPerCategory(reactions, Math.max(0, input.limit ?? 50)));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  list_inline_buttons: {
    schema: z.looseObject({ chat_id: chatIdSchema, message_id: z.union([z.number().int(), z.string(), z.null()]).optional(), limit: z.number().int().optional(), account: accountSchema }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; message_id?: number | string | null; limit?: number } & SourceAccount;
      const account = requireSourceAccount(input, ctx);
      const chatId = numericChatId(input.chat_id);
      if (input.message_id !== undefined && input.message_id !== null) {
        return sourceResult(inlineTarget(domain, account, chatId, input.message_id).buttons);
      }
      return sourceResult(inlineMessages(domain, account, chatId, input.limit ?? 20));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  press_inline_button: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      message_id: z.union([z.number().int(), z.string(), z.null()]).optional(),
      button_text: z.string().nullable().optional(),
      button_index: z.number().int().nullable().optional(),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as {
        chat_id: SourceChatId;
        message_id?: number | string | null;
        button_text?: string | null;
        button_index?: number | null;
      } & SourceAccount;
      const account = requireSourceAccount(input, ctx);
      const chatId = numericChatId(input.chat_id);
      const target = inlineTarget(domain, account, chatId, input.message_id);
      const button = input.button_index !== undefined && input.button_index !== null
        ? target.buttons[input.button_index]
        : input.button_text === undefined || input.button_text === null
          ? undefined
          : target.buttons.find(({ text }) => text.toLowerCase() === input.button_text!.toLowerCase());
      if (!button) telegramFail(400, 400, "Bad Request: inline button not found");
      const result = domain.pressInlineButton(account, {
        chat_id: chatId,
        message_id: target.messageId,
        callback_data: button.callback_data,
      }, ctx.reportDelta);
      return sourceResult(result);
    },
    contentText: (output) => (output as SourceResult).result,
  },
  get_media_info: {
    schema: z.looseObject({ chat_id: chatIdSchema, message_id: z.number().int(), account: accountSchema }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; message_id: number } & SourceAccount;
      return sourceResult(domain.getMediaInfo(requireSourceAccount(input, ctx), {
        chat_id: numericChatId(input.chat_id),
        message_id: input.message_id,
      }));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  download_media: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      message_id: z.number().int(),
      file_path: z.string().nullable().optional(),
      account: accountSchema,
    }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; message_id: number; file_path?: string | null } & SourceAccount;
      if (input.file_path !== undefined && input.file_path !== null) {
        telegramFail(400, 400, "Bad Request: destination file paths are unsupported");
      }
      const downloaded = domain.downloadVisibleMedia(requireSourceAccount(input, ctx), {
        chat_id: numericChatId(input.chat_id),
        message_id: input.message_id,
      });
      return sourceResult({ ...downloaded.info, content_base64: downloaded.content.toString("base64") });
    },
    contentText: (output) => (output as SourceResult).result,
  },
  send_file: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      file_path: z.union([z.string(), z.array(z.string())]),
      caption: z.string().nullable().optional(),
      topic_id: z.number().int().nullable().optional(),
      schedule_date: z.union([z.string(), z.number().int(), z.null()]).optional(),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as {
        chat_id: SourceChatId;
        file_path: string | string[];
        caption?: string | null;
        topic_id?: number | null;
        schedule_date?: string | number | null;
      } & SourceAccount;
      if (input.schedule_date !== undefined && input.schedule_date !== null) telegramFail(400, 400, "Bad Request: scheduled sends are unsupported");
      if (Array.isArray(input.file_path)) telegramFail(400, 400, "Bad Request: media groups are unsupported");
      const account = requireSourceAccount(input, ctx);
      const result = domain.sendMedia({ kind: "user", account }, {
        chat_id: numericChatId(input.chat_id),
        kind: "document",
        media: catalogMedia(resolveCatalogFile(input.file_path, "document")),
        caption: input.caption ?? undefined,
        message_thread_id: input.topic_id ?? undefined,
      }, ctx.reportDelta);
      return sourceResult(result);
    },
    contentText: (output) => (output as SourceResult).result,
  },
  send_voice: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      file_path: z.string(),
      topic_id: z.number().int().nullable().optional(),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; file_path: string; topic_id?: number | null } & SourceAccount;
      const account = requireSourceAccount(input, ctx);
      const result = domain.sendMedia({ kind: "user", account }, {
        chat_id: numericChatId(input.chat_id),
        kind: "voice",
        media: catalogMedia(resolveCatalogFile(input.file_path, "voice")),
        message_thread_id: input.topic_id ?? undefined,
      }, ctx.reportDelta);
      return sourceResult(result);
    },
    contentText: (output) => (output as SourceResult).result,
  },
  send_sticker: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      file_path: z.string(),
      topic_id: z.number().int().nullable().optional(),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; file_path: string; topic_id?: number | null } & SourceAccount;
      const account = requireSourceAccount(input, ctx);
      const result = domain.sendMedia({ kind: "user", account }, {
        chat_id: numericChatId(input.chat_id),
        kind: "sticker",
        media: catalogMedia(resolveCatalogFile(input.file_path, "sticker")),
        message_thread_id: input.topic_id ?? undefined,
      }, ctx.reportDelta);
      return sourceResult(result);
    },
    contentText: (output) => (output as SourceResult).result,
  },
  get_sticker_sets: {
    schema: z.looseObject({ account: accountSchema }),
    mutation: false,
    handler: (_domain, args, ctx) => {
      requireSourceAccount(args as SourceAccount, ctx);
      return sourceResult(listStickerSets());
    },
    contentText: (output) => (output as SourceResult).result,
  },
  create_group: {
    schema: z.looseObject({
      title: z.string(),
      user_ids: z.array(z.union([z.number().int(), z.string()])),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { title: string; user_ids: Array<number | string> } & SourceAccount;
      return sourceResult(domain.createGroup(requireSourceAccount(input, ctx), input, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  invite_to_group: {
    schema: z.looseObject({
      group_id: chatIdSchema,
      user_ids: z.array(z.union([z.number().int(), z.string()])),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { group_id: SourceChatId; user_ids: Array<number | string> } & SourceAccount;
      return sourceResult(domain.inviteToGroup(requireSourceAccount(input, ctx), {
        group_id: numericChatId(input.group_id),
        user_ids: input.user_ids,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  leave_chat: {
    schema: z.looseObject({ chat_id: chatIdSchema, account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId } & SourceAccount;
      return sourceResult(domain.leaveChat({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.chat_id),
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  get_participants: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      page: z.number().int().optional(),
      page_size: z.number().int().optional(),
      account: accountSchema,
    }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; page?: number; page_size?: number } & SourceAccount;
      return sourceResult(domain.getParticipants(requireSourceAccount(input, ctx), {
        chat_id: numericChatId(input.chat_id),
        page: input.page,
        page_size: input.page_size,
      }));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  edit_chat_title: {
    schema: z.looseObject({ chat_id: chatIdSchema, title: z.string(), account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; title: string } & SourceAccount;
      return sourceResult(domain.setChatTitle({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.chat_id),
        title: input.title,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  edit_chat_about: {
    schema: z.looseObject({ chat_id: chatIdSchema, about: z.string(), account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; about: string } & SourceAccount;
      return sourceResult(domain.setChatDescription({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.chat_id),
        description: input.about,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  edit_chat_photo: {
    schema: z.looseObject({ chat_id: chatIdSchema, file_path: z.string(), account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; file_path: string } & SourceAccount;
      const account = requireSourceAccount(input, ctx);
      return sourceResult(domain.editChatPhoto({ kind: "user", account }, {
        chat_id: numericChatId(input.chat_id),
        media: catalogMedia(resolveChatPhoto(input.file_path)),
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  delete_chat_photo: {
    schema: z.looseObject({ chat_id: chatIdSchema, account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId } & SourceAccount;
      return sourceResult(domain.deleteChatPhoto({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.chat_id),
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  promote_admin: {
    schema: z.looseObject({
      group_id: chatIdSchema,
      user_id: z.union([z.number().int(), z.string()]),
      rights: z.record(z.string(), z.unknown()).nullable().optional(),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { group_id: SourceChatId; user_id: number | string; rights?: Record<string, unknown> | null } & SourceAccount;
      return sourceResult(domain.promoteChatMember({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.group_id),
        user_id: input.user_id,
        rights: input.rights ?? undefined,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  demote_admin: {
    schema: z.looseObject({
      group_id: chatIdSchema,
      user_id: z.union([z.number().int(), z.string()]),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { group_id: SourceChatId; user_id: number | string } & SourceAccount;
      return sourceResult(domain.demoteChatMember({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.group_id),
        user_id: input.user_id,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  ban_user: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      user_id: z.union([z.number().int(), z.string()]),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; user_id: number | string } & SourceAccount;
      return sourceResult(domain.banChatMember({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.chat_id),
        user_id: input.user_id,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  unban_user: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      user_id: z.union([z.number().int(), z.string()]),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; user_id: number | string } & SourceAccount;
      return sourceResult(domain.unbanChatMember({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.chat_id),
        user_id: input.user_id,
        only_if_banned: true,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  remove_user: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      user_id: z.union([z.number().int(), z.string()]),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; user_id: number | string } & SourceAccount;
      return sourceResult(domain.removeUser({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.chat_id),
        user_id: input.user_id,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  set_default_chat_permissions: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      send_messages: z.boolean().optional(),
      send_media: z.boolean().optional(),
      send_stickers: z.boolean().optional(),
      send_gifs: z.boolean().optional(),
      send_games: z.boolean().optional(),
      send_inline: z.boolean().optional(),
      embed_links: z.boolean().optional(),
      send_polls: z.boolean().optional(),
      change_info: z.boolean().optional(),
      invite_users: z.boolean().optional(),
      pin_messages: z.boolean().optional(),
      until_date: z.number().int().optional(),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as {
        chat_id: SourceChatId;
        send_messages?: boolean;
        send_media?: boolean;
        send_stickers?: boolean;
        send_gifs?: boolean;
        send_games?: boolean;
        send_inline?: boolean;
        embed_links?: boolean;
        send_polls?: boolean;
        change_info?: boolean;
        invite_users?: boolean;
        pin_messages?: boolean;
        until_date?: number;
      } & SourceAccount;
      return sourceResult(domain.setChatPermissions({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.chat_id),
        permissions: pickBooleanFlags(input, SOURCE_PERMISSION_FLAGS),
        until_date: input.until_date,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  toggle_slow_mode: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      seconds: z.number().int().optional(),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; seconds?: number } & SourceAccount;
      return sourceResult(domain.toggleSlowMode({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.chat_id),
        seconds: input.seconds,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  edit_admin_rights: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      user_id: z.union([z.number().int(), z.string()]),
      rank: z.string().optional(),
      change_info: z.boolean().optional(),
      post_messages: z.boolean().optional(),
      edit_messages: z.boolean().optional(),
      delete_messages: z.boolean().optional(),
      ban_users: z.boolean().optional(),
      invite_users: z.boolean().optional(),
      pin_messages: z.boolean().optional(),
      add_admins: z.boolean().optional(),
      anonymous: z.boolean().optional(),
      manage_call: z.boolean().optional(),
      manage_topics: z.boolean().optional(),
      other: z.boolean().optional(),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as {
        chat_id: SourceChatId;
        user_id: number | string;
        rank?: string;
        change_info?: boolean;
        post_messages?: boolean;
        edit_messages?: boolean;
        delete_messages?: boolean;
        ban_users?: boolean;
        invite_users?: boolean;
        pin_messages?: boolean;
        add_admins?: boolean;
        anonymous?: boolean;
        manage_call?: boolean;
        manage_topics?: boolean;
        other?: boolean;
      } & SourceAccount;
      const flags = pickBooleanFlags(input, SOURCE_ADMIN_RIGHT_FLAGS);
      return sourceResult(domain.editAdminRights({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: numericChatId(input.chat_id),
        user_id: input.user_id,
        rank: input.rank,
        rights: Object.keys(flags).length > 0 ? flags : undefined,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  get_admins: {
    schema: z.looseObject({ chat_id: chatIdSchema, account: accountSchema }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId } & SourceAccount;
      return sourceResult(domain.getAdmins(requireSourceAccount(input, ctx), { chat_id: numericChatId(input.chat_id) }));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  get_banned_users: {
    schema: z.looseObject({ chat_id: chatIdSchema, account: accountSchema }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId } & SourceAccount;
      return sourceResult(domain.getBannedUsers(requireSourceAccount(input, ctx), { chat_id: numericChatId(input.chat_id) }));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  get_recent_actions: {
    schema: z.looseObject({ chat_id: chatIdSchema, account: accountSchema }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId } & SourceAccount;
      return sourceResult(domain.getRecentActions(requireSourceAccount(input, ctx), { chat_id: numericChatId(input.chat_id) }));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  subscribe_public_channel: {
    schema: z.looseObject({ channel: chatIdSchema, account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { channel: SourceChatId } & SourceAccount;
      return sourceResult(domain.subscribePublicChannel(requireSourceAccount(input, ctx), { channel: input.channel }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  list_topics: {
    schema: z.looseObject({
      chat_id: z.number().int(),
      limit: z.number().int().optional(),
      offset_topic: z.number().int().optional(),
      search_query: z.string().nullable().optional(),
      account: accountSchema,
    }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: number; limit?: number; offset_topic?: number; search_query?: string | null } & SourceAccount;
      return sourceResult(domain.listTopics(requireSourceAccount(input, ctx), input));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  enable_forum_topics: {
    schema: z.looseObject({ chat_id: chatIdSchema, tabs: z.boolean().optional(), account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; tabs?: boolean } & SourceAccount;
      return sourceResult(domain.enableForumTopics(requireSourceAccount(input, ctx), {
        chat_id: domain.resolveChatRef(input.chat_id),
        tabs: input.tabs,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  create_forum_topic: {
    schema: z.looseObject({
      chat_id: chatIdSchema,
      title: z.string(),
      icon_color: z.number().int().nullable().optional(),
      icon_emoji_id: z.number().int().nullable().optional(),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId; title: string; icon_color?: number | null; icon_emoji_id?: number | null } & SourceAccount;
      return sourceResult(domain.createForumTopic({ kind: "user", account: requireSourceAccount(input, ctx) }, {
        chat_id: domain.resolveChatRef(input.chat_id),
        title: input.title,
        icon_color: input.icon_color,
        icon_emoji_id: input.icon_emoji_id,
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  search_public_chats: {
    schema: z.looseObject({ query: z.string(), limit: z.number().int().optional(), account: accountSchema }),
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as { query: string; limit?: number } & SourceAccount;
      return sourceResult(domain.searchPublicChats(requireSourceAccount(input, ctx), input));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  create_channel: {
    schema: z.looseObject({
      title: z.string(),
      about: z.string().optional(),
      megagroup: z.boolean().optional(),
      account: accountSchema,
    }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { title: string; about?: string; megagroup?: boolean } & SourceAccount;
      return sourceResult(domain.createChannel(requireSourceAccount(input, ctx), input, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  get_invite_link: {
    schema: z.looseObject({ chat_id: chatIdSchema, account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId } & SourceAccount;
      return sourceResult(domain.getInviteLink(requireSourceAccount(input, ctx), {
        chat_id: domain.resolveChatRef(input.chat_id),
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  join_chat_by_link: {
    schema: z.looseObject({ link: z.string(), account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { link: string } & SourceAccount;
      return sourceResult(domain.joinChatByLink(requireSourceAccount(input, ctx), input, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  export_chat_invite: {
    schema: z.looseObject({ chat_id: chatIdSchema, account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { chat_id: SourceChatId } & SourceAccount;
      return sourceResult(domain.exportChatInvite(requireSourceAccount(input, ctx), {
        chat_id: domain.resolveChatRef(input.chat_id),
      }, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
  import_chat_invite: {
    schema: z.looseObject({ hash: z.string(), account: accountSchema }),
    mutation: true,
    handler: (domain, args, ctx) => {
      const input = args as { hash: string } & SourceAccount;
      return sourceResult(domain.importChatInvite(requireSourceAccount(input, ctx), input, ctx.reportDelta));
    },
    contentText: (output) => (output as SourceResult).result,
  },
};

function catalogMedia(source: CatalogFile | string): { bytes: Buffer; filename: string; mimeType: string } | string {
  return typeof source === "string" ? source : { bytes: source.bytes, filename: source.filename, mimeType: source.mimeType };
}

const SOURCE_ADMIN_RIGHT_FLAGS = [
  "change_info",
  "post_messages",
  "edit_messages",
  "delete_messages",
  "ban_users",
  "invite_users",
  "pin_messages",
  "add_admins",
  "anonymous",
  "manage_call",
  "manage_topics",
  "other",
] as const;

const SOURCE_PERMISSION_FLAGS = [
  "send_messages",
  "send_media",
  "send_stickers",
  "send_gifs",
  "send_games",
  "send_inline",
  "embed_links",
  "send_polls",
  "change_info",
  "invite_users",
  "pin_messages",
] as const;

function pickBooleanFlags<K extends string>(input: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, boolean>> {
  const flags: Partial<Record<K, boolean>> = {};
  for (const key of keys) {
    if (typeof input[key] === "boolean") flags[key] = input[key];
  }
  return flags;
}

export const telegramTools = deriveMcpToolTable(telegramMcpToolFixture, implementations);
