// SPDX-License-Identifier: Apache-2.0
import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTelegramTwinApp } from "../src/twin.js";
import { openTelegramTwinDatabase } from "../src/db.js";
import { TelegramDomain } from "../src/domain.js";
import { defaultSeedState, parseSeed, SYNTHETIC_BOT_TOKEN } from "../src/seed.js";

const secret = "test-secret-32-chars-minimum-length";
const sid = "test-session";
const previous = process.env.TWIN_AUTH_SECRET;

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = secret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previous;
});

async function userToken(login = "alice") {
  return sign({ sid, team_id: "tg", login, exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
}

function fresh() {
  const db = openTelegramTwinDatabase(":memory:");
  const domain = new TelegramDomain(db);
  domain.seed(defaultSeedState());
  const app = createTelegramTwinApp({ db, runId: "test", seed: defaultSeedState() });
  return { db, domain, app };
}

async function bot(app: ReturnType<typeof createTelegramTwinApp>, method: string, body: Record<string, unknown>) {
  const response = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { ok: boolean; result: unknown } };
}

describe("seed", () => {
  it("rejects an empty seed", () => {
    expect(() => parseSeed({})).toThrow();
  });

  it("accepts the default world", () => {
    expect(parseSeed(defaultSeedState()).users).toHaveLength(2);
  });

  it("leaves existing rows when the domain is opened without a seed", () => {
    const db = openTelegramTwinDatabase(":memory:");
    const first = new TelegramDomain(db);
    first.seed(defaultSeedState());
    first.sendMessage({ kind: "bot", botId: 1100001 }, { chat_id: 2001, text: "keep" });
    const second = new TelegramDomain(db);
    expect(second.getHistory("alice", 2001).some((row) => row.text === "keep")).toBe(true);
  });

  it("rolls back a failed seed", () => {
    const db = openTelegramTwinDatabase(":memory:");
    const domain = new TelegramDomain(db);
    domain.seed(defaultSeedState());
    const broken = defaultSeedState();
    broken.chats[0]!.members = [2001, 2001];
    expect(() => domain.seed(broken)).toThrow();
    expect(domain.getMe({ kind: "bot", botId: 1100001 }).username).toBe("x_bot");
  });
});

describe("HTTP path token", () => {
  it("getMe with a seeded token", async () => {
    const { app } = fresh();
    const res = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/getMe`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { username: string; is_bot: boolean } };
    expect(body.ok).toBe(true);
    expect(body.result.username).toBe("x_bot");
    expect(body.result.is_bot).toBe(true);
  });

  it("getMe on a session-prefixed path with no bearer", async () => {
    const { app } = fresh();
    const res = await app.request(`/s/${sid}/bot${SYNTHETIC_BOT_TOKEN}/getMe`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { is_bot: boolean } }).result.is_bot).toBe(true);
  });

  it("getMe with a JWT and a valid path token is still the bot", async () => {
    const { app } = fresh();
    const token = await userToken("alice");
    const res = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/getMe`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { is_bot: boolean; username: string } }).result.username).toBe("x_bot");
  });

  it("rejects an unknown token", async () => {
    const { app } = fresh();
    const res = await app.request("/bot999999:AAAAAAAAAAAAAAAAAAAA/getMe");
    expect(res.status).toBe(401);
  });

  it("rejects a valid JWT plus a wrong path token", async () => {
    const { app } = fresh();
    const token = await userToken();
    const res = await app.request("/bot999999:AAAAAAAAAAAAAAAAAAAA/getMe", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("sendMessage then getChat", async () => {
    const { app } = fresh();
    const sent = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: 2001, text: "hello from X" }),
    });
    expect(sent.status).toBe(200);
    const payload = (await sent.json()) as { ok: boolean; result: { text: string; message_id: number } };
    expect(payload.result.text).toBe("hello from X");

    const chat = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/getChat?chat_id=2001`);
    expect(chat.status).toBe(200);
    expect(((await chat.json()) as { result: { id: number } }).result.id).toBe(2001);
  });

  it("wrong chat id fails", async () => {
    const { app } = fresh();
    const res = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/getChat?chat_id=999`);
    expect(res.status).toBe(400);
  });

  it("rejects empty text and a missing reply", async () => {
    const { app } = fresh();
    const empty = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: 2001, text: "" }),
    });
    expect(empty.status).toBe(400);
    const missing = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: 2001, text: "hi", reply_to_message_id: 99 }),
    });
    expect(missing.status).toBe(400);
  });

  it("round-trips unicode on the seeded group", async () => {
    const { app } = fresh();
    const sent = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: -1001234567890, text: "café 你好" }),
    });
    expect(sent.status).toBe(200);
    expect(JSON.stringify(await sent.json())).toContain("café 你好");
  });

  it("keeps edit, delete, batch delete, forward, and copy on the Bot API HTTP surface", async () => {
    const { app, domain } = fresh();
    const source = await bot(app, "sendMessage", { chat_id: 2001, text: "source" });
    expect(source.status).toBe(200);
    const edited = await bot(app, "editMessageText", { chat_id: 2001, message_id: 1, text: "edited" });
    expect(edited).toMatchObject({ status: 200, body: { ok: true, result: { text: "edited" } } });

    const forwarded = await bot(app, "forwardMessage", {
      chat_id: -1001234567890,
      from_chat_id: 2001,
      message_id: 1,
    });
    expect(forwarded).toMatchObject({ status: 200, body: { result: { text: "edited", forward_from: {} } } });
    const copied = await bot(app, "copyMessage", {
      chat_id: -1001234567890,
      from_chat_id: 2001,
      message_id: 1,
    });
    expect(copied.status).toBe(200);
    expect(JSON.stringify(copied.body)).not.toContain("forward_from");

    await bot(app, "sendMessage", { chat_id: -1001234567890, text: "delete one" });
    const deleted = await bot(app, "deleteMessage", { chat_id: -1001234567890, message_id: 3 });
    expect(deleted).toMatchObject({ status: 200, body: { ok: true, result: true } });
    await bot(app, "sendMessage", { chat_id: -1001234567890, text: "delete two" });
    await bot(app, "sendMessage", { chat_id: -1001234567890, text: "delete three" });
    const batch = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/deleteMessages`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chat_id: "-1001234567890", message_ids: "[4,5]" }),
    });
    expect(batch.status).toBe(200);
    expect(await batch.json()).toEqual({ ok: true, result: true });
    expect(domain.getHistory("alice", -1001234567890).map((message) => message.text)).toEqual(["edited", "edited"]);
  });
});

describe("no telegram egress", () => {
  it("does not call fetch during a send", async () => {
    const { domain } = fresh();
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("network");
    };
    try {
      domain.sendMessage({ kind: "bot", botId: 1100001 }, { chat_id: 2001, text: "local" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
