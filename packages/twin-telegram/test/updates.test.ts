// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { openTelegramTwinDatabase, type TelegramTwinDatabase } from "../src/db.js";
import { TelegramDomain } from "../src/domain.js";
import { defaultSeedState, SYNTHETIC_BOT_TOKEN } from "../src/seed.js";
import { createTelegramTwinApp } from "../src/twin.js";
import { UPDATE_RETENTION_SEC } from "../src/updates.js";

const BOT = { kind: "bot" as const, botId: 1100001 };

function fresh(now: () => number = () => 1_700_000_000) {
  const db = openTelegramTwinDatabase(":memory:");
  const domain = new TelegramDomain(db, now);
  domain.seed(defaultSeedState());
  return { db, domain };
}

function userMessage(domain: TelegramDomain, text: string) {
  return domain.sendMessage({ kind: "user", account: "alice" }, { chat_id: 2001, text });
}

function addDueOutboxRows(db: TelegramTwinDatabase, count: number, now: number): void {
  for (let updateId = 1; updateId <= count; updateId += 1) {
    db.prepare(
      "INSERT INTO bot_updates (bot_id, update_id, update_type, payload_json, created_at) VALUES (?, ?, 'message', ?, ?)",
    ).run(BOT.botId, updateId, JSON.stringify({ update_id: updateId, message: { text: `queued ${updateId}` } }), now);
    db.prepare(
      "INSERT INTO webhook_outbox (bot_id, update_id, attempts, next_attempt_at) VALUES (?, ?, 0, ?)",
    ).run(BOT.botId, updateId, now);
  }
}

function outboxRow(
  db: TelegramTwinDatabase,
  updateId: number,
): { attempts: number; next_attempt_at: number; locked_until: number } {
  return db
    .prepare("SELECT attempts, next_attempt_at, locked_until FROM webhook_outbox WHERE bot_id = ? AND update_id = ?")
    .get(BOT.botId, updateId) as { attempts: number; next_attempt_at: number; locked_until: number };
}

describe("Bot API update queue", () => {
  it("keeps updates until a positive offset acknowledges them and repeats before acknowledgement", () => {
    const { domain } = fresh();
    userMessage(domain, "one");
    userMessage(domain, "two");
    const first = domain.getUpdates(BOT, {});
    expect(first.map((update) => update.update_id)).toEqual([1, 2]);
    expect(domain.getUpdates(BOT, {})).toEqual(first);
    const afterAck = domain.getUpdates(BOT, { offset: 2 });
    expect(afterAck.map((update) => update.update_id)).toEqual([2]);
  });

  it("supports negative offsets by retaining only the selected tail", () => {
    const { domain } = fresh();
    userMessage(domain, "one");
    userMessage(domain, "two");
    userMessage(domain, "three");
    expect(domain.getUpdates(BOT, { offset: -2 }).map((update) => update.update_id)).toEqual([2, 3]);
    expect(domain.getUpdates(BOT, {}).map((update) => update.update_id)).toEqual([2, 3]);
  });

  it("honours limit when a negative offset requests the tail", () => {
    const { domain } = fresh();
    userMessage(domain, "one");
    userMessage(domain, "two");
    userMessage(domain, "three");
    expect(domain.getUpdates(BOT, { offset: -100, limit: 1 }).map((update) => update.update_id)).toEqual([3]);
    expect(domain.getUpdates(BOT, {}).map((update) => update.update_id)).toEqual([3]);
  });

  it("uses the configured allowed update types for later events", () => {
    const { domain } = fresh();
    domain.getUpdates(BOT, { allowed_updates: ["message"] });
    userMessage(domain, "accepted");
    expect(domain.getUpdates(BOT, {})).toHaveLength(1);
  });

  it("expires updates after 24 hours with the injected clock", () => {
    let now = 1_700_000_000;
    const { domain } = fresh(() => now);
    userMessage(domain, "old");
    now += UPDATE_RETENTION_SEC + 1;
    expect(domain.getUpdates(BOT, {})).toEqual([]);
  });

  it("rejects an invalid getUpdates limit and never grants a user bot authority", () => {
    const { domain } = fresh();
    expect(() => domain.getUpdates(BOT, { limit: 101 })).toThrow(/limit/);
    expect(() => domain.getUpdates({ kind: "user", account: "alice" }, {})).toThrow(/Unauthorized/);
  });

  it("allows one long poll per bot and releases it on cancellation", async () => {
    const { domain } = fresh();
    const abort = new AbortController();
    const first = domain.waitForUpdates(BOT, { timeout: 5 }, abort.signal);
    await Promise.resolve();
    await expect(domain.waitForUpdates(BOT, { timeout: 5 })).rejects.toThrow(/another getUpdates/);
    abort.abort();
    await expect(first).resolves.toEqual([]);
    await expect(domain.waitForUpdates(BOT, { timeout: 0 })).resolves.toEqual([]);
  });

  it("cancels a stale long poll and clears queue state on reset", async () => {
    const { domain } = fresh();
    userMessage(domain, "before reset");
    domain.getUpdates(BOT, { offset: 2 });
    const wait = domain.waitForUpdates(BOT, { timeout: 5 });
    await Promise.resolve();
    domain.seed(defaultSeedState());
    await expect(wait).resolves.toEqual([]);
    expect(domain.getUpdates(BOT, {})).toEqual([]);
  });
});

