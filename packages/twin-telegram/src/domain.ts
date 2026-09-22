// SPDX-License-Identifier: Apache-2.0
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
  | { kind: "bot"; botId: number }
  | { kind: "user"; account: string };

type PersonRow = { id: number; first_name: string; username: string | null; is_bot: number };

export const BOT_DELETE_WINDOW_SEC = 48 * 3600;

export class TelegramDomain {
  private readonly runtime: ReturnType<typeof telegramUpdateRuntime>;

  constructor(
    readonly db: TelegramTwinDatabase,
    readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly localWebhookUrls: ReadonlySet<string> = new Set(),
  ) {
    this.runtime = telegramUpdateRuntime(db);
    this.runtime.registerDispatcher(() => this.flushWebhookOutbox(), now);
  }

  seed(input: TelegramSeed | unknown): void {
    const state = parseSeed(input);
    this.runtime.cancelAll();
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
        this.db.prepare("INSERT INTO chats (id, type, title, next_message_id) VALUES (?, ?, ?, 1)").run(
          chat.id,
          chat.type,
          chat.title ?? null,
        );
        for (const member of chat.members) {
          this.db.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)").run(chat.id, member);
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
    return serializeChat(this.chat(chatId));
  }

  sendMessage(
    actor: Actor,
    args: {
      chat_id: number;
      text: string;
      reply_to_message_id?: number;
      forward_from_id?: number;
      forward_from_chat_id?: number;
    },
    delta: DeltaHook = NOOP,
  ): Record<string, unknown> {
    if (!args.text) telegramFail(400, 400, "Bad Request: message text is empty");
    this.requireMember(actor, args.chat_id);
    if (args.reply_to_message_id !== undefined) {
      this.requireVisibleMessage(actor, args.chat_id, args.reply_to_message_id);
    }
    const from = this.personFor(actor);
    const date = this.now();
    const emittedBotIds: number[] = [];
    const next = this.db.transaction(() => {
      const allocated = (this.db.prepare("SELECT next_message_id AS next FROM chats WHERE id = ?").get(args.chat_id) as {
        next: number;
      }).next;
      this.db.prepare("UPDATE chats SET next_message_id = next_message_id + 1 WHERE id = ?").run(args.chat_id);
      this.db
        .prepare(
          "INSERT INTO messages (chat_id, message_id, from_id, text, date, reply_to_message_id, edit_date, forward_from_id, forward_from_chat_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
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
    };
    delta({
      before: null,
      after: { chat_id: args.chat_id, message_id: next, text: args.text, from_id: from.id },
    });
    return serializeMessage(row, this.asUser(from), this.chat(args.chat_id));
  }

  listAccounts(): Array<{ account: string; id: number }> {
    return (
      this.db.prepare("SELECT account, id FROM users ORDER BY account").all() as Array<{
        account: string;
        id: number;
      }>
    );
  }

  listChats(account: string): Record<string, unknown>[] {
    const user = this.userByAccount(account);
    const chats = this.db
      .prepare(
        "SELECT c.id, c.type, c.title FROM chats c JOIN chat_members m ON m.chat_id = c.id WHERE m.user_id = ? ORDER BY c.id",
      )
      .all(user.id) as ChatRow[];
    return chats.map(serializeChat);
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
    this.db.transaction(() => {
      for (const message_id of args.message_ids) {
        this.deleteMessage(actor, { chat_id: args.chat_id, message_id }, delta);
      }
    })();
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
        .all(botId, -offset) as Array<{ update_id: number; payload_json: string }>;
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
    return { ok: true };
  }

  deleteWebhook(actor: Actor, args: { drop_pending_updates?: boolean }): { ok: true } {
    const botId = this.botId(actor);
    this.db.transaction(() => {
      this.settings(botId);
      this.db
        .prepare("UPDATE bot_update_settings SET webhook_url = NULL, webhook_secret_token = NULL, last_error_date = NULL, last_error_message = NULL WHERE bot_id = ?")
        .run(botId);
      this.db.prepare("DELETE FROM webhook_outbox WHERE bot_id = ?").run(botId);
      if (args.drop_pending_updates) this.db.prepare("DELETE FROM bot_updates WHERE bot_id = ?").run(botId);
    })();
    this.runtime.notify(botId);
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
      .prepare("SELECT MIN(next_attempt_at) AS next_attempt_at FROM webhook_outbox WHERE locked_until <= ?")
      .get(this.now()) as { next_attempt_at: number | null };
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
    const emitted: number[] = [];
    for (const bot of bots) {
      const settings = this.settings(bot.id);
      const allowed = settings.allowed_updates_json ? (JSON.parse(settings.allowed_updates_json) as string[]) : undefined;
      if (allowed && !allowed.includes("message")) continue;
      const updateId = settings.next_update_id;
      const payload = { update_id: updateId, message };
      this.db
        .prepare("INSERT INTO bot_updates (bot_id, update_id, update_type, payload_json, created_at) VALUES (?, ?, 'message', ?, ?)")
        .run(bot.id, updateId, JSON.stringify(payload), createdAt);
      this.db.prepare("UPDATE bot_update_settings SET next_update_id = next_update_id + 1 WHERE bot_id = ?").run(bot.id);
      if (settings.webhook_url) {
        this.db
          .prepare("INSERT INTO webhook_outbox (bot_id, update_id, attempts, next_attempt_at) VALUES (?, ?, 0, ?)")
          .run(bot.id, updateId, createdAt);
      }
      emitted.push(bot.id);
    }
    return emitted;
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
    const row = this.db.prepare("SELECT id, type, title FROM chats WHERE id = ?").get(id) as ChatRow | undefined;
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

  private hardDelete(chatId: number, messageId: number): void {
    this.db.prepare("DELETE FROM messages WHERE chat_id = ? AND message_id = ?").run(chatId, messageId);
    this.db.prepare("DELETE FROM message_hides WHERE chat_id = ? AND message_id = ?").run(chatId, messageId);
  }

  private present(row: MessageRow): Record<string, unknown> {
    return serializeMessage(row, this.personById(row.from_id), this.chat(row.chat_id));
  }
}
