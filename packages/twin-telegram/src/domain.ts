// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { StateDelta } from "@pome-sh/wire";
import { resetDatabase, type TelegramTwinDatabase } from "./db.js";
import { telegramFail } from "./errors.js";
import {
  serializeChat,
  serializeMessage,
  serializeUser,
  type ChatRow,
  type MessageRow,
  type UserRow,
} from "./serializers.js";
import {
  ADMIN_LOG_LIMIT,
  DEFAULT_CHAT_PERMISSIONS,
  DEFAULT_PROMOTE_RIGHTS,
  FULL_ADMIN_RIGHTS,
  ZERO_ADMIN_RIGHTS,
  allPermissionsAllowed,
  effectivePermissions,
  noAdminRights,
  parseAdminRights,
  parseChatPermissions,
  parseSlowMode,
  parseUntilDate,
  requireChatPermissions,
  presentParticipant,
  requireAdminTitle,
  requireChatAbout,
  requireChatTitle,
  rightsSubset,
  serializeChatMember,
  type AdminRights,
  type ChatPermissions,
  type MemberStatus,
} from "./membership.js";
import { defaultSeedState, parseSeed, type TelegramSeed } from "./seed.js";
import {
  MAX_WEBHOOK_BATCH,
  UPDATE_RETENTION_SEC,
  telegramUpdateRuntime,
  webhookUrlError,
  type TelegramWebhookDelivery,
  type WebhookDrainResult,
} from "./updates.js";

export type DeltaHook = (delta: StateDelta) => void;
const NOOP: DeltaHook = () => {};

export type Actor =
  | { kind: "bot"; botId: number; sid?: string }
  | { kind: "user"; account: string };

type PersonRow = { id: number; first_name: string; username: string | null; is_bot: number };

export const BOT_DELETE_WINDOW_SEC = 48 * 3600;
export const CALLBACK_QUERY_TTL_SEC = 60;
export const MAX_CALLBACK_DATA_BYTES = 64;
export const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Extra encoded multipart framing accepted above uploaded attachment bytes. */
export const MAX_MULTIPART_FRAMING_BYTES = 1024 * 1024;
export const MAX_MEDIA_MULTIPART_REQUEST_BYTES = MAX_MEDIA_UPLOAD_BYTES + MAX_MULTIPART_FRAMING_BYTES;
/** Total bytes uploaded as attachments in one multipart media album. */
export const MAX_MEDIA_GROUP_UPLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_MEDIA_GROUP_MULTIPART_REQUEST_BYTES = MAX_MEDIA_GROUP_UPLOAD_BYTES + MAX_MULTIPART_FRAMING_BYTES;
export const MEDIA_TTL_SEC = 24 * 3600;
export const MAX_CAPTION_UTF16 = 1024;

type MediaUpload = { bytes: Buffer; filename?: string; mimeType?: string };
type MediaReference = string | MediaUpload;
type MediaFileRow = { file_id: string; bot_id: number; scope_id: string; file_unique_id: string; file_name: string | null; mime_type: string | null; size: number; sha256: string; content: Buffer; expires_at: number };
export const MAX_POLL_QUESTION_LENGTH = 300;
export const MAX_POLL_OPTION_LENGTH = 100;
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 10;

export function isCallbackData(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_CALLBACK_DATA_BYTES;
}

function aggregateDeltas(deltas: StateDelta[]): StateDelta {
  return {
    before: { mutations: deltas.map((delta) => delta?.before ?? null) },
    after: { mutations: deltas.map((delta) => delta?.after ?? null) },
  };
}

function validatePoll(question: string, options: string[]): void {
  if (
    question.length === 0 ||
    question.length > MAX_POLL_QUESTION_LENGTH ||
    options.length < MIN_POLL_OPTIONS ||
    options.length > MAX_POLL_OPTIONS ||
    options.some((option) => option.length === 0 || option.length > MAX_POLL_OPTION_LENGTH)
  ) {
    telegramFail(
      400,
      400,
      `Bad Request: poll question (1-${MAX_POLL_QUESTION_LENGTH} characters) and ${MIN_POLL_OPTIONS}-${MAX_POLL_OPTIONS} options (1-${MAX_POLL_OPTION_LENGTH} characters) are required`,
    );
  }
}

