// SPDX-License-Identifier: Apache-2.0
//
// F-1172: `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already
// has the table, so a `LINEAR_TWIN_DB` file written before the AgentSession
// rename used to open CLEAN on the old columns and then die later, far from the
// cause, with `"undefined" is not valid JSON` out of `mapAgentSession`.
// Reopening old files is a supported path (see db.ts's `ensureColumn` calls);
// cloud's per-session databases are ephemeral, local and self-host files are
// not.
//
// This builds a genuinely pre-rename `agent_sessions` table — asserting its
// column set equals the frozen pre-rename list before going anywhere near the
// migration — and then reopens it with the shipping code.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinearDomain, openLinearTwinDatabase } from "../src/index.js";
import { RETIRED_AGENT_SESSION_STATUSES } from "../src/db.js";
import { testSeed } from "./_helpers.js";

/** `agent_sessions` exactly as twin-linear 0.2.0 declared it. */
const PRE_RENAME_COLUMNS = [
  "id",
  "issue_id",
  "comment_id",
  "agent_user_id",
  "state",
  "plan",
  "external_url",
  "created_at",
  "updated_at",
];

const temporaries: string[] = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function columnsOf(db: { prepare: (sql: string) => { all: () => unknown[] } }): string[] {
  return (db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

/**
 * Write a database whose `agent_sessions` table is in the pre-rename shape,
 * carrying one row per retired status plus a legacy `external_url`.
 */
function seedPreRenameDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "twin-linear-migration-"));
  temporaries.push(dir);
  const path = join(dir, "linear.db");

  const db = openLinearTwinDatabase(path);
  const commands = new LinearDomain(db);
  commands.seed(testSeed());
  const issue = commands.listIssues()[0]!;
  const appUser = commands.listUsers().find((user) => user.app) ?? commands.listUsers()[0]!;

  // Put the table back into the 0.2.0 shape, so what follows is the real old
  // schema and not an approximation of it.
  db.exec("ALTER TABLE agent_sessions RENAME COLUMN app_user_id TO agent_user_id");
  db.exec("ALTER TABLE agent_sessions RENAME COLUMN status TO state");
  db.exec("ALTER TABLE agent_sessions ADD COLUMN external_url TEXT");
  db.exec("ALTER TABLE agent_sessions DROP COLUMN external_urls_json");
  // Compared as a set: `ADD COLUMN` appends, so the rebuilt table's physical
  // ordinals differ from 0.2.0's while every column name matches. Nothing here
  // or in db.ts reads a column by position.
  expect(columnsOf(db).sort()).toEqual([...PRE_RENAME_COLUMNS].sort());

  const insert = db.prepare(
    `INSERT INTO agent_sessions(id, issue_id, comment_id, agent_user_id, state, plan, external_url, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const [index, [retired]] of RETIRED_AGENT_SESSION_STATUSES.entries()) {
    insert.run(
      `legacy_${retired}`,
      issue.id,
      null,
      appUser.id,
      retired,
      "OLD-PLAN",
      index === 0 ? "https://old.example/run" : null,
      "2026-07-21T00:00:00.000Z",
      "2026-07-21T00:00:00.000Z"
    );
  }
  db.close();
  return path;
}

describe("a pre-rename agent_sessions table migrates on open (F-1172)", () => {
  it("renames the columns instead of opening clean and crashing later", () => {
    const path = seedPreRenameDatabase();

    const db = openLinearTwinDatabase(path);

    expect(columnsOf(db)).toEqual(
      expect.arrayContaining(["app_user_id", "status", "external_urls_json"])
    );
    expect(columnsOf(db)).not.toContain("agent_user_id");
    expect(columnsOf(db)).not.toContain("state");
    expect(columnsOf(db)).not.toContain("external_url");
    db.close();
  });

  it("maps every retired status onto a Linear member, canceled included", () => {
    const path = seedPreRenameDatabase();

    const db = openLinearTwinDatabase(path);
    const sessions = new LinearDomain(db).listAgentSessions();

    const byId = new Map(sessions.map((session) => [session.id, session.status]));
    expect(byId.get("legacy_completed")).toBe("complete");
    expect(byId.get("legacy_failed")).toBe("error");
    // Linear has no cancellation state; `stale` is the closest neighbour.
    expect(byId.get("legacy_canceled")).toBe("stale");
    db.close();
  });

  it("carries the old single external_url into the externalUrls collection", () => {
    const path = seedPreRenameDatabase();

    const db = openLinearTwinDatabase(path);
    const sessions = new LinearDomain(db).listAgentSessions();

    expect(sessions.find((session) => session.id === "legacy_completed")?.externalUrls).toEqual([
      { url: "https://old.example/run", label: "" },
    ]);
    expect(sessions.find((session) => session.id === "legacy_failed")?.externalUrls).toEqual([]);
    db.close();
  });

  it("is idempotent — reopening a migrated database changes nothing", () => {
    const path = seedPreRenameDatabase();

    const first = openLinearTwinDatabase(path);
    const before = new LinearDomain(first).listAgentSessions();
    const columns = columnsOf(first);
    first.close();

    const second = openLinearTwinDatabase(path);
    expect(columnsOf(second)).toEqual(columns);
    expect(new LinearDomain(second).listAgentSessions()).toEqual(before);
    second.close();
  });

  it("fails legibly if an unmigratable status somehow reaches the read boundary", () => {
    const path = seedPreRenameDatabase();
    const db = openLinearTwinDatabase(path);
    db.prepare("UPDATE agent_sessions SET status = ? WHERE id = ?").run("wat", "legacy_failed");

    expect(() => new LinearDomain(db).listAgentSessions()).toThrowError(
      /Stored agent session status "wat" is not one of Linear's AgentSessionStatus members/
    );
    db.close();
  });
});

/**
 * F-1176: `agent_activities` used to store a flat `type` + `body` pair. Linear's
 * `AgentActivityCreateInput` takes a single `content` object, so the body moved
 * inside it — same no-op-CREATE-TABLE hazard as above, one table over.
 */
function seedPreContentDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "twin-linear-activity-migration-"));
  temporaries.push(dir);
  const path = join(dir, "linear.db");

  const db = openLinearTwinDatabase(path);
  const commands = new LinearDomain(db);
  commands.seed(testSeed());
  const issue = commands.listIssues()[0]!;
  const appUser = commands.listUsers().find((user) => user.app) ?? commands.listUsers()[0]!;

  db.prepare(
    `INSERT INTO agent_sessions(id, issue_id, comment_id, app_user_id, status, plan, external_urls_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
  ).run("legacy_session", issue.id, null, appUser.id, "active", null, "[]", "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z");

  // Put agent_activities back into the pre-content shape.
  db.exec("ALTER TABLE agent_activities ADD COLUMN body TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE agent_activities DROP COLUMN content_json");
  db.exec("ALTER TABLE agent_activities DROP COLUMN signal");
  const insert = db.prepare(
    `INSERT INTO agent_activities(id, session_id, user_id, type, body, ephemeral, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
  );
  insert.run("legacy_thought", "legacy_session", appUser.id, "thought", "thinking", 1, "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:00.000Z");
  insert.run("legacy_action", "legacy_session", appUser.id, "action", "search_issues", 1, "2026-08-02T00:00:01.000Z", "2026-08-02T00:00:01.000Z");
  db.close();
  return path;
}

describe("a pre-content agent_activities table migrates on open (F-1176)", () => {
  it("folds type + body into Linear's content object", () => {
    const path = seedPreContentDatabase();
    const activities = new LinearDomain(openLinearTwinDatabase(path)).listAgentActivities("legacy_session");

    expect(activities.map((activity) => activity.content)).toEqual([
      { type: "thought", body: "thinking" },
      // The old shape had nowhere to keep a parameter, so it backfills empty
      // rather than inventing one.
      { type: "action", action: "search_issues", parameter: "" },
    ]);
    expect(activities.every((activity) => activity.signal === null)).toBe(true);
  });

  it("is idempotent, and does not re-run on an already-migrated file", () => {
    const path = seedPreContentDatabase();
    const before = new LinearDomain(openLinearTwinDatabase(path)).listAgentActivities("legacy_session");
    expect(new LinearDomain(openLinearTwinDatabase(path)).listAgentActivities("legacy_session")).toEqual(
      before
    );
  });
});
