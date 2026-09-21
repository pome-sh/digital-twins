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

export type DeltaHook = (delta: StateDelta) => void;
const NOOP: DeltaHook = () => {};

export type Actor =
  | { kind: "bot"; botId: number }
  | { kind: "user"; account: string };

type PersonRow = { id: number; first_name: string; username: string | null; is_bot: number };

export const BOT_DELETE_WINDOW_SEC = 48 * 3600;

export class TelegramDomain {
  constructor(
    readonly db: TelegramTwinDatabase,
    readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  seed(input: TelegramSeed | unknown): void {
    const state = parseSeed(input);
    const now = Math.floor(Date.now() / 1000);
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
      return allocated;
    })();
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

  deleteMessage(actor: Actor, args: { chat_id: number; message_id: number; revoke?: boolean }): { ok: true } {
    const row = this.requireVisibleMessage(actor, args.chat_id, args.message_id);
    const person = this.personFor(actor);
    if (actor.kind === "bot") {
      if (this.now() - row.date > BOT_DELETE_WINDOW_SEC) {
        telegramFail(400, 400, "Bad Request: message can't be deleted");
      }
      this.hardDelete(args.chat_id, args.message_id);
      return { ok: true };
    }
    if (row.from_id === person.id || args.revoke) {
      if (row.from_id !== person.id) telegramFail(400, 400, "Bad Request: message can't be deleted");
      this.hardDelete(args.chat_id, args.message_id);
      return { ok: true };
    }
    this.db
      .prepare("INSERT OR IGNORE INTO message_hides (account, chat_id, message_id) VALUES (?, ?, ?)")
      .run(actor.account, args.chat_id, args.message_id);
    return { ok: true };
  }

  deleteMessages(actor: Actor, args: { chat_id: number; message_ids: number[] }): { ok: true } {
    if (args.message_ids.length === 0) telegramFail(400, 400, "Bad Request: message_ids is empty");
    for (const message_id of args.message_ids) {
      this.deleteMessage(actor, { chat_id: args.chat_id, message_id });
    }
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
    this.requireMember({ kind: "user", account }, args.chat_id);
    const limit = args.limit ?? 10;
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
    const match = link.match(/^(?:tg:\/\/message\?|https:\/\/t\.me\/c\/)(?:chat_id=)?(-?\d+)(?:&message_id=|\/)(\d+)$/);
    if (!match) telegramFail(400, 400, "Bad Request: unsupported link");
    return this.present(this.requireVisibleMessage({ kind: "user", account }, Number(match[1]), Number(match[2])));
  }

  markAsRead(account: string, args: { chat_id: number; message_id: number }): { ok: true } {
    this.requireVisibleMessage({ kind: "user", account }, args.chat_id, args.message_id);
    this.db
      .prepare(
        "INSERT INTO read_cursors (account, chat_id, last_read) VALUES (?, ?, ?) ON CONFLICT(account, chat_id) DO UPDATE SET last_read = excluded.last_read",
      )
      .run(account, args.chat_id, args.message_id);
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
