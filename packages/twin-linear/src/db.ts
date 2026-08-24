// SPDX-License-Identifier: Apache-2.0
import { openTwinDatabase } from "@pome-sh/sdk";
import type { LinearTwinDatabase } from "./types.js";

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS linear_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url_key TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  admin INTEGER NOT NULL DEFAULT 0,
  app INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL,
  issue_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_states (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_labels (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  number INTEGER NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  number INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  estimate INTEGER,
  state_id TEXT NOT NULL,
  assignee_id TEXT,
  creator_id TEXT,
  delegate_id TEXT,
  project_id TEXT,
  cycle_id TEXT,
  parent_id TEXT,
  url TEXT NOT NULL,
  archived_at TEXT,
  canceled_at TEXT,
  completed_at TEXT,
  started_at TEXT,
  due_date TEXT,
  create_as_user TEXT,
  display_icon_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (state_id) REFERENCES workflow_states(id),
  FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (delegate_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_id) REFERENCES issues(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS issue_label_links (
  issue_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (issue_id, label_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (label_id) REFERENCES issue_labels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_relations (
  issue_id TEXT NOT NULL,
  related_issue_id TEXT NOT NULL,
  type TEXT NOT NULL,
  PRIMARY KEY (issue_id, related_issue_id, type),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (related_issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  parent_id TEXT,
  user_id TEXT,
  body TEXT NOT NULL,
  create_as_user TEXT,
  display_icon_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT,
  slug TEXT NOT NULL,
  project_id TEXT,
  team_id TEXT,
  issue_id TEXT,
  cycle_id TEXT,
  icon TEXT,
  color TEXT,
  creator_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE SET NULL,
  FOREIGN KEY (cycle_id) REFERENCES cycles(id) ON DELETE SET NULL,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS oauth_apps (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT NOT NULL,
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  assignable INTEGER NOT NULL DEFAULT 0,
  mentionable INTEGER NOT NULL DEFAULT 0,
  app_user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (app_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  user_id TEXT,
  app_id TEXT,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  refresh_token TEXT,
  sid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (app_id) REFERENCES oauth_apps(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  resource_types_json TEXT NOT NULL,
  team_id TEXT,
  all_public_teams INTEGER NOT NULL DEFAULT 0,
  secret TEXT,
  creator_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  action TEXT NOT NULL,
  url TEXT NOT NULL,
  status INTEGER,
  error TEXT,
  payload_json TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  issue_id TEXT,
  comment_id TEXT,
  app_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  plan TEXT,
  external_urls_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (app_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_activities (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  content_json TEXT NOT NULL DEFAULT '{}',
  signal TEXT,
  ephemeral INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS oauth_pending_codes (
  code TEXT PRIMARY KEY,
  app_id TEXT,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  user_id TEXT,
  actor TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_key ON teams(key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier);
CREATE INDEX IF NOT EXISTS idx_issues_team_number ON issues(team_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_token ON tokens(token);
CREATE INDEX IF NOT EXISTS idx_workflow_states_team_name ON workflow_states(team_id, name);
CREATE INDEX IF NOT EXISTS idx_comments_issue_id ON comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_documents_slug ON documents(slug);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activities_created ON agent_activities(created_at DESC);
`;

const RESET_SQL = `
DELETE FROM oauth_pending_codes;
DELETE FROM agent_activities;
DELETE FROM agent_sessions;
DELETE FROM webhook_deliveries;
DELETE FROM webhooks;
DELETE FROM tokens;
DELETE FROM oauth_apps;
DELETE FROM documents;
DELETE FROM comments;
DELETE FROM issue_relations;
DELETE FROM issue_label_links;
DELETE FROM issues;
DELETE FROM cycles;
DELETE FROM projects;
DELETE FROM issue_labels;
DELETE FROM workflow_states;
DELETE FROM teams;
DELETE FROM users;
DELETE FROM organizations;
DELETE FROM linear_config;
`;

export function openLinearTwinDatabase(
  path = process.env.LINEAR_TWIN_DB ?? ":memory:"
): LinearTwinDatabase {
  return openTwinDatabase(path, { migrate });
}

/**
 * Legacy agent session states that Linear does not have, and the Linear
 * member each one becomes. Linear has no cancellation state; `stale` ("no
 * longer progressing") is its closest neighbour.
 */
export const RETIRED_AGENT_SESSION_STATUSES: ReadonlyArray<readonly [string, string]> = [
  ["completed", "complete"],
  ["failed", "error"],
  ["canceled", "stale"],
];

export function migrate(db: LinearTwinDatabase): void {
  db.exec(MIGRATION_SQL);
  ensureColumn(db, "issues", "estimate", "INTEGER");
  ensureColumn(db, "issues", "parent_id", "TEXT");
  ensureColumn(db, "comments", "parent_id", "TEXT");
  migrateAgentSessions(db);
  migrateAgentActivities(db);
}

/**
 * Carry a pre-`content` `agent_activities` table forward.
 *
 * Same reasoning as `migrateAgentSessions` below: `CREATE TABLE IF NOT EXISTS`
 * leaves an existing file on its old columns, and dropping `type` / `body`
 * without carrying them over would answer `{}` for every activity ever
 * recorded.
 *
 * The carry is literal — an old row that said `type=thought, body=X` becomes
 * `{"type":"thought","body":"X"}`, which is exactly what it meant. That is a
 * valid `AgentActivityContent` for five of the six types. It is NOT one for
 * `action`, whose upstream member carries `action` / `parameter` and no `body`
 * at all — but the honest carry of a legacy row is what it said, and inventing
 * an `action` / `parameter` split out of one free-text field would be worse.
 * Nothing re-validates content on read, and no writer produces that shape
 * again.
 */
function migrateAgentActivities(db: LinearTwinDatabase): void {
  const columns = (db.prepare("PRAGMA table_info(agent_activities)").all() as Array<{ name: string }>).map(
    (column) => column.name
  );
  if (!columns.includes("content_json")) {
    db.exec("ALTER TABLE agent_activities ADD COLUMN content_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns.includes("signal")) db.exec("ALTER TABLE agent_activities ADD COLUMN signal TEXT");
  if (columns.includes("type") && columns.includes("body")) {
    db.exec(
      `UPDATE agent_activities
          SET content_json = json_object('type', type, 'body', body)
        WHERE content_json = '{}'`
    );
  }
  if (columns.includes("type")) db.exec("ALTER TABLE agent_activities DROP COLUMN type");
  if (columns.includes("body")) db.exec("ALTER TABLE agent_activities DROP COLUMN body");
  // Linear declares `AgentActivity.user: User!`. A row whose author was cleared
  // by the `ON DELETE SET NULL` foreign key adopts its session's app user
  // rather than reaching `readActivityUserId` and failing the whole read.
  db.exec(
    `UPDATE agent_activities
        SET user_id = (SELECT app_user_id FROM agent_sessions WHERE agent_sessions.id = session_id)
      WHERE user_id IS NULL`
  );
}

/**
 * Carry a pre-rename `agent_sessions` table forward.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
 * table, so without this an existing `LINEAR_TWIN_DB` file opens clean on the
 * OLD columns and then dies later with `"undefined" is not valid JSON` from
 * `mapAgentSession`, nowhere near the cause. Reopening old files is supported
 * (see the `ensureColumn` calls above); cloud's per-session databases are
 * ephemeral, but local and self-host files are not.
 *
 * Every step is guarded on the current column set, so this is idempotent and a
 * no-op on a database created by the current schema.
 */
function migrateAgentSessions(db: LinearTwinDatabase): void {
  const columnNames = (): string[] =>
    (db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map(
      (column) => column.name
    );

  let columns = columnNames();
  if (columns.includes("agent_user_id") && !columns.includes("app_user_id")) {
    db.exec("ALTER TABLE agent_sessions RENAME COLUMN agent_user_id TO app_user_id");
  }
  if (columns.includes("state") && !columns.includes("status")) {
    db.exec("ALTER TABLE agent_sessions RENAME COLUMN state TO status");
  }

  columns = columnNames();
  if (!columns.includes("external_urls_json")) {
    db.exec("ALTER TABLE agent_sessions ADD COLUMN external_urls_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (columns.includes("external_url")) {
    // The single URL becomes a one-entry collection. Linear's label is
    // non-null and the old shape carried none, so it backfills as empty.
    db.exec(
      `UPDATE agent_sessions
          SET external_urls_json = json_array(json_object('url', external_url, 'label', ''))
        WHERE external_url IS NOT NULL AND external_url <> ''`
    );
    db.exec("ALTER TABLE agent_sessions DROP COLUMN external_url");
  }

  for (const [retired, replacement] of RETIRED_AGENT_SESSION_STATUSES) {
    db.prepare("UPDATE agent_sessions SET status = ? WHERE status = ?").run(replacement, retired);
  }
}

export function resetDatabase(db: LinearTwinDatabase): void {
  db.exec(RESET_SQL);
}

function ensureColumn(db: LinearTwinDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
