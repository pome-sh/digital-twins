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
  description TEXT,
  photo_file_id TEXT,
  username TEXT,
  is_forum INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 0,
  permissions_json TEXT,
  permissions_until INTEGER NOT NULL DEFAULT 0,
  slow_mode_seconds INTEGER NOT NULL DEFAULT 0,
  creator_id INTEGER,
  next_message_id INTEGER NOT NULL DEFAULT 1,
  next_admin_log_id INTEGER NOT NULL DEFAULT 1,
  next_invite_id INTEGER NOT NULL DEFAULT 1,
  next_topic_id INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'member',
  admin_rights_json TEXT,
  restrictions_json TEXT,
  until_date INTEGER NOT NULL DEFAULT 0,
  custom_title TEXT,
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);

-- Banned users are not members. Unban does not restore membership.
CREATE TABLE IF NOT EXISTS chat_bans (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  banned_by_id INTEGER NOT NULL,
  until_date INTEGER NOT NULL DEFAULT 0,
  banned_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat_admin_log (
  chat_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_id INTEGER,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, event_id)
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
  reply_markup_json TEXT,
  media_json TEXT,
  message_thread_id INTEGER,
  PRIMARY KEY (chat_id, message_id)
);

-- Invite tokens are bound to chat and creator. Expiry uses the injected clock.
CREATE TABLE IF NOT EXISTS chat_invite_links (
  token TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  name TEXT,
  expire_date INTEGER NOT NULL DEFAULT 0,
  member_limit INTEGER NOT NULL DEFAULT 0,
  creates_join_request INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_revoked INTEGER NOT NULL DEFAULT 0,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_join_requests (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);

-- Close is not delete: thread associations stay on messages after close.
CREATE TABLE IF NOT EXISTS forum_topics (
  chat_id INTEGER NOT NULL,
  topic_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  icon_color INTEGER,
  icon_emoji_id INTEGER,
  is_closed INTEGER NOT NULL DEFAULT 0,
  created_by_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, topic_id)
);

-- Media bytes are deliberately stored in SQLite, never read from a host path.
-- file_id is bot-scoped; file_unique_id is response metadata, not an input handle.
CREATE TABLE IF NOT EXISTS media_files (
  file_id TEXT PRIMARY KEY,
  bot_id INTEGER NOT NULL,
  scope_id TEXT NOT NULL DEFAULT 'local',
  file_unique_id TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(bot_id, scope_id, sha256)
);
CREATE INDEX IF NOT EXISTS idx_media_files_expiry ON media_files(expires_at);

CREATE TABLE IF NOT EXISTS pinned_messages (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  pinned_by_id INTEGER NOT NULL,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id),
  FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, message_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_reactions (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id, actor_id, emoji),
  FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, message_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS polls (
  poll_id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  is_anonymous INTEGER NOT NULL,
  allows_multiple_answers INTEGER NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 0,
  created_by_bot_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL,
  voter_id INTEGER NOT NULL,
  option_id INTEGER NOT NULL,
  PRIMARY KEY (poll_id, voter_id, option_id),
  FOREIGN KEY (poll_id) REFERENCES polls(poll_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS callback_queries (
  callback_id TEXT PRIMARY KEY,
  bot_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  from_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  answered_at INTEGER,
  answer_json TEXT
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
DELETE FROM callback_queries;
DELETE FROM media_files;
DELETE FROM poll_votes;
DELETE FROM polls;
DELETE FROM message_reactions;
DELETE FROM pinned_messages;
DELETE FROM read_cursors;
DELETE FROM message_hides;
DELETE FROM messages;
DELETE FROM forum_topics;
DELETE FROM chat_join_requests;
DELETE FROM chat_invite_links;
DELETE FROM chat_admin_log;
DELETE FROM chat_bans;
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
    ["messages", "reply_markup_json", "TEXT"],
    ["messages", "media_json", "TEXT"],
    ["media_files", "scope_id", "TEXT NOT NULL DEFAULT 'local'"],
    ["chats", "next_message_id", "INTEGER NOT NULL DEFAULT 1"],
    ["chats", "description", "TEXT"],
    ["chats", "photo_file_id", "TEXT"],
    ["chats", "permissions_json", "TEXT"],
    ["chats", "permissions_until", "INTEGER NOT NULL DEFAULT 0"],
    ["chats", "slow_mode_seconds", "INTEGER NOT NULL DEFAULT 0"],
    ["chats", "creator_id", "INTEGER"],
    ["chats", "next_admin_log_id", "INTEGER NOT NULL DEFAULT 1"],
    ["chats", "username", "TEXT"],
    ["chats", "is_forum", "INTEGER NOT NULL DEFAULT 0"],
    ["chats", "is_public", "INTEGER NOT NULL DEFAULT 0"],
    ["chats", "next_invite_id", "INTEGER NOT NULL DEFAULT 1"],
    ["chats", "next_topic_id", "INTEGER NOT NULL DEFAULT 1"],
    ["messages", "message_thread_id", "INTEGER"],
    ["chat_members", "status", "TEXT NOT NULL DEFAULT 'member'"],
    ["chat_members", "admin_rights_json", "TEXT"],
    ["chat_members", "restrictions_json", "TEXT"],
    ["chat_members", "until_date", "INTEGER NOT NULL DEFAULT 0"],
    ["chat_members", "custom_title", "TEXT"],
    ["chat_members", "is_anonymous", "INTEGER NOT NULL DEFAULT 0"],
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
  db.exec(`
    UPDATE chats SET creator_id = (
      SELECT m.user_id FROM chat_members m
      WHERE m.chat_id = chats.id AND m.status = 'creator'
      LIMIT 1
    )
    WHERE creator_id IS NULL AND type != 'private';
    UPDATE chats SET creator_id = (
      SELECT m.user_id FROM chat_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.chat_id = chats.id
      ORDER BY m.rowid
      LIMIT 1
    )
    WHERE creator_id IS NULL AND type != 'private';
    UPDATE chats SET creator_id = (
      SELECT m.user_id FROM chat_members m
      WHERE m.chat_id = chats.id
      ORDER BY m.rowid
      LIMIT 1
    )
    WHERE creator_id IS NULL AND type != 'private';
    UPDATE chat_members SET status = 'creator'
    WHERE status != 'creator'
      AND user_id = (SELECT creator_id FROM chats WHERE id = chat_members.chat_id)
      AND EXISTS (
        SELECT 1 FROM chats
        WHERE id = chat_members.chat_id AND type != 'private' AND creator_id IS NOT NULL
      );
  `);
}

export function resetDatabase(db: TelegramTwinDatabase): void {
  db.exec(RESET_SQL);
}
