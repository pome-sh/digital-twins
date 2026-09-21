// SPDX-License-Identifier: Apache-2.0
import { openTwinDatabase, type TwinDatabase } from "@pome-sh/sdk";

export type TelegramTwinDatabase = TwinDatabase;

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  username TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  username TEXT
);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT,
  next_message_id INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  from_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  date INTEGER NOT NULL,
  reply_to_message_id INTEGER,
  edit_date INTEGER,
  forward_from_id INTEGER,
  forward_from_chat_id INTEGER,
  PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS message_hides (
  account TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (account, chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS read_cursors (
  account TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  last_read INTEGER NOT NULL,
  PRIMARY KEY (account, chat_id)
);
`;

const RESET_SQL = `
DELETE FROM read_cursors;
DELETE FROM message_hides;
DELETE FROM messages;
DELETE FROM chat_members;
DELETE FROM chats;
DELETE FROM users;
DELETE FROM bots;
`;

export function openTelegramTwinDatabase(path = ":memory:"): TelegramTwinDatabase {
  return openTwinDatabase(path, { migrate });
}

export function migrate(db: TelegramTwinDatabase): void {
  db.exec(MIGRATION_SQL);
  for (const [table, column, spec] of [
    ["messages", "edit_date", "INTEGER"],
    ["messages", "forward_from_id", "INTEGER"],
    ["messages", "forward_from_chat_id", "INTEGER"],
    ["chats", "next_message_id", "INTEGER NOT NULL DEFAULT 1"],
  ] as const) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((col) => col.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
  }
  db.exec(`
    UPDATE chats SET next_message_id = (
      SELECT COALESCE(MAX(message_id), 0) + 1 FROM messages WHERE chat_id = chats.id
    )
    WHERE next_message_id <= (
      SELECT COALESCE(MAX(message_id), 0) FROM messages WHERE chat_id = chats.id
    )
  `);
}

export function resetDatabase(db: TelegramTwinDatabase): void {
  db.exec(RESET_SQL);
}