describe("Bot API webhook routes", () => {
  it("sets, reads, and deletes an explicit local fixture without recording its secret", async () => {
    const db = openTelegramTwinDatabase(":memory:");
    const recorder = createRecorderStore();
    const localUrl = "http://127.0.0.1:8811/telegram";
    const app = createTelegramTwinApp({
      db,
      recorder,
      seed: defaultSeedState(),
      webhookFixtures: { [localUrl]: async () => ({ status: 204 }) },
    });
    const set = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: localUrl, secret_token: "only_on_receiver" }),
    });
    expect(set.status).toBe(200);
    const info = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/getWebhookInfo`);
    expect(await info.json()).toMatchObject({ ok: true, result: { url: localUrl, pending_update_count: 0 } });
    const removed = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/deleteWebhook`, { method: "POST" });
    expect(removed.status).toBe(200);
    expect(JSON.stringify(recorder.events())).not.toContain("only_on_receiver");
  });

  it("does not dispatch a configured public URL fixture and retains its update", async () => {
    const db = openTelegramTwinDatabase(":memory:");
    const publicUrl = "https://receiver.example/telegram";
    let invoked = false;
    createTelegramTwinApp({
      db,
      seed: defaultSeedState(),
      webhookFixtures: {
        [publicUrl]: async () => {
          invoked = true;
          return { status: 200 };
        },
      },
    });
    const domain = new TelegramDomain(db);
    domain.setWebhook(BOT, { url: publicUrl });
    userMessage(domain, "must remain queued");
    await domain.flushWebhookOutbox();
    expect(invoked).toBe(false);
    expect(domain.getWebhookInfo(BOT)).toMatchObject({ pending_update_count: 1, last_error_message: "http_503" });
    domain.deleteWebhook(BOT, {});
    expect(domain.getUpdates(BOT, {})).toHaveLength(1);
  });

  it("serves queued updates through the Bot API route", async () => {
    const db = openTelegramTwinDatabase(":memory:");
    const app = createTelegramTwinApp({ db, seed: defaultSeedState() });
    const domain = new TelegramDomain(db);
    userMessage(domain, "HTTP update");
    const response = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/getUpdates?timeout=0`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: [{ update_id: 1, message: { text: "HTTP update" } }] });
  });

  it("accepts JSON-serialized allowed_updates in Bot API form bodies", async () => {
    const db = openTelegramTwinDatabase(":memory:");
    const localUrl = "http://127.0.0.1:8826/form";
    const app = createTelegramTwinApp({
      db,
      seed: defaultSeedState(),
      webhookFixtures: { [localUrl]: async () => ({ status: 204 }) },
    });
    const getUpdates = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ allowed_updates: '["message"]' }).toString(),
    });
    expect(getUpdates.status).toBe(200);
    const setWebhook = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: localUrl, allowed_updates: '["message"]' }).toString(),
    });
    expect(setWebhook.status).toBe(200);
    const invalid = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: localUrl, allowed_updates: "not-json" }).toString(),
    });
    expect(invalid.status).toBe(400);
  });

  it("returns Telegram validation errors for invalid webhook inputs", async () => {    const db = openTelegramTwinDatabase(":memory:");
    const app = createTelegramTwinApp({ db, seed: defaultSeedState() });
    const invalid = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:88/hook" }),
    });
    expect(invalid.status).toBe(400);
    const unauthorized = await app.request("/bot999999:AAAAAAAAAAAAAAAAAAAA/setWebhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://receiver.invalid/hook" }),
    });
    expect(unauthorized.status).toBe(401);
  });
});

describe("controlled webhook outbox", () => {
  it("delivers to an injected receiver with the configured secret and removes only acknowledged updates", async () => {
    const { domain } = fresh();
    domain.setWebhook(BOT, { url: "https://receiver.invalid/telegram", secret_token: "signed_secret" });
    userMessage(domain, "deliver me");
    await domain.flushWebhookOutbox(async (input) => {
      expect(input.headers["x-telegram-bot-api-secret-token"]).toBe("signed_secret");
      expect(input.body.update_id).toBe(1);
      return { status: 204 };
    });
    expect(domain.getWebhookInfo(BOT).pending_update_count).toBe(0);
    domain.deleteWebhook(BOT, {});
    expect(domain.getUpdates(BOT, {})).toEqual([]);
  });

  it("drains a bounded batch and then schedules remaining durable outbox rows", async () => {
    const db = openTelegramTwinDatabase(":memory:");
    const localUrl = "http://127.0.0.1:8822/telegram";
    const delivered: number[] = [];
    const app = createTelegramTwinApp({
      db,
      seed: defaultSeedState(),
      webhookFixtures: {
        [localUrl]: async (input) => {
          delivered.push(input.body.update_id as number);
          return { status: 200 };
        },
      },
    });
    await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: localUrl, max_connections: 1 }),
    });
    const domain = new TelegramDomain(db);
    for (let index = 0; index < 10; index += 1) userMessage(domain, `queued ${index}`);
    for (let tick = 0; tick < 20 && delivered.length < 10; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(domain.getWebhookInfo(BOT).pending_update_count).toBe(0);
  });

  it("retries a failed local fixture without a second flush or notify", async () => {
    const db = openTelegramTwinDatabase(":memory:");
    const localUrl = "http://127.0.0.1:8823/retry";
    let attempts = 0;
    const app = createTelegramTwinApp({
      db,
      seed: defaultSeedState(),
      webhookFixtures: {
        [localUrl]: async () => {
          attempts += 1;
          return { status: attempts === 1 ? 503 : 204 };
        },
      },
    });
    await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: localUrl }),
    });
    const domain = new TelegramDomain(db);
    userMessage(domain, "retry automatically");
    const deadline = Date.now() + 2_500;
    while (attempts < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(attempts).toBe(2);
    expect(domain.getWebhookInfo(BOT).pending_update_count).toBe(0);
  });

  it("resumes a persisted outbox after a file-backed restart without a new notify", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pome-telegram-restart-"));
    const path = join(directory, "telegram.db");
    const localUrl = "http://127.0.0.1:8827/restart";
    const now = Math.floor(Date.now() / 1000);
    let firstDb: TelegramTwinDatabase | undefined;
    let restartedDb: TelegramTwinDatabase | undefined;
    try {
      firstDb = openTelegramTwinDatabase(path);
      const first = new TelegramDomain(firstDb, () => now, new Set([localUrl]), false);
      first.seed(defaultSeedState());
      first.setWebhook(BOT, { url: localUrl });
      addDueOutboxRows(firstDb, 1, now);
      firstDb.close();
      firstDb = undefined;

      restartedDb = openTelegramTwinDatabase(path);
      let deliveries = 0;
      createTelegramTwinApp({
        db: restartedDb,
        webhookFixtures: {
          [localUrl]: async () => {
            deliveries += 1;
            return { status: 204 };
          },
        },
      });
      const restarted = new TelegramDomain(restartedDb);
      const deadline = Date.now() + 500;
      while (deliveries < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(deliveries).toBe(1);
      expect(restarted.getWebhookInfo(BOT).pending_update_count).toBe(0);
    } finally {
      firstDb?.close();
      restartedDb?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not let a deleted webhook receiver acknowledge a preserved update", async () => {
    const db = openTelegramTwinDatabase(":memory:");
    const localUrl = "http://127.0.0.1:8828/delete";
    let resolveDelivery: ((result: { status: number }) => void) | undefined;
    let started: (() => void) | undefined;
    const startedDelivery = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = createTelegramTwinApp({
      db,
      seed: defaultSeedState(),
      webhookFixtures: {
        [localUrl]: async () => {
          started!();
          return new Promise((resolve) => {
            resolveDelivery = resolve;
          });
        },
      },
    });
    await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: localUrl }),
    });
    const domain = new TelegramDomain(db);
    userMessage(domain, "preserve while deleting");
    await startedDelivery;
    domain.deleteWebhook(BOT, {});
    resolveDelivery!({ status: 204 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(domain.getUpdates(BOT, {})).toHaveLength(1);
  });

  it("keeps the configured injected clock after auth lookup domains and does not wall-time retry while frozen", async () => {
    const now = 1_700_000_000;
    const db = openTelegramTwinDatabase(":memory:");
    const localUrl = "http://127.0.0.1:8824/frozen-clock";
    let attempts = 0;
    const app = createTelegramTwinApp({
      db,
      now: () => now,
      seed: defaultSeedState(),
      webhookFixtures: {
        [localUrl]: async () => {
          attempts += 1;
          return { status: 503 };
        },
      },
    });
    await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: localUrl }),
    });
    // Auth above and this helper domain must not replace the configured clock.
    const domain = new TelegramDomain(db, () => now, new Set(), false);
    userMessage(domain, "frozen clock");
    const firstDeadline = Date.now() + 500;
    while (attempts < 1 && Date.now() < firstDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(attempts).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(attempts).toBe(1);
  });

  it("does not let a pre-reset receiver acknowledge a reused update id", async () => {
    const db = openTelegramTwinDatabase(":memory:");
    const localUrl = "http://127.0.0.1:8825/reset";
    let calls = 0;
    let resolveFirst: ((result: { status: number }) => void) | undefined;
    let resolveSecond: ((result: { status: number }) => void) | undefined;
    let firstStarted: (() => void) | undefined;
    let secondStarted: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const second = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const app = createTelegramTwinApp({
      db,
      seed: defaultSeedState(),
      webhookFixtures: {
        [localUrl]: async () => {
          calls += 1;
          if (calls === 1) {
            firstStarted!();
            return new Promise((resolve) => {
              resolveFirst = resolve;
            });
          }
          secondStarted!();
          return new Promise((resolve) => {
            resolveSecond = resolve;
          });
        },
      },
    });
    await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: localUrl }),
    });
    const domain = new TelegramDomain(db);
    userMessage(domain, "before reset");
    await first;
    domain.seed(defaultSeedState());
    await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: localUrl }),
    });
    userMessage(domain, "after reset");
    resolveFirst!({ status: 204 });
    await second;
    expect(domain.getWebhookInfo(BOT).pending_update_count).toBe(1);
    resolveSecond!({ status: 204 });
    const deadline = Date.now() + 500;
    while (domain.getWebhookInfo(BOT).pending_update_count !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(domain.getWebhookInfo(BOT).pending_update_count).toBe(0);
  });

  it("handles no more than eight due rows in one direct outbox flush", async () => {
    const now = 1_700_000_000;
    const { db, domain } = fresh(() => now);
    domain.setWebhook(BOT, { url: "https://receiver.invalid/telegram" });
    addDueOutboxRows(db, 10, now);
    let deliveries = 0;
    const processed = await domain.flushWebhookOutbox(async () => {
      deliveries += 1;
      return { status: 200 };
    });
    expect(processed.processed).toBe(8);
    expect(deliveries).toBe(8);
    expect((db.prepare("SELECT COUNT(*) AS count FROM webhook_outbox").get() as { count: number }).count).toBe(2);
  });

  it("uses injected-clock retry delays of 1, 2, 4, 8, 16, then capped 32 seconds", async () => {
    let now = 1_700_000_000;
    const { db, domain } = fresh(() => now);
    domain.setWebhook(BOT, { url: "https://receiver.invalid/telegram" });
    addDueOutboxRows(db, 1, now);
    for (const [attempt, delay] of [1, 2, 4, 8, 16, 32, 32].entries()) {
      expect((await domain.flushWebhookOutbox(async () => ({ status: 503 }))).processed).toBe(1);
      expect(outboxRow(db, 1)).toEqual({
        attempts: attempt + 1,
        next_attempt_at: now + delay,
        locked_until: 0,
      });
      now += delay;
    }
  });

  it("does not roll back a committed message when the webhook returns non-2xx", async () => {
    const { domain } = fresh();
    domain.setWebhook(BOT, { url: "https://receiver.invalid/telegram" });
    userMessage(domain, "durable message");
    await domain.flushWebhookOutbox(async () => ({ status: 503 }));
    expect(domain.getHistory("alice", 2001).map((message) => message.text)).toContain("durable message");
    expect(domain.getWebhookInfo(BOT)).toMatchObject({ pending_update_count: 1, last_error_message: "http_503" });
  });

  it("returns to polling after deleteWebhook and honours drop_pending_updates", () => {
    const { domain } = fresh();
    domain.setWebhook(BOT, { url: "https://receiver.invalid/telegram" });
    userMessage(domain, "keep while disabled");
    expect(() => domain.getUpdates(BOT, {})).toThrow(/webhook is active/);
    domain.deleteWebhook(BOT, {});
    expect(domain.getUpdates(BOT, {})).toHaveLength(1);
    domain.setWebhook(BOT, { url: "https://receiver.invalid/telegram" });
    userMessage(domain, "drop me");
    domain.deleteWebhook(BOT, { drop_pending_updates: true });
    expect(domain.getUpdates(BOT, {})).toEqual([]);
  });

  it("rejects a private webhook target unless it is an explicit local fixture", () => {
    const { domain } = fresh();
    expect(() => domain.setWebhook(BOT, { url: "http://127.0.0.1:8080/hook" })).toThrow(/explicit local fixture/);
    expect(() => domain.setWebhook(BOT, { url: "http://192.168.1.2/hook" })).toThrow(/private webhook/);
  });
});
