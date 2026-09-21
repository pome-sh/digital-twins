// SPDX-License-Identifier: Apache-2.0
import { createRecorderStore } from "@pome-sh/sdk/server";
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
  const recorder = createRecorderStore();
  const app = createTelegramTwinApp({ db, recorder, runId: "test", seed: defaultSeedState() });
  return { db, domain, recorder, app };
}

async function mcp(app: ReturnType<typeof createTelegramTwinApp>, token: string, body: unknown) {
  const res = await app.request(`/s/${sid}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
    const body = (await res.json()) as { ok: boolean; result: { username: string } };
    expect(body.ok).toBe(true);
    expect(body.result.username).toBe("x_bot");
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
});

describe("loopback A → X → history", () => {
  it("user send, bot reply, user history", async () => {
    const { app, recorder } = fresh();
    const token = await userToken("alice");

    const sent = await mcp(app, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "send_message", arguments: { account: "alice", chat_id: 2001, text: "hi X" } },
    });
    expect(sent.status).toBe(200);

    const reply = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: 2001, text: "hi Alice", reply_to_message_id: 1 }),
    });
    expect(reply.status).toBe(200);

    const history = await mcp(app, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_history", arguments: { account: "alice", chat_id: 2001 } },
    });
    const text = JSON.stringify(history.body);
    expect(text).toContain("hi X");
    expect(text).toContain("hi Alice");

    const tape = JSON.stringify(recorder.events());
    expect(tape).not.toContain(SYNTHETIC_BOT_TOKEN);
  });

  it("unauthorized account fails", async () => {
    const { app } = fresh();
    const token = await userToken("alice");
    const asMallory = await mcp(app, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_chats", arguments: { account: "mallory" } },
    });
    expect(JSON.stringify(asMallory.body)).toContain("unauthorized account");
    const asBob = await mcp(app, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { account: "bob", chat_id: -1001234567890, text: "impersonate" },
      },
    });
    expect(JSON.stringify(asBob.body)).toContain("unauthorized account");
    const bob = await userToken("bob");
    const bobSend = await mcp(app, bob, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "send_message", arguments: { account: "bob", chat_id: -1001234567890, text: "from bob" } },
    });
    expect(JSON.stringify(bobSend.body)).toContain("from bob");
    expect(JSON.stringify(bobSend.body)).not.toContain("impersonate");
  });

  it("does not treat /s/botanic/mcp as a bot path token", async () => {
    const { app } = fresh();
    const token = await sign(
      { sid: "botanic", team_id: "tg", login: "alice", exp: Math.floor(Date.now() / 1000) + 3600 },
      secret,
    );
    const res = await app.request("/s/botanic/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
  });

});

describe("reset", () => {
  it("admin reset restores the seed", async () => {
    const { app } = fresh();
    await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: 2001, text: "ephemeral" }),
    });
    const reset = await app.request("/admin/reset", { method: "POST" });
    expect(reset.status).toBe(200);
    const token = await userToken("alice");
    const history = await mcp(app, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_history", arguments: { account: "alice", chat_id: 2001 } },
    });
    expect(JSON.stringify(history.body)).not.toContain("ephemeral");
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