type ReplyMarkup =
  | { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
  | { reply_keyboard: Array<Array<{ text: string }>> }
  | { remove_keyboard: true };

type PollRow = {
  poll_id: string;
  chat_id: number;
  message_id: number;
  question: string;
  options_json: string;
  is_anonymous: number;
  allows_multiple_answers: number;
  is_closed: number;
  created_by_bot_id: number;
  created_at: number;
};

export class TelegramDomain {
  private readonly runtime: ReturnType<typeof telegramUpdateRuntime>;
  private readonly callbackWaiters = new Map<string, Set<() => void>>();

  constructor(
    readonly db: TelegramTwinDatabase,
    readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly localWebhookUrls: ReadonlySet<string> = new Set(),
    registerRuntime = true,
  ) {
    this.runtime = telegramUpdateRuntime(db);
    if (registerRuntime) this.runtime.registerDispatcher(() => this.flushWebhookOutbox(), now);
  }

  seed(input: TelegramSeed | unknown): void {
    const state = parseSeed(input);
    this.runtime.cancelAll();
    for (const waiters of this.callbackWaiters.values()) for (const wake of waiters) wake();
    this.callbackWaiters.clear();
    const now = this.now();
    this.db.transaction(() => {
      resetDatabase(this.db);
      for (const bot of state.bots) {
        this.db.prepare("INSERT INTO bots (id, token, first_name, username) VALUES (?, ?, ?, ?)").run(
          bot.id,
          bot.token,
          bot.first_name,
          bot.username,
        );
      }
      for (const user of state.users) {
        this.db.prepare("INSERT INTO users (id, account, first_name, username) VALUES (?, ?, ?, ?)").run(
          user.id,
          user.account,
          user.first_name,
          user.username ?? null,
        );
      }
      for (const chat of state.chats) {
        const creatorId = chat.type === "private"
          ? null
          : (chat.members.find((id) => state.users.some((user) => user.id === id)) ?? chat.members[0] ?? null);
        this.db.prepare(
          "INSERT INTO chats (id, type, title, description, photo_file_id, permissions_json, permissions_until, slow_mode_seconds, creator_id, next_message_id, next_admin_log_id) VALUES (?, ?, ?, NULL, NULL, ?, 0, 0, ?, 1, 1)",
        ).run(chat.id, chat.type, chat.title ?? null, JSON.stringify(DEFAULT_CHAT_PERMISSIONS), creatorId);
        for (const member of chat.members) {
          const status = creatorId === member ? "creator" : "member";
          this.db.prepare(
            "INSERT INTO chat_members (chat_id, user_id, status, admin_rights_json, restrictions_json, until_date, custom_title, is_anonymous) VALUES (?, ?, ?, NULL, NULL, 0, NULL, 0)",
          ).run(chat.id, member, status);
        }
      }
      for (const message of state.messages) {
        this.db
          .prepare(
            "INSERT INTO messages (chat_id, message_id, from_id, text, date, reply_to_message_id, edit_date, forward_from_id, forward_from_chat_id) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)",
          )
          .run(
            message.chat_id,
            message.message_id,
            message.from_id,
            message.text,
            message.date ?? now,
            message.reply_to_message_id ?? null,
          );
        this.db
          .prepare(
            "UPDATE chats SET next_message_id = CASE WHEN next_message_id > ? THEN next_message_id ELSE ? END WHERE id = ?",
          )
          .run(message.message_id + 1, message.message_id + 1, message.chat_id);
      }
    })();
  }

  applySeed(input: unknown): void {
    this.seed(input);
  }

  resetToDefault(factory: () => TelegramSeed = defaultSeedState): void {
    this.seed(factory());
  }

  lookupBotToken(token: string): { sid: string; bot_id: number; bot_username: string } | undefined {
    const row = this.db.prepare("SELECT id, username FROM bots WHERE token = ?").get(token) as
      | { id: number; username: string }
      | undefined;
    if (!row) return undefined;
    return { sid: "local", bot_id: row.id, bot_username: row.username };
  }

  getMe(actor: Actor): Record<string, unknown> {
    const person = this.personFor(actor);
    return serializeUser(this.asUser(person));
  }

  getChat(actor: Actor, chatId: number): Record<string, unknown> {
    this.requireMember(actor, chatId);
    return this.presentChat(this.chat(chatId));
  }

  sendMessage(
    actor: Actor,
    args: {
      chat_id: number;
      text: string;
      reply_to_message_id?: number;
      forward_from_id?: number;
      forward_from_chat_id?: number;
      reply_markup?: unknown;
    },
    delta: DeltaHook = NOOP,
  ): Record<string, unknown> {
    if (!args.text) telegramFail(400, 400, "Bad Request: message text is empty");
    this.requireMember(actor, args.chat_id);
    this.assertCanSend(actor, args.chat_id, "messages");
    if (args.reply_to_message_id !== undefined) {
      this.requireVisibleMessage(actor, args.chat_id, args.reply_to_message_id);
    }
    const from = this.personFor(actor);
    const replyMarkup = args.reply_markup === undefined ? undefined : this.parseReplyMarkup(args.reply_markup);
    const date = this.now();
    const emittedBotIds: number[] = [];
    const next = this.db.transaction(() => {
      const allocated = (this.db.prepare("SELECT next_message_id AS next FROM chats WHERE id = ?").get(args.chat_id) as {
        next: number;
      }).next;
      this.db.prepare("UPDATE chats SET next_message_id = next_message_id + 1 WHERE id = ?").run(args.chat_id);
      this.db
        .prepare(
          "INSERT INTO messages (chat_id, message_id, from_id, text, date, reply_to_message_id, edit_date, forward_from_id, forward_from_chat_id, reply_markup_json) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
        )
        .run(
          args.chat_id,
          allocated,
          from.id,
          args.text,
          date,
          args.reply_to_message_id ?? null,
          args.forward_from_id ?? null,
          args.forward_from_chat_id ?? null,
          replyMarkup ? JSON.stringify(replyMarkup) : null,
        );
      if (actor.kind === "user") {
        const message = serializeMessage(
          {
            chat_id: args.chat_id,
            message_id: allocated,
            from_id: from.id,
            text: args.text,
            date,
            reply_to_message_id: args.reply_to_message_id ?? null,
            forward_from_id: args.forward_from_id ?? null,
            forward_from_chat_id: args.forward_from_chat_id ?? null,
            reply_markup_json: replyMarkup ? JSON.stringify(replyMarkup) : null,
          },
          this.asUser(from),
          this.chat(args.chat_id),
        );
        emittedBotIds.push(...this.enqueueMessageUpdates(args.chat_id, message, date));
      }
      return allocated;
    })();
    for (const botId of emittedBotIds) this.runtime.notify(botId);
    const row: MessageRow = {
      chat_id: args.chat_id,
      message_id: next,
      from_id: from.id,
      text: args.text,
      date,
      reply_to_message_id: args.reply_to_message_id ?? null,
      forward_from_id: args.forward_from_id ?? null,
      forward_from_chat_id: args.forward_from_chat_id ?? null,
      reply_markup_json: replyMarkup ? JSON.stringify(replyMarkup) : null,
    };
    delta({
      before: null,
      after: { chat_id: args.chat_id, message_id: next, text: args.text, from_id: from.id },
    });
    return serializeMessage(row, this.asUser(from), this.chat(args.chat_id));
  }

  sendMedia(
    actor: Actor,
    args: { chat_id: number; kind: "photo" | "document" | "video" | "audio" | "voice" | "sticker"; media: MediaReference; caption?: string },
    delta: DeltaHook = NOOP,
  ): Record<string, unknown> {
    const { ownerId, scopeId } = this.mediaOwner(actor);
    this.requireMember(actor, args.chat_id);
    this.assertCanSend(actor, args.chat_id, args.kind === "photo" ? "photos" : args.kind === "document" ? "documents" : args.kind === "video" ? "videos" : args.kind === "audio" ? "audios" : args.kind === "voice" ? "voice_notes" : "other_messages");
    const caption = this.validateCaption(args.caption);
    const media = this.resolveMedia(ownerId, scopeId, args.media);
    const emittedBotIds: number[] = [];
    const result = this.db.transaction(() => {
      const file = this.persistMedia(ownerId, scopeId, media);
      const message = this.insertMediaMessage(actor, args.chat_id, args.kind, file, caption);
      if (actor.kind === "user") {
        emittedBotIds.push(...this.enqueueMessageUpdates(args.chat_id, message, message.date as number));
      }
      return message;
    })();
    for (const botId of emittedBotIds) this.runtime.notify(botId);
    delta({ before: null, after: { chat_id: args.chat_id, message_id: result.message_id, media: args.kind } });
    return result;
  }

  getMediaInfo(account: string, args: { chat_id: number; message_id: number }): Record<string, unknown> {
    return this.loadVisibleMedia(account, args).info;
  }

  downloadVisibleMedia(account: string, args: { chat_id: number; message_id: number }): {
    info: Record<string, unknown>;
    content: Buffer;
  } {
    const { info, file } = this.loadVisibleMedia(account, args);
    return { info, content: Buffer.from(file.content) };
  }

  sendMediaGroup(
    actor: Actor,
    args: { chat_id: number; media: Array<{ type: "photo" | "document" | "video" | "audio"; media: MediaReference; caption?: string }> },
    delta: DeltaHook = NOOP,
  ): Record<string, unknown>[] {
    const botId = this.botId(actor);
    const scopeId = this.mediaScope(actor);
    this.requireMember(actor, args.chat_id);
    const sendKind = { photo: "photos", document: "documents", video: "videos", audio: "audios" } as const;
    for (const item of args.media) this.assertCanSend(actor, args.chat_id, sendKind[item.type]);
    if (args.media.length < 2 || args.media.length > 10) telegramFail(400, 400, "Bad Request: media group must include 2-10 items");
    // Keep an explicit total even when an HTTP transport omits Content-Length.
    // Stored file references contribute no request bytes; every uploaded file is
    // still individually capped by resolveMedia below.
    const uploadBytes = args.media.reduce(
      (total, item) => total + (typeof item.media === "string" ? 0 : item.media.bytes.length),
      0,
    );
    if (uploadBytes > MAX_MEDIA_GROUP_UPLOAD_BYTES) {
      telegramFail(400, 400, `Bad Request: media group uploads must total at most ${MAX_MEDIA_GROUP_UPLOAD_BYTES} bytes`);
    }
    // Resolve every reference before writing anything: a failed album is atomic.
    const resolved = args.media.map((item) => ({ ...item, caption: this.validateCaption(item.caption), resolved: this.resolveMedia(botId, scopeId, item.media) }));
    // The next message id distinguishes otherwise identical albums submitted in
    // the same second by the same bot.
    const firstMessageId = (this.db.prepare("SELECT next_message_id AS next FROM chats WHERE id = ?").get(args.chat_id) as { next: number }).next;
    const mediaGroupId = `album:${botId}:${this.now()}:${args.chat_id}:${firstMessageId}`;
    const result = this.db.transaction(() => resolved.map((item) => {
      const file = this.persistMedia(botId, scopeId, item.resolved);
      return this.insertMediaMessage(actor, args.chat_id, item.type, file, item.caption, mediaGroupId);
    }))();
    delta({ before: null, after: { chat_id: args.chat_id, media_group_id: mediaGroupId, count: result.length } });
    return result;
  }

  editMessageCaption(
    actor: Actor,
    args: { chat_id: number; message_id: number; caption?: string },
    delta: DeltaHook = NOOP,
  ): Record<string, unknown> {
    const row = this.requireVisibleMessage(actor, args.chat_id, args.message_id);
    const person = this.personFor(actor);
    if (row.from_id !== person.id || !row.media_json) telegramFail(400, 400, "Bad Request: message can't be edited");
    const caption = this.validateCaption(args.caption);
    if (row.text === caption) return this.present(row);
    const editDate = this.now();
    this.db.prepare("UPDATE messages SET text = ?, edit_date = ? WHERE chat_id = ? AND message_id = ?").run(caption, editDate, args.chat_id, args.message_id);
    delta({ before: { caption: row.text }, after: { caption, message_id: args.message_id } });
    return this.present({ ...row, text: caption, edit_date: editDate });
  }

  getFile(actor: Actor, fileId: string): Record<string, unknown> {
    this.botId(actor);
    this.purgeExpiredMedia();
    const row = this.accessibleMediaFile(actor, fileId);
    if (!row) telegramFail(400, 400, "Bad Request: file not found");
    return { file_id: row.file_id, file_unique_id: row.file_unique_id, file_size: row.size, file_path: `media/${row.file_id}` };
  }

  downloadFile(actor: Actor, path: string): { content: Buffer; mimeType: string | null } {
    this.botId(actor);
    this.purgeExpiredMedia();
    // The only path accepted is the one getFile emitted. It is an opaque handle,
    // not a filesystem pathname; traversal, separators, and symlinks cannot escape SQLite.
    if (!/^media\/file_\d+_[a-f0-9]{8}_[a-f0-9]{32}$/.test(path)) telegramFail(400, 400, "Bad Request: file not found");
    const fileId = path.slice("media/".length);
    const row = this.accessibleMediaFile(actor, fileId);
    if (!row) telegramFail(404, 404, "Not Found");
    return { content: Buffer.from(row.content), mimeType: row.mime_type };
  }

  sendChatAction(actor: Actor, args: { chat_id: number; action: string }): true {
    this.botId(actor);
    this.requireMember(actor, args.chat_id);
    if (!["typing", "upload_photo", "record_video", "upload_video", "record_voice", "upload_voice", "upload_document", "choose_sticker", "find_location", "record_video_note", "upload_video_note"].includes(args.action)) telegramFail(400, 400, "Bad Request: unsupported chat action");
    return true;
  }

  listAccounts(): Array<{ account: string; first_name: string }> {
    return this.db.prepare("SELECT account, first_name FROM users ORDER BY account").all() as Array<{
      account: string;
      first_name: string;
    }>;
  }

  listChats(account: string): Record<string, unknown>[] {
    const user = this.userByAccount(account);
    const chats = this.db
      .prepare(
        "SELECT c.id, c.type, c.title, c.description, c.photo_file_id, c.permissions_json, c.permissions_until, c.slow_mode_seconds, c.creator_id FROM chats c JOIN chat_members m ON m.chat_id = c.id WHERE m.user_id = ? ORDER BY c.id",
      )
      .all(user.id) as ChatRow[];
    return chats.map((chat) => this.presentChat(chat));
  }

  getHistory(account: string, chatId: number): Record<string, unknown>[] {
    this.requireMember({ kind: "user", account }, chatId);
    return this.visibleMessages(account, chatId).map((row) => this.present(row));
  }

  editMessageText(
    actor: Actor,
    args: { chat_id: number; message_id: number; text: string },
    delta: DeltaHook = NOOP,
  ): Record<string, unknown> {
    if (!args.text) telegramFail(400, 400, "Bad Request: message text is empty");
    const row = this.requireVisibleMessage(actor, args.chat_id, args.message_id);
    const person = this.personFor(actor);
    if (row.from_id !== person.id) telegramFail(400, 400, "Bad Request: message can't be edited");
    if (row.text === args.text) return this.present(row);
    const editDate = this.now();
    this.db
      .prepare("UPDATE messages SET text = ?, edit_date = ? WHERE chat_id = ? AND message_id = ?")
      .run(args.text, editDate, args.chat_id, args.message_id);
    const after = { ...row, text: args.text, edit_date: editDate };
    delta({ before: { text: row.text }, after: { text: args.text, message_id: args.message_id } });
    return this.present(after);
  }

  editMessageReplyMarkup(
    actor: Actor,
    args: { chat_id: number; message_id: number; reply_markup?: unknown },
    delta: DeltaHook = NOOP,
  ): Record<string, unknown> {
    const row = this.requireVisibleMessage(actor, args.chat_id, args.message_id);
    const person = this.personFor(actor);
    if (row.from_id !== person.id) telegramFail(400, 400, "Bad Request: message can't be edited");
    const markup = args.reply_markup === undefined || args.reply_markup === null ? null : this.parseReplyMarkup(args.reply_markup);
    this.db
      .prepare("UPDATE messages SET reply_markup_json = ? WHERE chat_id = ? AND message_id = ?")
      .run(markup ? JSON.stringify(markup) : null, args.chat_id, args.message_id);
    delta({ before: { reply_markup: row.reply_markup_json ?? null }, after: { reply_markup: markup } });
    return this.present({ ...row, reply_markup_json: markup ? JSON.stringify(markup) : null });
  }

  pinChatMessage(actor: Actor, args: { chat_id: number; message_id: number }, delta: DeltaHook = NOOP): { ok: true } {
    const row = this.requireVisibleMessage(actor, args.chat_id, args.message_id);
    this.requirePinAuthority(actor, row);
    this.db
      .prepare("INSERT OR REPLACE INTO pinned_messages (chat_id, message_id, pinned_by_id, pinned_at) VALUES (?, ?, ?, ?)")
      .run(args.chat_id, args.message_id, this.personFor(actor).id, this.now());
    delta({ before: null, after: { chat_id: args.chat_id, message_id: args.message_id, pinned: true } });
    return { ok: true };
  }

  unpinChatMessage(actor: Actor, args: { chat_id: number; message_id?: number }, delta: DeltaHook = NOOP): { ok: true } {
    this.requireMember(actor, args.chat_id);
    if (args.message_id === undefined) {
      const latest = this.db.prepare("SELECT message_id FROM pinned_messages WHERE chat_id = ? ORDER BY pinned_at DESC, message_id DESC LIMIT 1").get(args.chat_id) as { message_id: number } | undefined;
      if (!latest) telegramFail(400, 400, "Bad Request: message is not pinned");
      args = { ...args, message_id: latest.message_id };
    }
    const messageId = args.message_id!;
    const row = this.requireVisibleMessage(actor, args.chat_id, messageId);
    this.requirePinAuthority(actor, row);
    const changed = this.db.prepare("DELETE FROM pinned_messages WHERE chat_id = ? AND message_id = ?").run(args.chat_id, messageId);
    if (!changed.changes) telegramFail(400, 400, "Bad Request: message is not pinned");
    delta({ before: { chat_id: args.chat_id, message_id: messageId, pinned: true }, after: null });
    return { ok: true };
  }

  unpinAllChatMessages(actor: Actor, args: { chat_id: number }, delta: DeltaHook = NOOP): { ok: true } {
    this.requireMember(actor, args.chat_id);
    this.requireChatPinAuthority(actor, args.chat_id);
    this.db.prepare("DELETE FROM pinned_messages WHERE chat_id = ?").run(args.chat_id);
    delta({ before: { chat_id: args.chat_id, pins: true }, after: null });
    return { ok: true };
  }

  getPinnedMessages(account: string, args: { chat_id: number }): Record<string, unknown>[] {
    this.requireMember({ kind: "user", account }, args.chat_id);
    return (this.db.prepare("SELECT m.* FROM pinned_messages p JOIN messages m ON m.chat_id = p.chat_id AND m.message_id = p.message_id WHERE p.chat_id = ? ORDER BY p.pinned_at, p.message_id").all(args.chat_id) as MessageRow[])
      .map((row) => this.present(row));
  }

  setMessageReaction(actor: Actor, args: { chat_id: number; message_id: number; reaction?: unknown }, delta: DeltaHook = NOOP): { ok: true } {
    const row = this.requireVisibleMessage(actor, args.chat_id, args.message_id);
    const emoji = this.parseReaction(args.reaction);
    const person = this.personFor(actor);
    const oldReaction = (this.db
      .prepare("SELECT emoji FROM message_reactions WHERE chat_id = ? AND message_id = ? AND actor_id = ? ORDER BY emoji")
      .all(args.chat_id, args.message_id, person.id) as Array<{ emoji: string }>)
      .map((reaction) => ({ type: "emoji", emoji: reaction.emoji }));
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM message_reactions WHERE chat_id = ? AND message_id = ? AND actor_id = ?").run(args.chat_id, args.message_id, person.id);
      if (emoji) this.db.prepare("INSERT INTO message_reactions (chat_id, message_id, actor_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)").run(args.chat_id, args.message_id, person.id, emoji, this.now());
      if (row.from_id !== person.id && this.isBotId(row.from_id)) this.enqueueTargetedUpdate(row.from_id, "message_reaction", {
        chat: serializeChat(this.chat(args.chat_id)), message_id: args.message_id, user: serializeUser(this.asUser(person)), old_reaction: oldReaction, new_reaction: emoji ? [{ type: "emoji", emoji }] : [],
      }, this.now());
    })();
    if (row.from_id !== person.id && this.isBotId(row.from_id)) this.runtime.notify(row.from_id);
    delta({ before: null, after: { chat_id: args.chat_id, message_id: args.message_id, reaction: emoji } });
    return { ok: true };
  }

  getMessageReactions(account: string, args: { chat_id: number; message_id: number }): Record<string, unknown>[] {
    this.requireVisibleMessage({ kind: "user", account }, args.chat_id, args.message_id);
    return (this.db.prepare("SELECT actor_id, emoji FROM message_reactions WHERE chat_id = ? AND message_id = ? ORDER BY actor_id, emoji").all(args.chat_id, args.message_id) as Array<{ actor_id: number; emoji: string }>)
      .map((reaction) => ({ user: serializeUser(this.personById(reaction.actor_id)), reaction: { type: "emoji", emoji: reaction.emoji } }));
  }

  sendPoll(actor: Actor, args: { chat_id: number; question: string; options: string[]; is_anonymous?: boolean; allows_multiple_answers?: boolean }, delta: DeltaHook = NOOP): Record<string, unknown> {
    const botId = this.botId(actor);
    this.requireMember(actor, args.chat_id);
    this.assertCanSend(actor, args.chat_id, "polls");
    validatePoll(args.question, args.options);
    const now = this.now();
    const messageDeltas: StateDelta[] = [];
    const message = this.sendMessage(actor, { chat_id: args.chat_id, text: args.question }, (change) => messageDeltas.push(change));
    const messageId = message.message_id as number;
    const pollId = `poll:${args.chat_id}:${messageId}`;
    this.db.prepare("INSERT INTO polls (poll_id, chat_id, message_id, question, options_json, is_anonymous, allows_multiple_answers, created_by_bot_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(pollId, args.chat_id, messageId, args.question, JSON.stringify(args.options), args.is_anonymous === false ? 0 : 1, args.allows_multiple_answers ? 1 : 0, botId, now);
    delta(aggregateDeltas([
      ...messageDeltas,
      { before: null, after: { poll_id: pollId, chat_id: args.chat_id, message_id: messageId } },
    ]));
    return this.present(this.requireVisibleMessage(actor, args.chat_id, messageId));
  }

  createPollForUser(account: string, args: { chat_id: number; question: string; options: string[]; is_anonymous?: boolean; allows_multiple_answers?: boolean }, delta: DeltaHook = NOOP): Record<string, unknown> {
    const actor: Actor = { kind: "user", account };
    this.requireMember(actor, args.chat_id);
    this.assertCanSend(actor, args.chat_id, "polls");
    validatePoll(args.question, args.options);
    const messageDeltas: StateDelta[] = [];
    const message = this.sendMessage(actor, { chat_id: args.chat_id, text: args.question }, (change) => messageDeltas.push(change));
    const messageId = message.message_id as number;
    const pollId = `poll:${args.chat_id}:${messageId}`;
    this.db.prepare("INSERT INTO polls (poll_id, chat_id, message_id, question, options_json, is_anonymous, allows_multiple_answers, created_by_bot_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(pollId, args.chat_id, messageId, args.question, JSON.stringify(args.options), args.is_anonymous === false ? 0 : 1, args.allows_multiple_answers ? 1 : 0, this.personFor(actor).id, this.now());
    delta(aggregateDeltas([
      ...messageDeltas,
      { before: null, after: { poll_id: pollId, chat_id: args.chat_id, message_id: messageId } },
    ]));
    return this.present(this.requireVisibleMessage(actor, args.chat_id, messageId));
  }

  votePoll(account: string, args: { chat_id: number; message_id: number; option_ids: number[] }, delta: DeltaHook = NOOP): Record<string, unknown> {
    const voter = this.personFor({ kind: "user", account });
    const poll = this.pollForMessage({ kind: "user", account }, args.chat_id, args.message_id);
    const options = JSON.parse(poll.options_json) as string[];
    if (poll.is_closed) telegramFail(400, 400, "Bad Request: poll is closed");
    if (args.option_ids.length === 0 || new Set(args.option_ids).size !== args.option_ids.length || args.option_ids.some((id) => !Number.isInteger(id) || id < 0 || id >= options.length) || (!poll.allows_multiple_answers && args.option_ids.length > 1)) telegramFail(400, 400, "Bad Request: invalid poll option ids");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM poll_votes WHERE poll_id = ? AND voter_id = ?").run(poll.poll_id, voter.id);
      for (const optionId of args.option_ids) this.db.prepare("INSERT INTO poll_votes (poll_id, voter_id, option_id) VALUES (?, ?, ?)").run(poll.poll_id, voter.id, optionId);
      if (this.isBotId(poll.created_by_bot_id)) this.enqueueTargetedUpdate(poll.created_by_bot_id, "poll_answer", { poll_id: poll.poll_id, user: serializeUser(this.asUser(voter)), option_ids: args.option_ids }, this.now());
    })();
    if (this.isBotId(poll.created_by_bot_id)) this.runtime.notify(poll.created_by_bot_id);
    delta({ before: null, after: { poll_id: poll.poll_id, option_ids: args.option_ids } });
    return this.presentPoll(poll.poll_id);
  }

  closePollForUser(account: string, args: { chat_id: number; message_id: number }, delta: DeltaHook = NOOP): Record<string, unknown> {
    const actor: Actor = { kind: "user", account };
    const poll = this.pollForMessage(actor, args.chat_id, args.message_id);
    if (poll.created_by_bot_id !== this.personFor(actor).id) telegramFail(400, 400, "Bad Request: poll can't be stopped");
    this.db.prepare("UPDATE polls SET is_closed = 1 WHERE poll_id = ?").run(poll.poll_id);
    delta({ before: { poll_id: poll.poll_id, is_closed: false }, after: { poll_id: poll.poll_id, is_closed: true } });
    return this.presentPoll(poll.poll_id);
  }

  stopPoll(actor: Actor, args: { chat_id: number; message_id: number }, delta: DeltaHook = NOOP): Record<string, unknown> {
    const poll = this.pollForMessage(actor, args.chat_id, args.message_id);
    if (poll.created_by_bot_id !== this.botId(actor)) telegramFail(400, 400, "Bad Request: poll can't be stopped");
    this.db.prepare("UPDATE polls SET is_closed = 1 WHERE poll_id = ?").run(poll.poll_id);
    delta({ before: { poll_id: poll.poll_id, is_closed: false }, after: { poll_id: poll.poll_id, is_closed: true } });
    return this.presentPoll(poll.poll_id);
  }

  listInlineButtons(account: string, args: { chat_id: number; message_id: number }): Array<{ text: string; callback_data: string }> {
    const row = this.requireVisibleMessage({ kind: "user", account }, args.chat_id, args.message_id);
    if (!row.reply_markup_json) return [];
    const markup = JSON.parse(row.reply_markup_json) as ReplyMarkup;
    return "inline_keyboard" in markup ? markup.inline_keyboard.flat() : [];
  }

  /** Reply keyboard taps are plain user messages; they never create callbacks. */
  pressReplyKeyboard(account: string, args: { chat_id: number; message_id: number; text: string }, delta: DeltaHook = NOOP): Record<string, unknown> {
    const row = this.requireVisibleMessage({ kind: "user", account }, args.chat_id, args.message_id);
    if (!row.reply_markup_json) telegramFail(400, 400, "Bad Request: reply keyboard not found");
    const markup = JSON.parse(row.reply_markup_json) as ReplyMarkup;
    if (!("reply_keyboard" in markup) || !markup.reply_keyboard.flat().some((button) => button.text === args.text)) telegramFail(400, 400, "Bad Request: reply keyboard button not found");
    return this.sendMessage({ kind: "user", account }, { chat_id: args.chat_id, text: args.text }, delta);
  }

  pressInlineButton(account: string, args: { chat_id: number; message_id: number; callback_data: string }, delta: DeltaHook = NOOP): { callback_query_id: string } {
    const from = this.personFor({ kind: "user", account });
    const row = this.requireVisibleMessage({ kind: "user", account }, args.chat_id, args.message_id);
    if (!row.reply_markup_json || !this.isBotId(row.from_id)) telegramFail(400, 400, "Bad Request: inline button not found");
    const buttons = this.listInlineButtons(account, args);
    if (!buttons.some((button) => button.callback_data === args.callback_data)) telegramFail(400, 400, "Bad Request: inline button not found");
    const callbackId = this.db.transaction(() => {
      const ordinal = (this.db.prepare("SELECT COUNT(*) AS count FROM callback_queries WHERE chat_id = ? AND message_id = ? AND from_id = ?").get(args.chat_id, args.message_id, from.id) as { count: number }).count + 1;
      const id = `cb:${args.chat_id}:${args.message_id}:${from.id}:${this.now()}:${ordinal}`;
      this.db.prepare("INSERT INTO callback_queries (callback_id, bot_id, chat_id, message_id, from_id, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, row.from_id, args.chat_id, args.message_id, from.id, args.callback_data, this.now(), this.now() + CALLBACK_QUERY_TTL_SEC);
      this.enqueueTargetedUpdate(row.from_id, "callback_query", { id, from: serializeUser(this.asUser(from)), message: this.present(row), chat_instance: `chat:${args.chat_id}`, data: args.callback_data }, this.now());
      return id;
    })();
    this.runtime.notify(row.from_id);
    delta({ before: null, after: { callback_query_id: callbackId } });
    return { callback_query_id: callbackId };
  }

  async waitForCallbackAnswer(callbackId: string, timeoutSeconds: number, signal?: AbortSignal): Promise<{ callback_query_id: string; answered: boolean }> {
    const read = () => this.db.prepare("SELECT expires_at, answered_at FROM callback_queries WHERE callback_id = ?").get(callbackId) as { expires_at: number; answered_at: number | null } | undefined;
    const current = read();
    if (!current || current.expires_at <= this.now()) telegramFail(400, 400, "Bad Request: query is too old or invalid");
    if (current.answered_at !== null) return { callback_query_id: callbackId, answered: true };
    const bounded = Math.min(Math.max(timeoutSeconds, 0), CALLBACK_QUERY_TTL_SEC);
    if (bounded === 0 || signal?.aborted) return { callback_query_id: callbackId, answered: false };
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.callbackWaiters.get(callbackId)?.delete(finish);
        const row = read();
        resolve({ callback_query_id: callbackId, answered: Boolean(row && row.answered_at !== null) });
      };
      const timer = setTimeout(finish, bounded * 1000);
      const waiters = this.callbackWaiters.get(callbackId) ?? new Set<() => void>();
      waiters.add(finish);
      this.callbackWaiters.set(callbackId, waiters);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  answerCallbackQuery(actor: Actor, args: { callback_query_id: string; text?: string; show_alert?: boolean; url?: string; cache_time?: number }, delta: DeltaHook = NOOP): { ok: true } {
    const botId = this.botId(actor);
    const query = this.db.prepare("SELECT * FROM callback_queries WHERE callback_id = ?").get(args.callback_query_id) as { bot_id: number; expires_at: number; answered_at: number | null } | undefined;
    if (!query || query.bot_id !== botId) telegramFail(400, 400, "Bad Request: query is too old or invalid");
    if (query.expires_at <= this.now() || query.answered_at !== null) telegramFail(400, 400, "Bad Request: query is too old or invalid");
    const changed = this.db.prepare("UPDATE callback_queries SET answered_at = ?, answer_json = ? WHERE callback_id = ? AND answered_at IS NULL AND expires_at > ?").run(this.now(), JSON.stringify(args), args.callback_query_id, this.now());
    if (changed.changes !== 1) telegramFail(400, 400, "Bad Request: query is too old or invalid");
    delta({ before: { callback_query_id: args.callback_query_id, answered: false }, after: { callback_query_id: args.callback_query_id, answered: true } });
    for (const wake of this.callbackWaiters.get(args.callback_query_id) ?? []) wake();
    return { ok: true };
  }

  deleteMessage(
    actor: Actor,
    args: { chat_id: number; message_id: number; revoke?: boolean },
    delta: DeltaHook = NOOP,
  ): { ok: true } {
    const row = this.requireVisibleMessage(actor, args.chat_id, args.message_id);
    const person = this.personFor(actor);
    if (actor.kind === "bot") {
      if (this.now() - row.date >= BOT_DELETE_WINDOW_SEC) {
        telegramFail(400, 400, "Bad Request: message can't be deleted");
      }
      this.hardDelete(args.chat_id, args.message_id);
      delta({ before: { chat_id: args.chat_id, message_id: args.message_id }, after: null });
      return { ok: true };
    }
    if (row.from_id === person.id || args.revoke) {
      if (row.from_id !== person.id) telegramFail(400, 400, "Bad Request: message can't be deleted");
      this.hardDelete(args.chat_id, args.message_id);
      delta({ before: { chat_id: args.chat_id, message_id: args.message_id }, after: null });
      return { ok: true };
    }
    this.db
      .prepare("INSERT OR IGNORE INTO message_hides (account, chat_id, message_id) VALUES (?, ?, ?)")
      .run(actor.account, args.chat_id, args.message_id);
    delta({
      before: { visible: true, chat_id: args.chat_id, message_id: args.message_id },
      after: { visible: false, account: actor.account },
    });
    return { ok: true };
  }

  deleteMessages(
    actor: Actor,
    args: { chat_id: number; message_ids: number[] },
    delta: DeltaHook = NOOP,
  ): { ok: true } {
    if (args.message_ids.length === 0) telegramFail(400, 400, "Bad Request: message_ids is empty");
    const changes: StateDelta[] = [];
    this.db.transaction(() => {
      for (const message_id of args.message_ids) {
        this.deleteMessage(actor, { chat_id: args.chat_id, message_id }, (change) => changes.push(change));
      }
    })();
    delta(aggregateDeltas(changes));
    return { ok: true };
  }

  forwardMessage(
    actor: Actor,
    args: { chat_id: number; from_chat_id: number; message_id: number },
    delta: DeltaHook = NOOP,
  ): Record<string, unknown> {
    const source = this.requireVisibleMessage(actor, args.from_chat_id, args.message_id);
    this.requireMember(actor, args.chat_id);
    return this.sendMessage(
      actor,
      {
        chat_id: args.chat_id,
        text: source.text,
        forward_from_id: source.from_id,
        forward_from_chat_id: source.chat_id,
      },
      delta,
    );
  }

  copyMessage(
    actor: Actor,
    args: { chat_id: number; from_chat_id: number; message_id: number },
    delta: DeltaHook = NOOP,
  ): Record<string, unknown> {
    const source = this.requireVisibleMessage(actor, args.from_chat_id, args.message_id);
    this.requireMember(actor, args.chat_id);
    return this.sendMessage(actor, { chat_id: args.chat_id, text: source.text }, delta);
  }

  getMessages(
    account: string,
    args: { chat_id: number; message_id: number; limit?: number },
  ): Record<string, unknown>[] {
    this.requireVisibleMessage({ kind: "user", account }, args.chat_id, args.message_id);
    const limit = args.limit ?? 10;
    if (limit < 0) telegramFail(400, 400, "Bad Request: limit must be non-negative");
    const rows = this.visibleMessages(account, args.chat_id).filter(
      (row) => Math.abs(row.message_id - args.message_id) <= limit,
    );
    return rows.map((row) => this.present(row));
  }

  searchMessages(account: string, args: { chat_id?: number; query: string }): Record<string, unknown>[] {
    const chats =
      args.chat_id !== undefined
        ? (this.requireMember({ kind: "user", account }, args.chat_id), [args.chat_id])
        : this.memberChatIds(account);
    if (!args.query) return [];
    const needle = args.query.toLowerCase();
    const hits: MessageRow[] = [];
    for (const chatId of chats) {
      for (const row of this.visibleMessages(account, chatId)) {
        if (row.text.toLowerCase().includes(needle)) hits.push(row);
      }
    }
    return hits.map((row) => this.present(row));
  }

  getMessageLink(account: string, args: { chat_id: number; message_id: number }): { link: string } {
    this.requireVisibleMessage({ kind: "user", account }, args.chat_id, args.message_id);
    return { link: `tg://message?chat_id=${args.chat_id}&message_id=${args.message_id}` };
  }

  messageFromLink(account: string, link: string): Record<string, unknown> {
    const match = link.match(/^tg:\/\/message\?chat_id=(-?\d+)&message_id=(\d+)$/);
    if (!match) telegramFail(400, 400, "Bad Request: unsupported link");
    return this.present(this.requireVisibleMessage({ kind: "user", account }, Number(match[1]), Number(match[2])));
  }

  markAsRead(
    account: string,
    args: { chat_id: number; message_id: number },
    delta: DeltaHook = NOOP,
  ): { ok: true } {
    this.requireVisibleMessage({ kind: "user", account }, args.chat_id, args.message_id);
    this.db
      .prepare(
        "INSERT INTO read_cursors (account, chat_id, last_read) VALUES (?, ?, ?) ON CONFLICT(account, chat_id) DO UPDATE SET last_read = MAX(read_cursors.last_read, excluded.last_read)",
      )
      .run(account, args.chat_id, args.message_id);
    delta({ before: null, after: { account, chat_id: args.chat_id, last_read: args.message_id } });
    return { ok: true };
  }

  getMessageViewers(account: string, args: { chat_id: number; message_id: number }): Array<{ account: string }> {
    const chat = this.chat(args.chat_id);
    this.requireVisibleMessage({ kind: "user", account }, args.chat_id, args.message_id);
    if (chat.type === "private") return [{ account }];
    return (
      this.db
        .prepare("SELECT account FROM read_cursors WHERE chat_id = ? AND last_read >= ? ORDER BY account")
        .all(args.chat_id, args.message_id) as Array<{ account: string }>
    ).filter((row) => this.isMemberId(this.userByAccount(row.account).id, args.chat_id));
  }

  getUpdates(
    actor: Actor,
    args: { offset?: number; limit?: number; allowed_updates?: string[] },
  ): Record<string, unknown>[] {
    const botId = this.botId(actor);
    this.purgeExpiredUpdates();
    let settings = this.settings(botId);
    if (args.allowed_updates && args.allowed_updates.length > 0) {
      this.db
        .prepare("UPDATE bot_update_settings SET allowed_updates_json = ? WHERE bot_id = ?")
        .run(JSON.stringify(args.allowed_updates), botId);
      settings = this.settings(botId);
    }
    if (settings.webhook_url) telegramFail(409, 409, "Conflict: can't use getUpdates method while webhook is active");
    const limit = args.limit ?? 100;
    if (limit < 1 || limit > 100) telegramFail(400, 400, "Bad Request: limit must be between 1 and 100");
    const offset = args.offset;
    if (offset !== undefined && offset > 0) {
      this.db.prepare("DELETE FROM bot_updates WHERE bot_id = ? AND update_id < ?").run(botId, offset);
    }
    if (offset !== undefined && offset < 0) {
      const rows = this.db
        .prepare("SELECT update_id, payload_json FROM bot_updates WHERE bot_id = ? ORDER BY update_id DESC LIMIT ?")
        .all(botId, Math.min(-offset, limit)) as Array<{ update_id: number; payload_json: string }>;
      if (rows.length === 0) return [];
      const first = rows[rows.length - 1]!.update_id;
      this.db.prepare("DELETE FROM bot_updates WHERE bot_id = ? AND update_id < ?").run(botId, first);
      return rows.reverse().map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
    }
    const minimum = offset && offset > 0 ? offset : 0;
    return (
      this.db
        .prepare("SELECT payload_json FROM bot_updates WHERE bot_id = ? AND update_id >= ? ORDER BY update_id LIMIT ?")
        .all(botId, minimum, limit) as Array<{ payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
  }

  async waitForUpdates(
    actor: Actor,
    args: { offset?: number; limit?: number; timeout?: number; allowed_updates?: string[] },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    const botId = this.botId(actor);
    let release: (() => void) | undefined;
    try {
      try {
        release = this.runtime.acquirePoll(botId);
      } catch {
        telegramFail(409, 409, "Conflict: another getUpdates request is active for this bot");
      }
      const immediate = this.getUpdates(actor, args);
      if (immediate.length > 0 || !args.timeout) return immediate;
      await this.runtime.waitForUpdate(botId, args.timeout, signal);
      return this.getUpdates(actor, args);
    } finally {
      release?.();
    }
  }

  setWebhook(
    actor: Actor,
    args: {
      url: string;
      allowed_updates?: string[];
      secret_token?: string;
      max_connections?: number;
      drop_pending_updates?: boolean;
    },
    delta: DeltaHook = NOOP,
  ): { ok: true } {
    const botId = this.botId(actor);
    const urlError = webhookUrlError(args.url, this.localWebhookUrls);
    if (urlError) telegramFail(400, 400, urlError);
    if (args.secret_token !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(args.secret_token)) {
      telegramFail(400, 400, "Bad Request: secret_token is invalid");
    }
    const maxConnections = args.max_connections ?? 40;
    if (maxConnections < 1 || maxConnections > 100) {
      telegramFail(400, 400, "Bad Request: max_connections must be between 1 and 100");
    }
    this.db.transaction(() => {
      const previous = this.settings(botId);
      const allowed = args.allowed_updates && args.allowed_updates.length > 0 ? JSON.stringify(args.allowed_updates) : previous.allowed_updates_json;
      this.db
        .prepare(
          "UPDATE bot_update_settings SET allowed_updates_json = ?, webhook_url = ?, webhook_secret_token = ?, webhook_max_connections = ?, last_error_date = NULL, last_error_message = NULL WHERE bot_id = ?",
        )
        .run(allowed, args.url, args.secret_token ?? null, maxConnections, botId);
      if (args.drop_pending_updates) {
        this.db.prepare("DELETE FROM bot_updates WHERE bot_id = ?").run(botId);
      } else {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO webhook_outbox (bot_id, update_id, attempts, next_attempt_at) SELECT bot_id, update_id, 0, ? FROM bot_updates WHERE bot_id = ?",
          )
          .run(this.now(), botId);
      }
    })();
    this.runtime.notify(botId);
    delta({ before: null, after: { bot_id: botId, webhook_url: args.url } });
    return { ok: true };
  }

  deleteWebhook(actor: Actor, args: { drop_pending_updates?: boolean }, delta: DeltaHook = NOOP): { ok: true } {
    const botId = this.botId(actor);
    // A preserved update can reuse the same id after a reset. Invalidate an
    // in-flight receiver before removing its outbox claim either way.
    this.runtime.cancelAll();
    this.db.transaction(() => {
      this.settings(botId);
      this.db
        .prepare("UPDATE bot_update_settings SET webhook_url = NULL, webhook_secret_token = NULL, last_error_date = NULL, last_error_message = NULL WHERE bot_id = ?")
        .run(botId);
      this.db.prepare("DELETE FROM webhook_outbox WHERE bot_id = ?").run(botId);
      if (args.drop_pending_updates) this.db.prepare("DELETE FROM bot_updates WHERE bot_id = ?").run(botId);
    })();
    this.runtime.notify(botId);
    delta({ before: { bot_id: botId, webhook_url: true }, after: null });
    return { ok: true };
  }

  getWebhookInfo(actor: Actor): Record<string, unknown> {
    const botId = this.botId(actor);
    this.purgeExpiredUpdates();
    const settings = this.settings(botId);
    const pending = (
      this.db.prepare("SELECT COUNT(*) AS count FROM webhook_outbox WHERE bot_id = ?").get(botId) as { count: number }
    ).count;
    return {
      url: settings.webhook_url ?? "",
      has_custom_certificate: false,
      pending_update_count: pending,
      ...(settings.webhook_url ? { max_connections: settings.webhook_max_connections } : {}),
      ...(settings.last_error_date ? { last_error_date: settings.last_error_date } : {}),
      ...(settings.last_error_message ? { last_error_message: settings.last_error_message } : {}),
    };
  }

  /** Drains at most one durable batch. It never performs a network request. */
  async flushWebhookOutbox(
    delivery: TelegramWebhookDelivery | undefined = this.runtime.getDelivery(),
  ): Promise<WebhookDrainResult> {
    this.purgeExpiredUpdates();
    const generation = this.runtime.currentGeneration();
    const now = this.now();
    const due = this.db
      .prepare(
        "SELECT bot_id, update_id FROM webhook_outbox WHERE next_attempt_at <= ? AND locked_until <= ? ORDER BY next_attempt_at, update_id LIMIT ?",
      )
      .all(now, now, MAX_WEBHOOK_BATCH) as Array<{ bot_id: number; update_id: number }>;
    for (const item of due) {
      const claimed = this.db
        .prepare("UPDATE webhook_outbox SET locked_until = ? WHERE bot_id = ? AND update_id = ? AND locked_until <= ?")
        .run(now + 30, item.bot_id, item.update_id, now);
      if (claimed.changes !== 1) continue;
      const setting = this.settings(item.bot_id);
      const update = this.db
        .prepare("SELECT payload_json FROM bot_updates WHERE bot_id = ? AND update_id = ?")
        .get(item.bot_id, item.update_id) as { payload_json: string } | undefined;
      if (!setting.webhook_url || !update) {
        this.db.prepare("DELETE FROM webhook_outbox WHERE bot_id = ? AND update_id = ?").run(item.bot_id, item.update_id);
        continue;
      }
      let status: number | undefined;
      let failure: string | undefined;
      try {
        if (!delivery) failure = "delivery_disabled";
        else status = (await delivery({
          url: setting.webhook_url,
          body: JSON.parse(update.payload_json) as Record<string, unknown>,
          headers: {
            "content-type": "application/json",
            ...(setting.webhook_secret_token
              ? { "x-telegram-bot-api-secret-token": setting.webhook_secret_token }
              : {}),
          },
        })).status;
        if (status !== undefined && (status < 200 || status >= 300)) failure = `http_${status}`;
      } catch {
        failure = "delivery_failed";
      }
      // Reset can occur while an injected receiver is pending. Its completion
      // must not acknowledge a new row that reused this bot/update id.
      if (!this.runtime.isCurrentGeneration(generation)) return { processed: 0 };
      if (!failure) {
        this.db.transaction(() => {
          this.db.prepare("DELETE FROM webhook_outbox WHERE bot_id = ? AND update_id = ?").run(item.bot_id, item.update_id);
          this.db.prepare("DELETE FROM bot_updates WHERE bot_id = ? AND update_id = ?").run(item.bot_id, item.update_id);
        })();
        continue;
      }
      this.db.transaction(() => {
        const current = this.db
          .prepare("SELECT attempts FROM webhook_outbox WHERE bot_id = ? AND update_id = ?")
          .get(item.bot_id, item.update_id) as { attempts: number } | undefined;
        if (!current) return;
        const attempts = current.attempts + 1;
        const delay = Math.min(60, 2 ** Math.min(attempts - 1, 5));
        this.db
          .prepare("UPDATE webhook_outbox SET attempts = ?, next_attempt_at = ?, locked_until = 0, last_error = ? WHERE bot_id = ? AND update_id = ?")
          .run(attempts, now + delay, failure, item.bot_id, item.update_id);
        this.db
          .prepare("UPDATE bot_update_settings SET last_error_date = ?, last_error_message = ? WHERE bot_id = ?")
          .run(now, failure, item.bot_id);
      })();
    }
    const next = this.db
      .prepare(
        "SELECT MIN(CASE WHEN next_attempt_at > locked_until THEN next_attempt_at ELSE locked_until END) AS next_attempt_at FROM webhook_outbox",
      )
      .get() as { next_attempt_at: number | null };
    return {
      processed: due.length,
      ...(next.next_attempt_at === null ? {} : { nextAttemptAt: next.next_attempt_at }),
    };
  }

  manifest(): Record<string, unknown> {
    return {
      name: "telegram",
      tools: [
        "get_me",
        "list_accounts",
        "_manifest",
        "list_chats",
        "get_chat",
        "get_history",
        "send_message",
        "reply_to_message",
        "get_messages",
        "search_messages",
        "search_global",
        "edit_message",
        "delete_message",
        "forward_message",
        "get_message_context",
        "message_from_link",
        "get_message_link",
        "mark_as_read",
        "get_message_viewers",
        "pin_message",
        "unpin_message",
        "get_pinned_messages",
        "send_reaction",
        "remove_reaction",
        "get_message_reactions",
        "create_poll",
        "vote_poll",
        "close_poll",
        "list_inline_buttons",
        "press_inline_button",
        "get_media_info",
        "download_media",
        "send_file",
        "send_voice",
        "send_sticker",
        "get_sticker_sets",
      ],
    };
  }

  exportState(): Record<string, unknown> {
    return {
      bots: this.db.prepare("SELECT id, first_name, username FROM bots").all(),
      users: this.db.prepare("SELECT id, account, first_name, username FROM users").all(),
      chats: this.db.prepare("SELECT id, type, title FROM chats").all(),
      messages: this.db.prepare("SELECT chat_id, message_id, from_id, text, reply_to_message_id FROM messages").all(),
    };
  }

  private validateCaption(caption: string | undefined): string {
    const value = caption ?? "";
    // String.length is UTF-16 code units, the Bot API's caption unit.
    if (value.length > MAX_CAPTION_UTF16) telegramFail(400, 400, `Bad Request: caption is too long (max ${MAX_CAPTION_UTF16} UTF-16 characters)`);
    return value;
  }

  private resolveMedia(botId: number, scopeId: string, source: MediaReference): MediaUpload | MediaFileRow {
    if (typeof source !== "string") {
      if (source.bytes.length === 0 || source.bytes.length > MAX_MEDIA_UPLOAD_BYTES) telegramFail(400, 400, `Bad Request: upload must be 1-${MAX_MEDIA_UPLOAD_BYTES} bytes`);
      if (source.filename && (source.filename.includes("/") || source.filename.includes("\\") || source.filename === "." || source.filename === "..")) telegramFail(400, 400, "Bad Request: unsafe file name");
      return source;
    }
    if (/^(?:https?:|file:|attach:\/\/)/i.test(source) || source.includes("/") || source.includes("\\") || source.includes("..")) telegramFail(400, 400, "Bad Request: URLs and host file paths are not supported");
    if (source.startsWith("unique_")) telegramFail(400, 400, "Bad Request: file_unique_id cannot be used as a file reference");
    this.purgeExpiredMedia();
    const row = this.db.prepare("SELECT * FROM media_files WHERE file_id = ? AND bot_id = ? AND scope_id = ?").get(source, botId, scopeId) as MediaFileRow | undefined;
    if (!row) telegramFail(400, 400, "Bad Request: file not found");
    return row;
  }

  private persistMedia(botId: number, scopeId: string, value: MediaUpload | MediaFileRow): MediaFileRow {
    if ("file_id" in value) return value;
    const sha256 = createHash("sha256").update(value.bytes).digest("hex");
    const scopeHash = createHash("sha256").update(scopeId).digest("hex").slice(0, 8);
    const fileId = `file_${botId}_${scopeHash}_${sha256.slice(0, 32)}`;
    const now = this.now();
    const existing = this.db.prepare("SELECT * FROM media_files WHERE file_id = ? AND bot_id = ? AND scope_id = ?").get(fileId, botId, scopeId) as MediaFileRow | undefined;
    if (existing) {
      this.db.prepare("UPDATE media_files SET file_name = ?, mime_type = ?, expires_at = ? WHERE file_id = ?").run(
        value.filename ?? null,
        value.mimeType ?? null,
        now + MEDIA_TTL_SEC,
        fileId,
      );
      return {
        ...existing,
        file_name: value.filename ?? null,
        mime_type: value.mimeType ?? null,
        expires_at: now + MEDIA_TTL_SEC,
      };
    }
    const row: MediaFileRow = { file_id: fileId, bot_id: botId, scope_id: scopeId, file_unique_id: `unique_${sha256.slice(0, 32)}`, file_name: value.filename ?? null, mime_type: value.mimeType ?? null, size: value.bytes.length, sha256, content: value.bytes, expires_at: now + MEDIA_TTL_SEC };
    this.db.prepare("INSERT INTO media_files (file_id, bot_id, scope_id, file_unique_id, file_name, mime_type, size, sha256, content, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.file_id, row.bot_id, row.scope_id, row.file_unique_id, row.file_name, row.mime_type, row.size, row.sha256, row.content, now, row.expires_at);
    return row;
  }

  private loadVisibleMedia(account: string, args: { chat_id: number; message_id: number }): {
    info: Record<string, unknown>;
    file: MediaFileRow;
  } {
    const row = this.requireVisibleMessage({ kind: "user", account }, args.chat_id, args.message_id);
    const parsed = this.mediaFromMessage(row);
    const file = this.db.prepare("SELECT * FROM media_files WHERE file_id = ? AND expires_at > ?").get(parsed.file_id, this.now()) as MediaFileRow | undefined;
    if (!file) telegramFail(400, 400, "Bad Request: file not found");
    return {
      info: {
        chat_id: args.chat_id,
        message_id: args.message_id,
        kind: parsed.kind,
        file_id: file.file_id,
        file_unique_id: file.file_unique_id,
        file_size: file.size,
        ...(file.file_name ? { file_name: file.file_name } : {}),
        ...(file.mime_type ? { mime_type: file.mime_type } : {}),
      },
      file,
    };
  }

  private accessibleMediaFile(actor: Actor, fileId: string): MediaFileRow | undefined {
    const botId = this.botId(actor);
    const scopeId = this.mediaScope(actor);
    const owned = this.db.prepare("SELECT * FROM media_files WHERE file_id = ? AND bot_id = ? AND scope_id = ?").get(fileId, botId, scopeId) as MediaFileRow | undefined;
    if (owned) return owned;
    const row = this.db.prepare("SELECT * FROM media_files WHERE file_id = ?").get(fileId) as MediaFileRow | undefined;
    // After the actor's own scope misses, only a member chat that references the file_id grants access.
    if (!row || !this.botSeesFileInMemberChat(botId, fileId)) return undefined;
    return row;
  }

  private botSeesFileInMemberChat(botId: number, fileId: string): boolean {
    return Boolean(
      this.db.prepare(
        `SELECT 1 AS ok FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id
         WHERE cm.user_id = ? AND ? IN (
           json_extract(m.media_json, '$.document.file_id'),
           json_extract(m.media_json, '$.voice.file_id'),
           json_extract(m.media_json, '$.sticker.file_id'),
           json_extract(m.media_json, '$.video.file_id'),
           json_extract(m.media_json, '$.audio.file_id'),
           json_extract(m.media_json, '$.photo[0].file_id')
         )`,
      ).get(botId, fileId),
    );
  }

  private mediaFromMessage(row: MessageRow): { kind: string; file_id: string } {
    if (!row.media_json) telegramFail(400, 400, "Bad Request: message has no media");
    const media = JSON.parse(row.media_json) as Record<string, unknown>;
    for (const kind of ["photo", "document", "video", "audio", "voice", "sticker"] as const) {
      if (!(kind in media)) continue;
      const value = media[kind];
      const file = kind === "photo" && Array.isArray(value) ? value[0] : value;
      if (!file || typeof file !== "object" || typeof (file as { file_id?: unknown }).file_id !== "string") {
        telegramFail(400, 400, "Bad Request: message has no media");
      }
      return { kind, file_id: (file as { file_id: string }).file_id };
    }
    telegramFail(400, 400, "Bad Request: message has no media");
  }

  private insertMediaMessage(actor: Actor, chatId: number, kind: "photo" | "document" | "video" | "audio" | "voice" | "sticker", file: MediaFileRow, caption: string, mediaGroupId?: string): Record<string, unknown> {
    const from = this.personFor(actor);
    const messageId = (this.db.prepare("SELECT next_message_id AS next FROM chats WHERE id = ?").get(chatId) as { next: number }).next;
    const date = this.now();
    const fileInfo = { file_id: file.file_id, file_unique_id: file.file_unique_id, file_size: file.size, ...(file.file_name ? { file_name: file.file_name } : {}), ...(file.mime_type ? { mime_type: file.mime_type } : {}) };
    const media = { [kind]: kind === "photo" ? [fileInfo] : fileInfo, ...(mediaGroupId ? { media_group_id: mediaGroupId } : {}) };
    this.db.prepare("UPDATE chats SET next_message_id = next_message_id + 1 WHERE id = ?").run(chatId);
    this.db.prepare("INSERT INTO messages (chat_id, message_id, from_id, text, date, reply_to_message_id, edit_date, forward_from_id, forward_from_chat_id, reply_markup_json, media_json) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)").run(chatId, messageId, from.id, caption, date, JSON.stringify(media));
    return this.present({ chat_id: chatId, message_id: messageId, from_id: from.id, text: caption, date, reply_to_message_id: null, media_json: JSON.stringify(media) });
  }

  private purgeExpiredMedia(): void {
    this.db.prepare("DELETE FROM media_files WHERE expires_at <= ?").run(this.now());
  }

  private mediaScope(actor: Actor): string {
    return actor.kind === "bot" ? actor.sid ?? "local" : `user:${actor.account}`;
  }

  private mediaOwner(actor: Actor): { ownerId: number; scopeId: string } {
    if (actor.kind === "bot") {
      this.personFor(actor);
      return { ownerId: actor.botId, scopeId: this.mediaScope(actor) };
    }
    return { ownerId: this.personFor(actor).id, scopeId: this.mediaScope(actor) };
  }

  private botId(actor: Actor): number {
    if (actor.kind !== "bot") telegramFail(401, 401, "Unauthorized");
    this.personFor(actor);
    return actor.botId;
  }

  private settings(botId: number): {
    bot_id: number;
    next_update_id: number;
    allowed_updates_json: string | null;
    webhook_url: string | null;
    webhook_secret_token: string | null;
    webhook_max_connections: number;
    last_error_date: number | null;
    last_error_message: string | null;
  } {
    this.db.prepare("INSERT OR IGNORE INTO bot_update_settings (bot_id) VALUES (?)").run(botId);
    return this.db.prepare("SELECT * FROM bot_update_settings WHERE bot_id = ?").get(botId) as {
      bot_id: number;
      next_update_id: number;
      allowed_updates_json: string | null;
      webhook_url: string | null;
      webhook_secret_token: string | null;
      webhook_max_connections: number;
      last_error_date: number | null;
      last_error_message: string | null;
    };
  }

  private enqueueMessageUpdates(chatId: number, message: Record<string, unknown>, createdAt: number): number[] {
    const bots = this.db
      .prepare("SELECT b.id FROM bots b JOIN chat_members m ON m.user_id = b.id WHERE m.chat_id = ? ORDER BY b.id")
      .all(chatId) as Array<{ id: number }>;
    return bots.filter((bot) => this.enqueueTargetedUpdate(bot.id, "message", message, createdAt)).map((bot) => bot.id);
  }

  /** Updates are queued only for the bot that owns an interactive message. */
  private enqueueTargetedUpdate(botId: number, type: string, payload: Record<string, unknown>, createdAt: number): boolean {
    const settings = this.settings(botId);
    const allowed = settings.allowed_updates_json ? (JSON.parse(settings.allowed_updates_json) as string[]) : undefined;
    if (allowed && !allowed.includes(type)) return false;
    const updateId = settings.next_update_id;
    this.db.prepare("INSERT INTO bot_updates (bot_id, update_id, update_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(botId, updateId, type, JSON.stringify({ update_id: updateId, [type]: payload }), createdAt);
    this.db.prepare("UPDATE bot_update_settings SET next_update_id = next_update_id + 1 WHERE bot_id = ?").run(botId);
    if (settings.webhook_url) this.db.prepare("INSERT INTO webhook_outbox (bot_id, update_id, attempts, next_attempt_at) VALUES (?, ?, 0, ?)").run(botId, updateId, createdAt);
    return true;
  }

  createGroup(account: string, args: { title: string; user_ids: Array<number | string> }, delta: DeltaHook = NOOP): Record<string, unknown> {
    const title = requireChatTitle(args.title);
    const creator = this.personFor({ kind: "user", account });
    const invitees: PersonRow[] = [];
    const seen = new Set<number>([creator.id]);
    for (const ref of args.user_ids) {
      const person = this.resolvePersonRef(ref);
      if (seen.has(person.id)) continue;
      seen.add(person.id);
      invitees.push(person);
    }
    const chatId = this.nextGroupId();
    this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO chats (id, type, title, description, photo_file_id, permissions_json, permissions_until, slow_mode_seconds, creator_id, next_message_id, next_admin_log_id) VALUES (?, 'supergroup', ?, NULL, NULL, ?, 0, 0, ?, 1, 1)",
      ).run(chatId, title, JSON.stringify(DEFAULT_CHAT_PERMISSIONS), creator.id);
      this.insertMember(chatId, creator.id, "creator");
      for (const person of invitees) this.insertMember(chatId, person.id, "member");
      this.recordAdminLog(chatId, creator.id, "create_group", null, { title, user_ids: invitees.map((person) => person.id) });
    })();
    const chat = this.presentChat(this.chat(chatId));
    delta({ before: null, after: { chat_id: chatId, title, members: [creator.id, ...invitees.map((person) => person.id)] } });
    return chat;
  }

  inviteToGroup(account: string, args: { group_id: number; user_ids: Array<number | string> }, delta: DeltaHook = NOOP): Record<string, unknown> {
    const actor = this.requirePermission({ kind: "user", account }, args.group_id, "can_invite_users", "can_invite_users");
    const added: number[] = [];
    this.db.transaction(() => {
      for (const ref of args.user_ids) {
        const person = this.resolvePersonRef(ref);
        this.expireMembership(args.group_id, person.id);
        if (this.banRow(args.group_id, person.id)) telegramFail(400, 400, "Bad Request: user is banned");
        if (this.isMemberId(person.id, args.group_id)) continue;
        this.insertMember(args.group_id, person.id, "member");
        added.push(person.id);
        this.recordAdminLog(args.group_id, actor.person.id, "invite", person.id, {});
      }
    })();
    delta({ before: null, after: { chat_id: args.group_id, added } });
    return { ok: true, added };
  }

  leaveChat(actor: Actor, args: { chat_id: number }, delta: DeltaHook = NOOP): { ok: true } {
    this.requireGroup(args.chat_id);
    const snapshot = this.membershipSnapshot(actor, args.chat_id);
    if (!snapshot.isMember) telegramFail(400, 400, "Bad Request: chat not found");
    if (snapshot.status === "creator" && this.memberCount(args.chat_id) > 1) {
      telegramFail(400, 400, "Bad Request: creator can't leave the chat");
    }
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").run(args.chat_id, snapshot.person.id);
      this.recordAdminLog(args.chat_id, snapshot.person.id, "leave", snapshot.person.id, {});
    })();
    delta({ before: { status: snapshot.status }, after: { status: "left", chat_id: args.chat_id, user_id: snapshot.person.id } });
    return { ok: true };
  }

  getParticipants(account: string, args: { chat_id: number; page?: number; page_size?: number }): Record<string, unknown> {
    this.requireMember({ kind: "user", account }, args.chat_id);
    this.expireChatMemberships(args.chat_id);
    const page = args.page ?? 1;
    const pageSize = args.page_size ?? 200;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      telegramFail(400, 400, "Bad Request: invalid pagination");
    }
    const rows = this.memberRows(args.chat_id);
    const start = (page - 1) * pageSize;
    return {
      page,
      page_size: pageSize,
      total: rows.length,
      participants: rows.slice(start, start + pageSize).map((row) => presentParticipant(this.personById(row.user_id), this.memberStatus(row))),
    };
  }

  setChatTitle(actor: Actor, args: { chat_id: number; title: string }, delta: DeltaHook = NOOP): { ok: true } {
    const title = requireChatTitle(args.title);
    const snapshot = this.requirePermission(actor, args.chat_id, "can_change_info", "can_change_info");
    const before = this.chat(args.chat_id).title ?? null;
    if (before !== title) {
      this.db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(title, args.chat_id);
      this.recordAdminLog(args.chat_id, snapshot.person.id, "edit_title", null, { title });
    }
    delta({ before: { title: before }, after: { title } });
    return { ok: true };
  }

  setChatDescription(actor: Actor, args: { chat_id: number; description?: string }, delta: DeltaHook = NOOP): { ok: true } {
    const description = requireChatAbout(args.description ?? "");
    const snapshot = this.requirePermission(actor, args.chat_id, "can_change_info", "can_change_info");
    const before = this.chat(args.chat_id).description ?? "";
    if (before !== description) {
      this.db.prepare("UPDATE chats SET description = ? WHERE id = ?").run(description, args.chat_id);
      this.recordAdminLog(args.chat_id, snapshot.person.id, "edit_about", null, { about: description });
    }
    delta({ before: { description: before }, after: { description } });
    return { ok: true };
  }

  editChatPhoto(actor: Actor, args: { chat_id: number; media: MediaReference }, delta: DeltaHook = NOOP): { ok: true } {
    const snapshot = this.requirePermission(actor, args.chat_id, "can_change_info", "can_change_info");
    const { ownerId, scopeId } = this.mediaOwner(actor);
    const file = this.persistMedia(ownerId, scopeId, this.resolveMedia(ownerId, scopeId, args.media));
    const before = this.chat(args.chat_id).photo_file_id ?? null;
    this.db.prepare("UPDATE chats SET photo_file_id = ? WHERE id = ?").run(file.file_id, args.chat_id);
    this.recordAdminLog(args.chat_id, snapshot.person.id, "edit_photo", null, { file_id: file.file_id });
    delta({ before: { photo_file_id: before }, after: { photo_file_id: file.file_id } });
    return { ok: true };
  }

  deleteChatPhoto(actor: Actor, args: { chat_id: number }, delta: DeltaHook = NOOP): { ok: true } {
    const snapshot = this.requirePermission(actor, args.chat_id, "can_change_info", "can_change_info");
    const before = this.chat(args.chat_id).photo_file_id ?? null;
    if (before !== null) {
      this.db.prepare("UPDATE chats SET photo_file_id = NULL WHERE id = ?").run(args.chat_id);
      this.recordAdminLog(args.chat_id, snapshot.person.id, "delete_photo", null, {});
    }
    delta({ before: { photo_file_id: before }, after: { photo_file_id: null } });
    return { ok: true };
  }

  promoteChatMember(
    actor: Actor,
    args: { chat_id: number; user_id: number | string; rights?: unknown },
    delta: DeltaHook = NOOP,
  ): { ok: true } {
    const actorSnap = this.requireAdminRight(actor, args.chat_id, "can_promote_members");
    const target = this.targetMember(args.chat_id, args.user_id);
    if (target.status === "creator") telegramFail(400, 400, "Bad Request: can't promote the chat creator");
    if (!target.isMember) telegramFail(400, 400, "Bad Request: user not found");
    const actorRights = actorSnap.status === "creator" ? FULL_ADMIN_RIGHTS : actorSnap.rights ?? DEFAULT_PROMOTE_RIGHTS;
    const rights = parseAdminRights(args.rights, target.rights ?? DEFAULT_PROMOTE_RIGHTS);
    if (!rightsSubset(rights, actorRights)) telegramFail(400, 400, "Bad Request: can't grant rights the actor lacks");
    if (noAdminRights(rights)) return this.demoteChatMember(actor, { chat_id: args.chat_id, user_id: args.user_id }, delta);
    this.db.prepare(
      "UPDATE chat_members SET status = 'administrator', admin_rights_json = ?, restrictions_json = NULL, until_date = 0, is_anonymous = ? WHERE chat_id = ? AND user_id = ?",
    ).run(JSON.stringify(rights), rights.is_anonymous ? 1 : 0, args.chat_id, target.person.id);
    this.recordAdminLog(args.chat_id, actorSnap.person.id, "promote", target.person.id, { rights });
    delta({ before: { status: target.status, rights: target.rights }, after: { status: "administrator", rights } });
    return { ok: true };
  }

  demoteChatMember(actor: Actor, args: { chat_id: number; user_id: number | string }, delta: DeltaHook = NOOP): { ok: true } {
    const actorSnap = this.requireAdminRight(actor, args.chat_id, "can_promote_members");
    const target = this.targetMember(args.chat_id, args.user_id);
    if (target.status === "creator") telegramFail(400, 400, "Bad Request: can't demote the chat creator");
    if (target.status === "administrator") {
      this.db.prepare(
        "UPDATE chat_members SET status = 'member', admin_rights_json = NULL, custom_title = NULL, is_anonymous = 0 WHERE chat_id = ? AND user_id = ?",
      ).run(args.chat_id, target.person.id);
      this.recordAdminLog(args.chat_id, actorSnap.person.id, "demote", target.person.id, {});
    }
    delta({ before: { status: target.status }, after: { status: target.status === "administrator" ? "member" : target.status } });
    return { ok: true };
  }

  editAdminRights(
    actor: Actor,
    args: { chat_id: number; user_id: number | string; rank?: string; rights?: unknown },
    delta: DeltaHook = NOOP,
  ): { ok: true } {
    const rank = requireAdminTitle(args.rank ?? "");
    const rights = args.rights === undefined ? undefined : parseAdminRights(args.rights, ZERO_ADMIN_RIGHTS);
    if (rights !== undefined && noAdminRights(rights)) {
      const result = this.demoteChatMember(actor, { chat_id: args.chat_id, user_id: args.user_id }, delta);
      if (rank) this.db.prepare("UPDATE chat_members SET custom_title = NULL WHERE chat_id = ? AND user_id = ?").run(args.chat_id, this.resolvePersonRef(args.user_id).id);
      return result;
    }
    const result = this.promoteChatMember(actor, { chat_id: args.chat_id, user_id: args.user_id, rights }, delta);
    if (rank) {
      this.db.prepare("UPDATE chat_members SET custom_title = ? WHERE chat_id = ? AND user_id = ?").run(rank, args.chat_id, this.resolvePersonRef(args.user_id).id);
    }
    return result;
  }

  banChatMember(actor: Actor, args: { chat_id: number; user_id: number | string; until_date?: unknown }, delta: DeltaHook = NOOP): { ok: true } {
    const actorSnap = this.requireAdminRight(actor, args.chat_id, "can_restrict_members");
    const target = this.targetMember(args.chat_id, args.user_id);
    const until = parseUntilDate(args.until_date, this.now());
    this.assertModerationTarget(actorSnap, target, "ban");
    const already = this.banRow(args.chat_id, target.person.id);
    if (!already || already.until_date !== until) {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").run(args.chat_id, target.person.id);
        this.db.prepare(
          "INSERT INTO chat_bans (chat_id, user_id, banned_by_id, until_date, banned_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET banned_by_id = excluded.banned_by_id, until_date = excluded.until_date, banned_at = excluded.banned_at",
        ).run(args.chat_id, target.person.id, actorSnap.person.id, until, this.now());
        this.recordAdminLog(args.chat_id, actorSnap.person.id, "ban", target.person.id, { until_date: until });
      })();
    }
    delta({ before: { status: already ? "kicked" : target.status }, after: { status: "kicked", until_date: until } });
    return { ok: true };
  }

  unbanChatMember(
    actor: Actor,
    args: { chat_id: number; user_id: number | string; only_if_banned?: boolean },
    delta: DeltaHook = NOOP,
  ): { ok: true } {
    const actorSnap = this.requireAdminRight(actor, args.chat_id, "can_restrict_members");
    const person = this.resolvePersonRef(args.user_id);
    this.expireMembership(args.chat_id, person.id);
    const banned = this.banRow(args.chat_id, person.id);
    const member = this.isMemberId(person.id, args.chat_id);
    if (!args.only_if_banned && member) {
      this.assertModerationTarget(actorSnap, this.targetMember(args.chat_id, person.id), "remove");
    }
    this.db.transaction(() => {
      if (banned) this.db.prepare("DELETE FROM chat_bans WHERE chat_id = ? AND user_id = ?").run(args.chat_id, person.id);
      if (!args.only_if_banned && member) {
        this.db.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").run(args.chat_id, person.id);
      }
      if (banned || (!args.only_if_banned && member)) {
        this.recordAdminLog(args.chat_id, actorSnap.person.id, "unban", person.id, { only_if_banned: Boolean(args.only_if_banned) });
      }
    })();
    delta({ before: { banned: Boolean(banned), member }, after: { banned: false, member: args.only_if_banned ? member : false } });
    return { ok: true };
  }

  removeUser(actor: Actor, args: { chat_id: number; user_id: number | string }, delta: DeltaHook = NOOP): { ok: true } {
    const actorSnap = this.requireAdminRight(actor, args.chat_id, "can_restrict_members");
    const target = this.targetMember(args.chat_id, args.user_id);
    if (target.person.id === actorSnap.person.id) telegramFail(400, 400, "Bad Request: use leave_chat to leave");
    if (this.banRow(args.chat_id, target.person.id)) {
      delta({ before: { status: "kicked" }, after: { status: "kicked" } });
      return { ok: true };
    }
    this.assertModerationTarget(actorSnap, target, "remove");
    if (target.isMember) {
      this.db.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").run(args.chat_id, target.person.id);
      this.recordAdminLog(args.chat_id, actorSnap.person.id, "remove", target.person.id, {});
    }
    delta({ before: { status: target.status }, after: { status: "left" } });
    return { ok: true };
  }

  restrictChatMember(
    actor: Actor,
    args: { chat_id: number; user_id: number | string; permissions?: unknown; until_date?: unknown },
    delta: DeltaHook = NOOP,
  ): { ok: true } {
    const actorSnap = this.requireAdminRight(actor, args.chat_id, "can_restrict_members");
    const target = this.targetMember(args.chat_id, args.user_id);
    this.assertModerationTarget(actorSnap, target, "restrict");
    if (!target.isMember) telegramFail(400, 400, "Bad Request: user not found");
    const permissions = requireChatPermissions(args.permissions);
    const until = parseUntilDate(args.until_date, this.now());
    if (allPermissionsAllowed(permissions)) {
      // Full-allow is a restriction lift, not a demotion. Only a restricted row
      // becomes a member; administrator/creator rights stay put.
      if (target.status === "restricted") {
        this.db.prepare(
          "UPDATE chat_members SET status = 'member', restrictions_json = NULL, until_date = 0 WHERE chat_id = ? AND user_id = ?",
        ).run(args.chat_id, target.person.id);
      }
      this.recordAdminLog(args.chat_id, actorSnap.person.id, "restrict", target.person.id, { permissions, until_date: until });
      delta({
        before: { status: target.status },
        after: { status: target.status === "restricted" ? "member" : target.status, permissions, until_date: until },
      });
      return { ok: true };
    }
    this.db.prepare(
      "UPDATE chat_members SET status = 'restricted', admin_rights_json = NULL, restrictions_json = ?, until_date = ? WHERE chat_id = ? AND user_id = ?",
    ).run(JSON.stringify(permissions), until, args.chat_id, target.person.id);
    this.recordAdminLog(args.chat_id, actorSnap.person.id, "restrict", target.person.id, { permissions, until_date: until });
    delta({ before: { status: target.status }, after: { status: "restricted", permissions, until_date: until } });
    return { ok: true };
  }

  setChatPermissions(
    actor: Actor,
    args: { chat_id: number; permissions?: unknown; until_date?: unknown },
    delta: DeltaHook = NOOP,
  ): { ok: true } {
    const actorSnap = this.requireAdminRight(actor, args.chat_id, "can_restrict_members");
    const permissions = requireChatPermissions(args.permissions);
    const until = parseUntilDate(args.until_date, this.now());
    const before = this.defaultPermissions(args.chat_id);
    this.db.prepare("UPDATE chats SET permissions_json = ?, permissions_until = ? WHERE id = ?").run(
      JSON.stringify(permissions),
      until,
      args.chat_id,
    );
    this.recordAdminLog(args.chat_id, actorSnap.person.id, "set_permissions", null, { permissions, until_date: until });
    delta({ before: { permissions: before }, after: { permissions, until_date: until } });
    return { ok: true };
  }

  toggleSlowMode(actor: Actor, args: { chat_id: number; seconds?: unknown }, delta: DeltaHook = NOOP): { ok: true } {
    const seconds = parseSlowMode(args.seconds);
    const chat = this.requireGroup(args.chat_id);
    if (chat.type !== "supergroup") telegramFail(400, 400, "Bad Request: slow mode is only available in supergroups");
    const actorSnap = this.requireAdminRight(actor, args.chat_id, "can_change_info");
    const before = chat.slow_mode_seconds ?? 0;
    if (before !== seconds) {
      this.db.prepare("UPDATE chats SET slow_mode_seconds = ? WHERE id = ?").run(seconds, args.chat_id);
      this.recordAdminLog(args.chat_id, actorSnap.person.id, "toggle_slow_mode", null, { seconds });
    }
    delta({ before: { seconds: before }, after: { seconds } });
    return { ok: true };
  }

  getAdmins(account: string, args: { chat_id: number }): Record<string, unknown>[] {
    this.requireMember({ kind: "user", account }, args.chat_id);
    return this.listAdministrators(args.chat_id);
  }

  getBannedUsers(account: string, args: { chat_id: number }): Record<string, unknown>[] {
    this.requireAdminRight({ kind: "user", account }, args.chat_id, "can_restrict_members");
    this.expireChatMemberships(args.chat_id);
    return (this.db.prepare("SELECT user_id, until_date FROM chat_bans WHERE chat_id = ? ORDER BY user_id").all(args.chat_id) as Array<{ user_id: number; until_date: number }>)
      .map((row) => presentParticipant(this.personById(row.user_id), "kicked", { until_date: row.until_date }));
  }

  getRecentActions(account: string, args: { chat_id: number }): Record<string, unknown>[] {
    const snapshot = this.requireAdminRight({ kind: "user", account }, args.chat_id, "can_manage_chat");
    this.expireChatMemberships(args.chat_id);
    const rows = this.db.prepare(
      "SELECT event_id, actor_id, action, target_id, payload_json, created_at FROM chat_admin_log WHERE chat_id = ? ORDER BY event_id DESC LIMIT ?",
    ).all(args.chat_id, ADMIN_LOG_LIMIT) as Array<{ event_id: number; actor_id: number; action: string; target_id: number | null; payload_json: string | null; created_at: number }>;
    return rows.filter((row) => this.canSeeAdminAction(snapshot, row.action)).map((row) => ({
      id: row.event_id,
      action: row.action,
      actor: serializeUser(this.personById(row.actor_id)),
      ...(row.target_id ? { target: serializeUser(this.personById(row.target_id)) } : {}),
      date: row.created_at,
      ...(row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : {}),
    }));
  }

  getChatAdministrators(actor: Actor, chatId: number): Record<string, unknown>[] {
    this.requireMember(actor, chatId);
    return this.listAdministrators(chatId);
  }

  getChatMemberCount(actor: Actor, chatId: number): number {
    this.requireMember(actor, chatId);
    this.expireChatMemberships(chatId);
    return this.memberCount(chatId);
  }

  getChatMember(actor: Actor, args: { chat_id: number; user_id: number | string }): Record<string, unknown> {
    this.requireMember(actor, args.chat_id);
    const target = this.targetMember(args.chat_id, args.user_id);
    return this.presentMember(target);
  }

  private purgeExpiredUpdates(): void {
    this.db.prepare("DELETE FROM bot_updates WHERE created_at <= ?").run(this.now() - UPDATE_RETENTION_SEC);
  }

  private userByAccount(account: string): { id: number; account: string } {
    const row = this.db.prepare("SELECT id, account FROM users WHERE account = ?").get(account) as
      | { id: number; account: string }
      | undefined;
    if (!row) telegramFail(400, 400, "Bad Request: unknown account");
    return row;
  }

  private personFor(actor: Actor): PersonRow {
    if (actor.kind === "bot") {
      const row = this.db.prepare("SELECT id, first_name, username, 1 AS is_bot FROM bots WHERE id = ?").get(
        actor.botId,
      ) as PersonRow | undefined;
      if (!row) telegramFail(401, 401, "Unauthorized");
      return row;
    }
    const row = this.db
      .prepare("SELECT id, first_name, username, 0 AS is_bot FROM users WHERE account = ?")
      .get(actor.account) as PersonRow | undefined;
    if (!row) telegramFail(400, 400, "Bad Request: unknown account");
    return row;
  }

  private personById(id: number): UserRow {
    const bot = this.db.prepare("SELECT id, first_name, username, 1 AS is_bot FROM bots WHERE id = ?").get(id) as
      | PersonRow
      | undefined;
    if (bot) return this.asUser(bot);
    const user = this.db.prepare("SELECT id, first_name, username, 0 AS is_bot FROM users WHERE id = ?").get(id) as
      | PersonRow
      | undefined;
    if (!user) telegramFail(400, 400, "Bad Request: user not found");
    return this.asUser(user);
  }

  private asUser(row: PersonRow): UserRow {
    return {
      id: row.id,
      first_name: row.first_name,
      username: row.username,
      is_bot: row.is_bot === 1,
    };
  }

  private chat(id: number): ChatRow {
    const row = this.db
      .prepare(
        "SELECT id, type, title, description, photo_file_id, permissions_json, permissions_until, slow_mode_seconds, creator_id FROM chats WHERE id = ?",
      )
      .get(id) as ChatRow | undefined;
    if (!row) telegramFail(400, 400, "Bad Request: chat not found");
    return row;
  }

  private requireMember(actor: Actor, chatId: number): void {
    this.chat(chatId);
    const person = this.personFor(actor);
    if (!this.isMemberId(person.id, chatId)) telegramFail(400, 400, "Bad Request: chat not found");
  }

  private isMemberId(userId: number, chatId: number): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 AS ok FROM chat_members WHERE chat_id = ? AND user_id = ?").get(chatId, userId),
    );
  }

  private memberChatIds(account: string): number[] {
    const user = this.userByAccount(account);
    return (
      this.db.prepare("SELECT chat_id FROM chat_members WHERE user_id = ?").all(user.id) as Array<{ chat_id: number }>
    ).map((row) => row.chat_id);
  }

  private visibleMessages(account: string, chatId: number): MessageRow[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY message_id")
      .all(chatId) as MessageRow[];
    const hidden = new Set(
      (
        this.db
          .prepare("SELECT message_id FROM message_hides WHERE account = ? AND chat_id = ?")
          .all(account, chatId) as Array<{ message_id: number }>
      ).map((row) => row.message_id),
    );
    return rows.filter((row) => !hidden.has(row.message_id));
  }

  private requireVisibleMessage(actor: Actor, chatId: number, messageId: number): MessageRow {
    this.requireMember(actor, chatId);
    const row = this.db
      .prepare("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
      .get(chatId, messageId) as MessageRow | undefined;
    if (!row) telegramFail(400, 400, "Bad Request: message not found");
    if (actor.kind === "user") {
      const hidden = this.db
        .prepare("SELECT 1 AS ok FROM message_hides WHERE account = ? AND chat_id = ? AND message_id = ?")
        .get(actor.account, chatId, messageId);
      if (hidden) telegramFail(400, 400, "Bad Request: message not found");
    }
    return row;
  }

  private parseReplyMarkup(value: unknown): ReplyMarkup {
    if (!value || typeof value !== "object" || Array.isArray(value)) telegramFail(400, 400, "Bad Request: reply_markup is invalid");
    const input = value as Record<string, unknown>;
    if (input.remove_keyboard === true && Object.keys(input).length === 1) return { remove_keyboard: true };
    const parseRows = (raw: unknown, inline: boolean): Array<Array<{ text: string; callback_data: string }>> | Array<Array<{ text: string }>> => {
      if (!Array.isArray(raw) || raw.length === 0 || raw.some((row) => !Array.isArray(row) || row.length === 0)) telegramFail(400, 400, "Bad Request: reply_markup is invalid");
      return (raw as unknown[][]).map((row) => row.map((item: unknown) => {
        if (typeof item === "string") {
          if (inline) telegramFail(400, 400, "Bad Request: inline button is invalid");
          return { text: item };
        }
        if (!item || typeof item !== "object" || Array.isArray(item) || typeof (item as Record<string, unknown>).text !== "string") telegramFail(400, 400, "Bad Request: reply_markup is invalid");
        const button = item as Record<string, unknown>;
        if (!inline) {
          if (Object.keys(button).some((key) => key !== "text")) telegramFail(400, 400, "Bad Request: unsupported reply keyboard button");
          return { text: button.text as string };
        }
        if (typeof button.callback_data !== "string" || Object.keys(button).some((key) => key !== "text" && key !== "callback_data")) telegramFail(400, 400, "Bad Request: unsupported inline button");
        if (!isCallbackData(button.callback_data)) telegramFail(400, 400, "Bad Request: callback_data must be non-empty UTF-8 and at most 64 bytes");
        return { text: button.text as string, callback_data: button.callback_data };
      }));
    };
    if ("inline_keyboard" in input && Object.keys(input).length === 1) return { inline_keyboard: parseRows(input.inline_keyboard, true) as Array<Array<{ text: string; callback_data: string }>> };
    if ("keyboard" in input && Object.keys(input).every((key) => key === "keyboard" || key === "resize_keyboard" || key === "one_time_keyboard")) return { reply_keyboard: parseRows(input.keyboard, false) as Array<Array<{ text: string }>> };
    telegramFail(400, 400, "Bad Request: unsupported reply_markup");
  }

  private parseReaction(value: unknown): string | undefined {
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return undefined;
    if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") telegramFail(400, 400, "Bad Request: unsupported reaction");
    const reaction = value[0] as Record<string, unknown>;
    if (reaction.type !== "emoji" || typeof reaction.emoji !== "string" || reaction.emoji.length === 0 || Object.keys(reaction).some((key) => key !== "type" && key !== "emoji")) telegramFail(400, 400, "Bad Request: unsupported reaction");
    return reaction.emoji;
  }

  private requirePinAuthority(actor: Actor, row: MessageRow): void {
    this.requireChatPinAuthority(actor, row.chat_id);
    const chat = this.chat(row.chat_id);
    if (chat.type === "private" && actor.kind === "user" && row.from_id !== this.personFor(actor).id) {
      telegramFail(400, 400, "Bad Request: not enough rights to pin the message");
    }
  }

  private requireChatPinAuthority(actor: Actor, chatId: number): void {
    const chat = this.chat(chatId);
    if (chat.type === "private") return;
    const snapshot = this.membershipSnapshot(actor, chatId);
    if (snapshot.status === "creator") return;
    if (snapshot.status === "administrator") {
      if (snapshot.rights?.can_pin_messages) return;
      telegramFail(400, 400, "Bad Request: not enough rights to pin messages");
    }
    if (snapshot.permissions.can_pin_messages) return;
    telegramFail(400, 400, "Bad Request: not enough rights to pin messages");
  }

  private isBotId(id: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS ok FROM bots WHERE id = ?").get(id));
  }

  private pollForMessage(actor: Actor, chatId: number, messageId: number): PollRow {
    this.requireVisibleMessage(actor, chatId, messageId);
    const poll = this.db.prepare("SELECT * FROM polls WHERE chat_id = ? AND message_id = ?").get(chatId, messageId) as PollRow | undefined;
    if (!poll) telegramFail(400, 400, "Bad Request: poll not found");
    return poll;
  }

  private presentPoll(pollId: string): Record<string, unknown> {
    const poll = this.db.prepare("SELECT * FROM polls WHERE poll_id = ?").get(pollId) as PollRow | undefined;
    if (!poll) telegramFail(400, 400, "Bad Request: poll not found");
    const options = JSON.parse(poll.options_json) as string[];
    const counts = this.db.prepare("SELECT option_id, COUNT(*) AS count FROM poll_votes WHERE poll_id = ? GROUP BY option_id").all(poll.poll_id) as Array<{ option_id: number; count: number }>;
    const countByOption = new Map(counts.map((count) => [count.option_id, count.count]));
    const total = (this.db.prepare("SELECT COUNT(DISTINCT voter_id) AS count FROM poll_votes WHERE poll_id = ?").get(poll.poll_id) as { count: number }).count;
    const recentVoters = poll.is_anonymous ? [] : (this.db.prepare("SELECT DISTINCT voter_id FROM poll_votes WHERE poll_id = ? ORDER BY voter_id LIMIT 3").all(poll.poll_id) as Array<{ voter_id: number }>).map((vote) => serializeUser(this.personById(vote.voter_id)));
    return { id: poll.poll_id, question: poll.question, options: options.map((text, index) => ({ text, voter_count: countByOption.get(index) ?? 0 })), total_voter_count: total, is_closed: Boolean(poll.is_closed), is_anonymous: Boolean(poll.is_anonymous), allows_multiple_answers: Boolean(poll.allows_multiple_answers), type: "regular", ...(!poll.is_anonymous ? { recent_voters: recentVoters } : {}) };
  }

  private hardDelete(chatId: number, messageId: number): void {
    const polls = this.db
      .prepare("SELECT poll_id FROM polls WHERE chat_id = ? AND message_id = ?")
      .all(chatId, messageId) as Array<{ poll_id: string }>;
    this.db.transaction(() => {
      for (const poll of polls) {
        this.db.prepare("DELETE FROM poll_votes WHERE poll_id = ?").run(poll.poll_id);
        this.db.prepare("DELETE FROM polls WHERE poll_id = ?").run(poll.poll_id);
      }
      this.db.prepare("DELETE FROM callback_queries WHERE chat_id = ? AND message_id = ?").run(chatId, messageId);
      this.db.prepare("DELETE FROM messages WHERE chat_id = ? AND message_id = ?").run(chatId, messageId);
      this.db.prepare("DELETE FROM message_hides WHERE chat_id = ? AND message_id = ?").run(chatId, messageId);
    })();
  }

  private present(row: MessageRow): Record<string, unknown> {
    const message = serializeMessage(row, this.personById(row.from_id), this.chat(row.chat_id));
    const poll = this.db.prepare("SELECT poll_id FROM polls WHERE chat_id = ? AND message_id = ?").get(row.chat_id, row.message_id) as { poll_id: string } | undefined;
    return poll ? { ...message, poll: this.presentPoll(poll.poll_id) } : message;
  }

  private presentChat(row: ChatRow): Record<string, unknown> {
    if (row.type === "private") return serializeChat(row);
    return serializeChat(row, {
      permissions: this.defaultPermissions(row.id),
      ...(row.description ? { description: row.description } : {}),
      ...(row.slow_mode_seconds ? { slow_mode_delay: row.slow_mode_seconds } : {}),
      ...(row.photo_file_id
        ? { photo: { small_file_id: row.photo_file_id, big_file_id: row.photo_file_id } }
        : {}),
    });
  }

  private requireGroup(chatId: number): ChatRow {
    const chat = this.chat(chatId);
    if (chat.type === "private") telegramFail(400, 400, "Bad Request: chat is not a group");
    return chat;
  }

  private nextGroupId(): number {
    const lowest = this.db.prepare("SELECT MIN(id) AS id FROM chats").get() as { id: number | null };
    const floor = -1002000000000;
    return Math.min(lowest.id ?? floor, floor) - 1;
  }

  private insertMember(chatId: number, userId: number, status: "creator" | "administrator" | "member"): void {
    this.db.prepare(
      "INSERT INTO chat_members (chat_id, user_id, status, admin_rights_json, restrictions_json, until_date, custom_title, is_anonymous) VALUES (?, ?, ?, ?, NULL, 0, NULL, 0)",
    ).run(chatId, userId, status, status === "administrator" ? JSON.stringify(DEFAULT_PROMOTE_RIGHTS) : null);
  }

  private recordAdminLog(chatId: number, actorId: number, action: string, targetId: number | null, payload: Record<string, unknown>): void {
    const next = (this.db.prepare("SELECT next_admin_log_id AS next FROM chats WHERE id = ?").get(chatId) as { next: number }).next;
    this.db.prepare("UPDATE chats SET next_admin_log_id = next_admin_log_id + 1 WHERE id = ?").run(chatId);
    this.db.prepare(
      "INSERT INTO chat_admin_log (chat_id, event_id, actor_id, action, target_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(chatId, next, actorId, action, targetId, JSON.stringify(payload), this.now());
  }

  private memberRows(chatId: number): MemberRecord[] {
    this.expireChatMemberships(chatId);
    return this.db.prepare("SELECT * FROM chat_members WHERE chat_id = ? ORDER BY user_id").all(chatId) as MemberRecord[];
  }

  private memberCount(chatId: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM chat_members WHERE chat_id = ?").get(chatId) as { count: number }).count;
  }

  private memberStatus(row: MemberRecord): MemberStatus {
    return row.status as MemberStatus;
  }

  private banRow(chatId: number, userId: number): { user_id: number; until_date: number } | undefined {
    return this.db.prepare("SELECT user_id, until_date FROM chat_bans WHERE chat_id = ? AND user_id = ?").get(chatId, userId) as
      | { user_id: number; until_date: number }
      | undefined;
  }

  private expireMembership(chatId: number, userId: number): void {
    const now = this.now();
    const member = this.db.prepare("SELECT status, until_date FROM chat_members WHERE chat_id = ? AND user_id = ?").get(chatId, userId) as
      | { status: string; until_date: number }
      | undefined;
    if (member?.status === "restricted" && member.until_date > 0 && member.until_date <= now) {
      this.db.prepare(
        "UPDATE chat_members SET status = 'member', restrictions_json = NULL, until_date = 0 WHERE chat_id = ? AND user_id = ?",
      ).run(chatId, userId);
    }
    const banned = this.banRow(chatId, userId);
    if (banned && banned.until_date > 0 && banned.until_date <= now) {
      this.db.prepare("DELETE FROM chat_bans WHERE chat_id = ? AND user_id = ?").run(chatId, userId);
    }
    const chat = this.db.prepare("SELECT permissions_until FROM chats WHERE id = ?").get(chatId) as { permissions_until: number } | undefined;
    if (chat && chat.permissions_until > 0 && chat.permissions_until <= now) {
      this.db.prepare("UPDATE chats SET permissions_json = ?, permissions_until = 0 WHERE id = ?").run(
        JSON.stringify(DEFAULT_CHAT_PERMISSIONS),
        chatId,
      );
    }
  }

  private expireChatMemberships(chatId: number): void {
    const members = this.db.prepare("SELECT user_id FROM chat_members WHERE chat_id = ?").all(chatId) as Array<{ user_id: number }>;
    const banned = this.db.prepare("SELECT user_id FROM chat_bans WHERE chat_id = ?").all(chatId) as Array<{ user_id: number }>;
    const seen = new Set<number>();
    for (const row of [...members, ...banned]) {
      if (seen.has(row.user_id)) continue;
      seen.add(row.user_id);
      this.expireMembership(chatId, row.user_id);
    }
    this.expireMembership(chatId, 0);
  }

  private defaultPermissions(chatId: number): ChatPermissions {
    this.expireMembership(chatId, 0);
    const row = this.db.prepare("SELECT permissions_json FROM chats WHERE id = ?").get(chatId) as { permissions_json: string | null } | undefined;
    return parseChatPermissions(row?.permissions_json ? JSON.parse(row.permissions_json) : undefined);
  }

  private resolvePersonRef(ref: number | string): PersonRow {
    if (typeof ref === "number" || /^-?\d+$/.test(String(ref))) {
      const id = typeof ref === "number" ? ref : Number(ref);
      const bot = this.db.prepare("SELECT id, first_name, username, 1 AS is_bot FROM bots WHERE id = ?").get(id) as PersonRow | undefined;
      if (bot) return bot;
      const user = this.db.prepare("SELECT id, first_name, username, 0 AS is_bot FROM users WHERE id = ?").get(id) as PersonRow | undefined;
      if (!user) telegramFail(400, 400, "Bad Request: user not found");
      return user;
    }
    const name = String(ref).replace(/^@/, "");
    const user = this.db
      .prepare("SELECT id, first_name, username, 0 AS is_bot FROM users WHERE username = ? OR account = ?")
      .get(name, name) as PersonRow | undefined;
    if (user) return user;
    const bot = this.db.prepare("SELECT id, first_name, username, 1 AS is_bot FROM bots WHERE username = ?").get(name) as PersonRow | undefined;
    if (!bot) telegramFail(400, 400, "Bad Request: user not found");
    return bot;
  }

  private membershipSnapshot(actor: Actor, chatId: number): MembershipSnapshot {
    const person = this.personFor(actor);
    return this.targetMember(chatId, person.id);
  }

  private targetMember(chatId: number, ref: number | string): MembershipSnapshot {
    this.chat(chatId);
    const person = this.resolvePersonRef(ref);
    this.expireMembership(chatId, person.id);
    const row = this.db.prepare("SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?").get(chatId, person.id) as MemberRecord | undefined;
    const banned = this.banRow(chatId, person.id);
    if (banned) {
      return {
        person,
        status: "kicked",
        rights: null,
        permissions: DEFAULT_CHAT_PERMISSIONS,
        untilDate: banned.until_date,
        customTitle: null,
        isAnonymous: false,
        isMember: false,
      };
    }
    if (!row) {
      return {
        person,
        status: "left",
        rights: null,
        permissions: DEFAULT_CHAT_PERMISSIONS,
        untilDate: 0,
        customTitle: null,
        isAnonymous: false,
        isMember: false,
      };
    }
    const status = this.memberStatus(row);
    const rights = status === "creator"
      ? FULL_ADMIN_RIGHTS
      : status === "administrator" && row.admin_rights_json
        ? parseAdminRights(JSON.parse(row.admin_rights_json))
        : null;
    const restrictions = row.restrictions_json ? parseChatPermissions(JSON.parse(row.restrictions_json)) : null;
    return {
      person,
      status,
      rights,
      permissions: effectivePermissions({ status, restrictions, defaults: this.defaultPermissions(chatId) }),
      untilDate: row.until_date,
      customTitle: row.custom_title,
      isAnonymous: row.is_anonymous === 1,
      isMember: true,
    };
  }

  private presentMember(snapshot: MembershipSnapshot): Record<string, unknown> {
    return serializeChatMember({
      status: snapshot.status,
      user: this.asUser(snapshot.person),
      isAnonymous: snapshot.isAnonymous,
      customTitle: snapshot.customTitle,
      rights: snapshot.rights,
      permissions: snapshot.permissions,
      untilDate: snapshot.untilDate,
      isMember: snapshot.isMember,
    });
  }

  private listAdministrators(chatId: number): Record<string, unknown>[] {
    return this.memberRows(chatId)
      .filter((row) => row.status === "creator" || row.status === "administrator")
      .map((row) => this.presentMember(this.targetMember(chatId, row.user_id)));
  }

  private requirePermission(
    actor: Actor,
    chatId: number,
    permission: keyof ChatPermissions,
    adminRight: keyof AdminRights,
  ): MembershipSnapshot {
    this.requireGroup(chatId);
    const snapshot = this.membershipSnapshot(actor, chatId);
    if (!snapshot.isMember) telegramFail(400, 400, "Bad Request: chat not found");
    if (snapshot.status === "creator") return snapshot;
    if (snapshot.status === "administrator" && snapshot.rights?.[adminRight]) return snapshot;
    if ((snapshot.status === "member" || snapshot.status === "restricted") && snapshot.permissions[permission]) return snapshot;
    telegramFail(400, 400, "Bad Request: not enough rights");
  }

  private requireAdminRight(actor: Actor, chatId: number, right: keyof AdminRights): MembershipSnapshot {
    this.requireGroup(chatId);
    const snapshot = this.membershipSnapshot(actor, chatId);
    if (!snapshot.isMember) telegramFail(400, 400, "Bad Request: chat not found");
    if (snapshot.status === "creator") return snapshot;
    if (snapshot.status === "administrator" && snapshot.rights?.[right]) return snapshot;
    telegramFail(400, 400, "Bad Request: not enough rights");
  }

  private assertModerationTarget(actor: MembershipSnapshot, target: MembershipSnapshot, action: "ban" | "remove" | "restrict"): void {
    if (target.person.id === actor.person.id) telegramFail(400, 400, `Bad Request: can't ${action} self`);
    if (target.status === "creator") telegramFail(400, 400, `Bad Request: can't ${action} the chat creator`);
    if (target.status === "administrator" && actor.status !== "creator") {
      telegramFail(400, 400, `Bad Request: can't ${action} another administrator`);
    }
  }

  private assertCanSend(
    actor: Actor,
    chatId: number,
    kind: "messages" | "photos" | "documents" | "videos" | "audios" | "voice_notes" | "other_messages" | "polls",
  ): void {
    const chat = this.chat(chatId);
    if (chat.type === "private") return;
    const snapshot = this.membershipSnapshot(actor, chatId);
    if (snapshot.status === "creator" || snapshot.status === "administrator") return;
    const permission = kind === "messages"
      ? snapshot.permissions.can_send_messages
      : kind === "photos"
        ? snapshot.permissions.can_send_photos
        : kind === "documents"
          ? snapshot.permissions.can_send_documents
          : kind === "videos"
            ? snapshot.permissions.can_send_videos
            : kind === "audios"
              ? snapshot.permissions.can_send_audios
              : kind === "voice_notes"
                ? snapshot.permissions.can_send_voice_notes
                : kind === "polls"
                  ? snapshot.permissions.can_send_polls
                  : snapshot.permissions.can_send_other_messages;
    if (!permission) telegramFail(400, 400, "Bad Request: not enough rights to send");
    const delay = chat.slow_mode_seconds ?? 0;
    if (delay > 0) {
      const last = this.db.prepare("SELECT MAX(date) AS date FROM messages WHERE chat_id = ? AND from_id = ?").get(chatId, snapshot.person.id) as { date: number | null };
      if (last.date !== null && this.now() < last.date + delay) telegramFail(400, 400, "Bad Request: slow mode is active");
    }
  }

  private canSeeAdminAction(snapshot: MembershipSnapshot, _action: string): boolean {
    return snapshot.status === "creator" || snapshot.status === "administrator";
  }
}

type MemberRecord = {
  chat_id: number;
  user_id: number;
  status: string;
  admin_rights_json: string | null;
  restrictions_json: string | null;
  until_date: number;
  custom_title: string | null;
  is_anonymous: number;
};

type MembershipSnapshot = {
  person: PersonRow;
  status: MemberStatus;
  rights: AdminRights | null;
  permissions: ChatPermissions;
  untilDate: number;
  customTitle: string | null;
  isAnonymous: boolean;
  isMember: boolean;
};
