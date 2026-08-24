// SPDX-License-Identifier: Apache-2.0
// The schema upgrade an EXISTING database file gets.

import { describe, expect, it } from "vitest";
import { migrate, openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain/index.js";
import type { GitHubCloneDatabase } from "../src/types.js";

const LEGACY_ISSUE_COMMENTS = `
DROP TABLE issue_comments;
CREATE TABLE issue_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  body TEXT NOT NULL,
  user_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, issue_number) REFERENCES issues(repo_id, number) ON UPDATE CASCADE ON DELETE CASCADE
);
`;

function foreignKeyTargets(db: GitHubCloneDatabase, table: string): string[] {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>;
  return rows.map((row) => row.table);
}

/** A db carrying the legacy `issue_comments` shape, with one comment in it. */
function legacyDatabase() {
  const db = openGitHubCloneDatabase(":memory:");
  const domain = new GitHubDomain(db);
  domain.seed();
  domain.addIssueComment({ owner: "acme", repo: "api", issue_number: 1, body: "from before the migration" });

  // Roll the table back to the old DDL, carrying the row across the way a real
  // older file would already hold it.
  const existing = db.prepare("SELECT * FROM issue_comments").all() as Array<Record<string, unknown>>;
  db.pragma("foreign_keys = OFF");
  db.exec(LEGACY_ISSUE_COMMENTS);
  for (const row of existing) {
    db.prepare(
      "INSERT INTO issue_comments (id, repo_id, issue_number, body, user_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(row.id, row.repo_id, row.issue_number, row.body, row.user_login, row.created_at, row.updated_at);
  }
  db.pragma("foreign_keys = ON");
  return { db, domain };
}

describe("issue_comments migration", () => {
  it("starts from a db that really does carry the old constraint", () => {
    // Guards the fixture itself: if this assertion ever fails, the tests below
    // are proving nothing because they never had an old schema to upgrade.
    const { db } = legacyDatabase();
    expect(foreignKeyTargets(db, "issue_comments")).toContain("issues");
  });

  it("drops the issues FK, keeps a repositories FK, and preserves existing rows", () => {
    const { db } = legacyDatabase();
    migrate(db);

    const targets = foreignKeyTargets(db, "issue_comments");
    expect(targets).not.toContain("issues");
    expect(targets).toContain("repositories");
    expect(db.prepare("SELECT body FROM issue_comments").all()).toEqual([
      { body: "from before the migration" },
    ]);
  });

  it("lets a pull-request comment land once the migration has run", () => {
    const { db, domain } = legacyDatabase();
    domain.createBranch({ owner: "acme", repo: "api", branch: "migrated" });
    domain.pushFiles({
      owner: "acme",
      repo: "api",
      branch: "migrated",
      message: "Change",
      files: [{ path: "migrated.txt", content: "x\n" }],
    });
    const pr = domain.createPullRequest({ owner: "acme", repo: "api", title: "PR", head: "migrated", base: "main" }) as {
      number: number;
    };

    // Before: the constraint rejects it — this is the 404 the pr-summary examples hit.
    expect(() => domain.addIssueComment({ owner: "acme", repo: "api", issue_number: pr.number, body: "nope" })).toThrow();

    migrate(db);

    domain.addIssueComment({ owner: "acme", repo: "api", issue_number: pr.number, body: "Summary." });
    const repo = domain.exportState().repositories.find((item) => item.full_name === "acme/api");
    expect(repo?.pull_requests.find((item) => item.number === pr.number)?.comments).toEqual([
      expect.objectContaining({ body: "Summary." }),
    ]);
  });

  it("is idempotent — a second migrate leaves the shape and the rows alone", () => {
    const { db } = legacyDatabase();
    migrate(db);
    const afterFirst = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'issue_comments'").get();
    migrate(db);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'issue_comments'").get()).toEqual(afterFirst);
    expect(db.prepare("SELECT COUNT(*) AS count FROM issue_comments").get()).toEqual({ count: 1 });
  });

  it("does not put the issues FK back on a db already migrated", () => {
    // The regression this change could cause: `ensureIssueNumberCascade` rebuilds
    // `issue_assignees` / `issue_labels` when their cascade is missing, and it
    // used to rebuild `issue_comments` in the same pass. If it still did,
    // upgrading an old db would restore the constraint that has just been removed.
    const { db } = legacyDatabase();
    db.pragma("foreign_keys = OFF");
    db.exec(`
DROP TABLE issue_assignees;
CREATE TABLE issue_assignees (
  repo_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  login TEXT NOT NULL,
  PRIMARY KEY (repo_id, issue_number, login),
  FOREIGN KEY (repo_id, issue_number) REFERENCES issues(repo_id, number) ON DELETE CASCADE
);
`);
    db.pragma("foreign_keys = ON");

    migrate(db);

    // The cascade repair ran on its own table…
    const assignees = db.prepare("PRAGMA foreign_key_list(issue_assignees)").all() as Array<{
      table: string;
      on_update: string;
    }>;
    expect(assignees.find((row) => row.table === "issues")?.on_update).toBe("CASCADE");
    // …and left the comments table's new shape intact.
    expect(foreignKeyTargets(db, "issue_comments")).not.toContain("issues");
  });

  it("still cascades a repository delete to its comments", () => {
    // What the repo-level FK is replacing. Without it, dropping a repository
    // would orphan comments the issues FK used to take with it.
    const { db, domain } = legacyDatabase();
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM issue_comments").get()).toEqual({ count: 1 });

    const repo = domain.requireRepo("acme", "api");
    db.prepare("DELETE FROM repositories WHERE id = ?").run(repo.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM issue_comments").get()).toEqual({ count: 0 });
  });
});
