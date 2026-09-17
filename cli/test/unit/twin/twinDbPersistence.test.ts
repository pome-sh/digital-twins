// SPDX-License-Identifier: Apache-2.0
//
// A twin booted against a db path keeps its rows across a restart — for all
// five twins (F-1758).
//
// This test was unwritable before: four of the five registry entries passed
// the literal ":memory:" into `boot`, so no file was ever created and
// `SLACK_CLONE_DB` / `STRIPE_CLONE_DB` / `GMAIL_TWIN_DB` / `LINEAR_TWIN_DB`
// meant nothing on the CLI's path. So the proof is the file itself: boot
// against a path, assert the twin's rows are IN it, boot again with the seed
// suppressed, and assert the same world comes back out. Under `noSeed`
// nothing is applied at boot, so every row the second boot serves came off
// the disk.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TWIN_NAME_LIST, TWIN_REGISTRY } from "../../../src/twin/registry.js";
import { bootTwin, STRIPE_LOCAL_ACCOUNT_ID, type TwinHarness } from "../../../src/twin/twinHarness.js";

const RUN_ID = "cli-twin-db-test";

/** Rows across every persisted table, the way the sandbox-domains reset suite
 *  counts them — a per-twin table name would only be a list to forget. */
function persistedRows(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    return tables.reduce((sum, table) => {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as { n: number };
      return sum + Number(row.n);
    }, 0);
  } finally {
    db.close();
  }
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pome-twin-db-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bootTwin dbPath", () => {
  it.each([...TWIN_NAME_LIST])("%s writes its seed to the db path it was given", async (twin) => {
    const file = join(dir, `${twin}.db`);
    const seedState = await TWIN_REGISTRY[twin].defaultSeed();

    const first = await bootTwin({ twin, runId: RUN_ID, seedState, dbPath: file });
    const seeded = await first.exportState();
    await first.close();

    expect(existsSync(file), `${twin}: nothing was written to the db path`).toBe(true);
    expect(persistedRows(file), `${twin}: the db file holds no rows`).toBeGreaterThan(0);

    const second = await bootTwin({ twin, runId: RUN_ID, seedState, dbPath: file, noSeed: true });
    const reopened = await second.exportState();
    await second.close();

    expect(reopened, `${twin}: the restart did not serve the saved db`).toEqual(seeded);
  });

  it("stays in memory with no path given, even with the twin's *_DB in the env", async () => {
    // A graded `pome run --local` must not begin from — or write over — a file
    // the operator saved, so the ambient variable is not its business: the
    // path is an argument. github used to inherit `GITHUB_CLONE_DB` here,
    // because its entry called `openGitHubCloneDatabase()` with no argument.
    for (const twin of TWIN_NAME_LIST) {
      const { dbEnvName } = TWIN_REGISTRY[twin];
      const ambient = join(dir, `ambient-${twin}.db`);
      const before = process.env[dbEnvName];
      process.env[dbEnvName] = ambient;
      try {
        const seedState = await TWIN_REGISTRY[twin].defaultSeed();
        const harness = await bootTwin({ twin, runId: RUN_ID, seedState });
        await harness.close();
        expect(existsSync(ambient), `${twin} boot read ${dbEnvName}`).toBe(false);
      } finally {
        if (before === undefined) delete process.env[dbEnvName];
        else process.env[dbEnvName] = before;
      }
    }
  });
});

describe("bootTwin noSeed — a row an agent wrote survives the restart", () => {
  const apiKey = "sk_test_pome_default";
  const base = "http://twin.test/s/default";
  const seedState = {
    api_keys: [{ key: apiKey, sid: "default", account_id: STRIPE_LOCAL_ACCOUNT_ID }],
  };

  async function json(
    harness: TwinHarness,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await harness.app.fetch(new Request(`${base}${path}`, init));
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  it("serves a PaymentIntent created before the restart", async () => {
    const file = join(dir, "stripe-agent-write.db");
    const created = await bootTwin({ twin: "stripe", runId: RUN_ID, seedState, dbPath: file });
    const pi = await json(created, "POST", "/v1/payment_intents", {
      amount: 4_200,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: { crypto: { mode: "deposit", deposit_options: { networks: ["base"] } } },
    });
    expect(pi.status).toBe(200);
    const id = pi.body.id as string;
    await created.close();

    // The write, not just the seed, is what is on disk: the same seed with no
    // agent behind it leaves fewer rows in the file.
    const seedOnly = await bootTwin({
      twin: "stripe",
      runId: RUN_ID,
      seedState,
      dbPath: join(dir, "stripe-seed-only.db"),
    });
    await seedOnly.close();
    expect(persistedRows(file)).toBeGreaterThan(persistedRows(join(dir, "stripe-seed-only.db")));

    // The PaymentIntent AND the api key that authenticates the read both come
    // off the disk — this boot seeded nothing.
    const kept = await bootTwin({ twin: "stripe", runId: RUN_ID, seedState, dbPath: file, noSeed: true });
    expect((await json(kept, "GET", `/v1/payment_intents/${id}`)).status).toBe(200);
    await kept.close();

    // No re-seed leg here: stripe's `applySeed` inserts its rows rather than
    // clearing the tables first, unlike the other four twins' `seed()`, so a
    // seeded restart against a file layers onto what is there. That is its
    // behaviour on the container path too — which is the whole point of
    // F-1758, and not this command's to change.
  });
});
