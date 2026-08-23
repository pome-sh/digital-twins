// SPDX-License-Identifier: Apache-2.0
// `agent_activities` stopped carrying `type` / `body` and started carrying Linear's
// `content`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LinearDomain, openLinearTwinDatabase } from "../src/index.js";
import { testSeed } from "./_helpers.js";

/** `agent_activities` exactly as twin-linear 0.3.5 declared it. */
const PRE_CONTENT_COLUMNS = [
  "id",
  "session_id",
  "user_id",
  "type",
  "body",
  "ephemeral",
  "created_at",
  "updated_at",
];

const temporaries: string[] = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function columnsOf(db: { prepare: (sql: string) => { all: () => unknown[] } }): string[] {
  return (db.prepare("PRAGMA table_info(agent_activities)").all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

/**
 * Write a database whose `agent_activities` table is in the pre-content shape,
 * carrying one row per activity type plus one whose author has been cleared.
 */
async function seedPreContentDatabase(): Promise<{ path: string; sessionId: string; appUserId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "twin-linear-activity-migration-"));
  temporaries.push(dir);
  const path = join(dir, "linear.db");

  const db = openLinearTwinDatabase(path);
  const commands = new LinearDomain(db);
  commands.seed(testSeed());
  const issue = commands.listIssues()[0]!;
  const session = await commands.createAgentSessionOnIssue({ issueId: issue.id });

  // Put the table back into the 0.3.5 shape, so what follows is the real old
  // schema and not an approximation of it.
  db.exec("ALTER TABLE agent_activities ADD COLUMN type TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE agent_activities ADD COLUMN body TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE agent_activities DROP COLUMN content_json");
  db.exec("ALTER TABLE agent_activities DROP COLUMN signal");
  expect(columnsOf(db).sort()).toEqual([...PRE_CONTENT_COLUMNS].sort());

  const insert = db.prepare(
    `INSERT INTO agent_activities(id, session_id, user_id, type, body, ephemeral, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const type of ["thought", "action", "response"]) {
    insert.run(
      `legacy_${type}`,
      session.id,
      session.appUserId,
      type,
      `an old ${type}`,
      0,
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z"
    );
  }
  // The one row the `ON DELETE SET NULL` foreign key can produce.
  insert.run(
    "legacy_orphan",
    session.id,
    null,
    "thought",
    "an old thought",
    0,
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z"
  );
  db.close();
  return { path, sessionId: session.id, appUserId: session.appUserId };
}

describe("a pre-content agent_activities table migrates on open", () => {
  it("swaps type/body for content_json and signal instead of opening clean", async () => {
    const { path } = await seedPreContentDatabase();

    const db = openLinearTwinDatabase(path);

    expect(columnsOf(db)).toEqual(expect.arrayContaining(["content_json", "signal"]));
    expect(columnsOf(db)).not.toContain("type");
    expect(columnsOf(db)).not.toContain("body");
    db.close();
  });

  it("carries what the old row said into content, verbatim", async () => {
    const { path, sessionId } = await seedPreContentDatabase();

    const db = openLinearTwinDatabase(path);
    const activities = new LinearDomain(db).listAgentActivities(sessionId);

    const byId = new Map(activities.map((activity) => [activity.id, activity.content]));
    expect(byId.get("legacy_thought")).toEqual({ type: "thought", body: "an old thought" });
    expect(byId.get("legacy_response")).toEqual({ type: "response", body: "an old response" });
    // `action` is the one member upstream carries no `body` on. The honest
    // carry of a legacy row is what it said, not an invented action/parameter
    // split — see `migrateAgentActivities`.
    expect(byId.get("legacy_action")).toEqual({ type: "action", body: "an old action" });
    expect(activities.every((activity) => activity.signal === null)).toBe(true);
    db.close();
  });

  it("gives a cleared author back its session's app user, since Linear's is non-null", async () => {
    const { path, sessionId, appUserId } = await seedPreContentDatabase();

    const db = openLinearTwinDatabase(path);
    const activities = new LinearDomain(db).listAgentActivities(sessionId);

    expect(activities.find((activity) => activity.id === "legacy_orphan")?.userId).toBe(appUserId);
    db.close();
  });

  it("is idempotent — reopening a migrated database changes nothing", async () => {
    const { path, sessionId } = await seedPreContentDatabase();

    const first = openLinearTwinDatabase(path);
    const before = new LinearDomain(first).listAgentActivities(sessionId);
    const columns = columnsOf(first);
    first.close();

    const second = openLinearTwinDatabase(path);
    expect(columnsOf(second)).toEqual(columns);
    expect(new LinearDomain(second).listAgentActivities(sessionId)).toEqual(before);
    second.close();
  });

  it("fails legibly if an activity somehow reaches the read boundary with no author", async () => {
    const { path, sessionId } = await seedPreContentDatabase();
    const db = openLinearTwinDatabase(path);
    db.prepare("UPDATE agent_activities SET user_id = NULL WHERE id = ?").run("legacy_thought");

    expect(() => new LinearDomain(db).listAgentActivities(sessionId)).toThrowError(
      /Agent activity "legacy_thought" has no user/
    );
    db.close();
  });
});
