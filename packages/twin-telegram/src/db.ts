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

-- Bot API updates stay in SQLite so polling, webhook delivery, and restart
-- all see the same queue. A row leaves this table only after an offset ack,
-- retention expiry, or a successful webhook delivery.
CREATE TABLE IF NOT EXISTS bot_update_settings (
  bot_id INTEGER PRIMARY KEY,
  next_update_id INTEGER NOT NULL DEFAULT 1,
  allowed_updates_json TEXT,
  webhook_url TEXT,
  webhook_secret_token TEXT,
  webhook_max_connections INTEGER NOT NULL DEFAULT 40,
  last_error_date INTEGER,
  last_error_message TEXT,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bot_updates (
  bot_id INTEGER NOT NULL,
  update_id INTEGER NOT NULL,
  update_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, update_id),
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
);

-- The outbox is intentionally separate from bot_updates. A delivery failure
-- must never roll back a message or make the update disappear.
CREATE TABLE IF NOT EXISTS webhook_outbox (
  bot_id INTEGER NOT NULL,
  update_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (bot_id, update_id),
  FOREIGN KEY (bot_id, update_id) REFERENCES bot_updates(bot_id, update_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bot_updates_retention ON bot_updates(created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_due ON webhook_outbox(next_attempt_at, locked_until);
`;

const RESET_SQL = `
DELETE FROM webhook_outbox;
DELETE FROM bot_updates;
DELETE FROM bot_update_settings;
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
