// SPDX-License-Identifier: Apache-2.0
//
// Reset SQL is a hand-maintained DELETE list. This test seeds each twin,
// asks sqlite_master which persisted tables actually exist, and asserts
// reset emptied every one — so a table the list forgot cannot ship green.
import { describe, expect, it } from "vitest";

import * as github from "../src/github.js";
import * as gmail from "../src/gmail.js";
import * as linear from "../src/linear.js";
import * as slack from "../src/slack.js";
import * as stripe from "../src/stripe.js";
import { SANDBOX_DOMAIN_NAMES, type SandboxDomainName } from "../src/index.js";

type Queryable = {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
};

function persistedTables(db: Queryable): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function tableRowCount(db: Queryable, table: string): number {
  const quoted = `"${table.replaceAll('"', '""')}"`;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as { n: number };
  return Number(row.n);
}

function totalPersistedRows(db: Queryable, tables: string[]): number {
  return tables.reduce((sum, table) => sum + tableRowCount(db, table), 0);
}

function assertResetClears(db: Queryable, reset: () => void, twin: string): void {
  try {
    const seededTables = persistedTables(db);
    expect(seededTables.length, `${twin}: seed created no tables`).toBeGreaterThan(0);
    expect(totalPersistedRows(db, seededTables), `${twin}: seed produced no rows`).toBeGreaterThan(0);
    reset();
    expect(persistedTables(db), `${twin}: reset changed the persisted table set`).toEqual(seededTables);
    expect(
      seededTables.filter((table) => tableRowCount(db, table) > 0),
      `${twin}: tables still populated after reset`,
    ).toEqual([]);
  } finally {
    db.close();
  }
}

const CASES: Record<SandboxDomainName, () => void> = {
  github() {
    const db = github.openGitHubCloneDatabase(":memory:");
    new github.GitHubDomain(db).seed(github.defaultSeedState());
    assertResetClears(db, () => github.resetDatabase(db), "github");
  },
  slack() {
    const db = slack.openSlackTwinDatabase(":memory:");
    new slack.SlackDomain(db).seed(slack.defaultSeedState());
    assertResetClears(db, () => slack.resetDatabase(db), "slack");
  },
  stripe() {
    const db = stripe.openTwinStripeDatabase(":memory:");
    new stripe.StripeDomain(db);
    stripe.applySeed(db, stripe.defaultSeed());
    assertResetClears(db, () => stripe.resetDatabase(db), "stripe");
  },
  gmail() {
    const db = gmail.openGmailTwinDatabase(":memory:");
    new gmail.GmailDomain(db).seed(gmail.defaultSeedState());
    assertResetClears(db, () => gmail.resetDatabase(db), "gmail");
  },
  linear() {
    const db = linear.openLinearTwinDatabase(":memory:");
    new linear.LinearDomain(db).seed(linear.defaultSeedState());
    assertResetClears(db, () => linear.resetDatabase(db), "linear");
  },
};

describe("reset clears every persisted table", () => {
  it.each(SANDBOX_DOMAIN_NAMES)("%s", (twin) => {
    CASES[twin]();
  });
});
