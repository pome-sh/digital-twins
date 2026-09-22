// SPDX-License-Identifier: Apache-2.0
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

  it("returns Telegram validation errors for invalid webhook inputs", async () => {
    const db = openTelegramTwinDatabase(":memory:");
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
    expect(processed).toBe(8);
    expect(deliveries).toBe(8);
    expect((db.prepare("SELECT COUNT(*) AS count FROM webhook_outbox").get() as { count: number }).count).toBe(2);
  });

  it("uses injected-clock retry delays of 1, 2, 4, 8, 16, then capped 32 seconds", async () => {
    let now = 1_700_000_000;
    const { db, domain } = fresh(() => now);
    domain.setWebhook(BOT, { url: "https://receiver.invalid/telegram" });
    addDueOutboxRows(db, 1, now);
    for (const [attempt, delay] of [1, 2, 4, 8, 16, 32, 32].entries()) {
      expect(await domain.flushWebhookOutbox(async () => ({ status: 503 }))).toBe(1);
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
