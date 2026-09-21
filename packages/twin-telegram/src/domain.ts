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

export class TelegramDomain {
  constructor(readonly db: TelegramTwinDatabase) {}

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
        this.db.prepare("INSERT INTO chats (id, type, title) VALUES (?, ?, ?)").run(
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
            "INSERT INTO messages (chat_id, message_id, from_id, text, date, reply_to_message_id) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            message.chat_id,
            message.message_id,
            message.from_id,
            message.text,
            now,
            message.reply_to_message_id ?? null,
          );
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
    args: { chat_id: number; text: string; reply_to_message_id?: number },
    delta: DeltaHook = NOOP,
  ): Record<string, unknown> {
    if (!args.text) telegramFail(400, 400, "Bad Request: message text is empty");
    this.requireMember(actor, args.chat_id);
    if (args.reply_to_message_id !== undefined) {
      const reply = this.db
        .prepare("SELECT message_id FROM messages WHERE chat_id = ? AND message_id = ?")
        .get(args.chat_id, args.reply_to_message_id);
      if (!reply) telegramFail(400, 400, "Bad Request: reply message not found");
    }
    const from = this.personFor(actor);
    const date = Math.floor(Date.now() / 1000);
    const next = this.db.transaction(() => {
      const allocated = (
        this.db.prepare("SELECT COALESCE(MAX(message_id), 0) + 1 AS next FROM messages WHERE chat_id = ?").get(
          args.chat_id,
        ) as { next: number }
      ).next;
      this.db
        .prepare(
          "INSERT INTO messages (chat_id, message_id, from_id, text, date, reply_to_message_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(args.chat_id, allocated, from.id, args.text, date, args.reply_to_message_id ?? null);
      return allocated;
    })();
    const row: MessageRow = {
      chat_id: args.chat_id,
      message_id: next,
      from_id: from.id,
      text: args.text,
      date,
      reply_to_message_id: args.reply_to_message_id ?? null,
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
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY message_id")
      .all(chatId) as MessageRow[];
    return rows.map((row) => serializeMessage(row, this.personById(row.from_id), this.chat(row.chat_id)));
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
    const member = this.db
      .prepare("SELECT 1 AS ok FROM chat_members WHERE chat_id = ? AND user_id = ?")
      .get(chatId, person.id);
    if (!member) telegramFail(400, 400, "Bad Request: chat not found");
  }
}
