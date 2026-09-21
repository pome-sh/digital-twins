// SPDX-License-Identifier: Apache-2.0
import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOT_DELETE_WINDOW_SEC, TelegramDomain } from "../src/domain.js";
import { openTelegramTwinDatabase } from "../src/db.js";
import { createTelegramTwinApp } from "../src/twin.js";
import { defaultSeedState, SYNTHETIC_BOT_TOKEN } from "../src/seed.js";

const secret = "test-secret-32-chars-minimum-length";
const sid = "test-session";
const previous = process.env.TWIN_AUTH_SECRET;
const GROUP = -1001234567890;

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = secret;
});
afterAll(() => {
  if (previous === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previous;
});

async function userToken(login: string) {
  return sign({ sid, team_id: "tg", login, exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
}

function fresh(now?: () => number) {
  const db = openTelegramTwinDatabase(":memory:");
  const domain = new TelegramDomain(db, now);
  domain.seed(defaultSeedState());
  const app = createTelegramTwinApp({ db, runId: "hist", seed: defaultSeedState() });
  return { db, domain, app };
}

async function mcp(app: ReturnType<typeof createTelegramTwinApp>, login: string, name: string, args: Record<string, unknown>) {
  const token = await userToken(login);
  const res = await app.request(`/s/${sid}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function bot(app: ReturnType<typeof createTelegramTwinApp>, method: string, body: Record<string, unknown>) {
  const res = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("edit / delete / forward / copy", () => {
  it("same message_id can exist in two chats", () => {
    const { domain } = fresh();
    const a = domain.sendMessage({ kind: "user", account: "alice" }, { chat_id: 2001, text: "a" });
    const b = domain.sendMessage({ kind: "user", account: "bob" }, { chat_id: 2002, text: "b" });
    expect(a.message_id).toBe(1);
    expect(b.message_id).toBe(1);
    expect(domain.getHistory("alice", 2001).map((row) => row.text)).toEqual(["a"]);
    expect(domain.getHistory("bob", 2002).map((row) => row.text)).toEqual(["b"]);
  });

  it("edit keeps message_id and updates search", async () => {
    const { app, domain } = fresh();
    await mcp(app, "alice", "send_message", { chat_id: 2001, text: "old" });
    const edited = await mcp(app, "alice", "edit_message", { chat_id: 2001, message_id: 1, text: "new" });
    expect(JSON.stringify(edited.body)).toContain("new");
    expect(JSON.stringify(edited.body)).toContain("edit_date");
    expect(domain.getHistory("alice", 2001)).toEqual([
      expect.objectContaining({ message_id: 1, text: "new" }),
    ]);
    expect(domain.searchMessages("alice", { chat_id: 2001, query: "old" })).toEqual([]);
    expect(domain.searchMessages("alice", { chat_id: 2001, query: "new" }).map((row) => row.text)).toEqual(["new"]);
  });

  it("alice cannot edit bob's lab message", async () => {
    const { app } = fresh();
    await mcp(app, "bob", "send_message", { chat_id: GROUP, text: "bob owns this" });
    const res = await mcp(app, "alice", "edit_message", { chat_id: GROUP, message_id: 1, text: "stolen" });
    expect(JSON.stringify(res.body)).toContain("can't be edited");
  });

  it("user local delete hides for them only", async () => {
    const { app, domain } = fresh();
    await mcp(app, "bob", "send_message", { chat_id: GROUP, text: "visible" });
    const del = await mcp(app, "alice", "delete_message", { chat_id: GROUP, message_id: 1 });
    expect(JSON.stringify(del.body)).not.toContain("unauthorized");
    const aliceHist = await mcp(app, "alice", "get_history", { chat_id: GROUP });
    const bobHist = await mcp(app, "bob", "get_history", { chat_id: GROUP });
    expect(JSON.stringify(aliceHist.body)).not.toContain("visible");
    expect(JSON.stringify(bobHist.body)).toContain("visible");
    expect(domain.searchMessages("alice", { chat_id: GROUP, query: "visible" })).toEqual([]);
    expect(domain.searchMessages("alice", { query: "visible" })).toEqual([]);
    expect(domain.searchMessages("bob", { query: "visible" }).map((row) => row.text)).toEqual(["visible"]);
  });

  it("author revoke is gone for everyone and hide does not swallow the next send", async () => {
    const { app, domain } = fresh();
    await mcp(app, "bob", "send_message", { chat_id: GROUP, text: "first" });
    await mcp(app, "alice", "delete_message", { chat_id: GROUP, message_id: 1 });
    await mcp(app, "bob", "delete_message", { chat_id: GROUP, message_id: 1 });
    expect(domain.getHistory("alice", GROUP)).toEqual([]);
    expect(domain.getHistory("bob", GROUP)).toEqual([]);
    await mcp(app, "bob", "send_message", { chat_id: GROUP, text: "second" });
    expect(domain.getHistory("alice", GROUP).map((row) => row.text)).toEqual(["second"]);
    expect(domain.getHistory("alice", GROUP)[0]?.message_id).toBe(2);
  });

  it("user revoke of someone else's message fails", async () => {
    const { app } = fresh();
    await mcp(app, "bob", "send_message", { chat_id: GROUP, text: "stay" });
    const res = await mcp(app, "alice", "delete_message", { chat_id: GROUP, message_id: 1, revoke: true });
    expect(JSON.stringify(res.body)).toContain("can't be deleted");
    const bobHist = await mcp(app, "bob", "get_history", { chat_id: GROUP });
    expect(JSON.stringify(bobHist.body)).toContain("stay");
  });

  it("bot delete is refused after 48 hours", () => {
    let t = 1_700_000_000;
    const { domain } = fresh(() => t);
    domain.sendMessage({ kind: "bot", botId: 1100001 }, { chat_id: 2001, text: "aged" });
    t += BOT_DELETE_WINDOW_SEC + 1;
    expect(() => domain.deleteMessage({ kind: "bot", botId: 1100001 }, { chat_id: 2001, message_id: 1 })).toThrow(
      /can't be deleted/,
    );
    expect(domain.getHistory("alice", 2001)[0]?.text).toBe("aged");
  });

  it("HTTP delete returns result true", async () => {
    const { app } = fresh();
    await bot(app, "sendMessage", { chat_id: 2001, text: "gone" });
    const del = await bot(app, "deleteMessage", { chat_id: 2001, message_id: 1 });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, result: true });
  });

  it("forward keeps attribution; copy does not", async () => {
    const { app } = fresh();
    await mcp(app, "alice", "send_message", { chat_id: 2001, text: "src" });
    const fwd = await bot(app, "forwardMessage", { chat_id: GROUP, from_chat_id: 2001, message_id: 1 });
    expect(fwd.status).toBe(200);
    expect(JSON.stringify(fwd.body)).toContain("forward_from");
    expect(JSON.stringify(fwd.body)).toContain("src");
    const copy = await bot(app, "copyMessage", { chat_id: GROUP, from_chat_id: 2001, message_id: 1 });
    expect(copy.status).toBe(200);
    expect(JSON.stringify(copy.body)).toContain("src");
    expect(JSON.stringify(copy.body)).not.toContain("forward_from");
  });

  it("forward into a chat the actor cannot see fails and leaves that chat unchanged", async () => {
    const { app, domain } = fresh();
    await mcp(app, "alice", "send_message", { chat_id: 2001, text: "secret" });
    const res = await mcp(app, "alice", "forward_message", { chat_id: 2002, from_chat_id: 2001, message_id: 1 });
    expect(JSON.stringify(res.body)).toContain("chat not found");
    expect(domain.getHistory("bob", 2002)).toEqual([]);
    const fromUnseen = await mcp(app, "alice", "forward_message", { chat_id: GROUP, from_chat_id: 2002, message_id: 1 });
    expect(JSON.stringify(fromUnseen.body)).toContain("chat not found");
    expect(domain.getHistory("alice", GROUP)).toEqual([]);
  });
});

describe("search / context / links / viewers", () => {
  it("global search does not leak another account's private chat", async () => {
    const { app } = fresh();
    await mcp(app, "bob", "send_message", { chat_id: 2002, text: "bob-private-unique" });
    const alice = await mcp(app, "alice", "search_global", { query: "bob-private-unique" });
    expect(JSON.stringify(alice.body)).not.toContain("bob-private-unique");
    const bob = await mcp(app, "bob", "search_global", { query: "bob-private-unique" });
    expect(JSON.stringify(bob.body)).toContain("bob-private-unique");
  });

  it("get_messages is a window around message_id", async () => {
    const { app } = fresh();
    for (const text of ["one", "two", "three"]) {
      await mcp(app, "alice", "send_message", { chat_id: 2001, text });
    }
    const res = await mcp(app, "alice", "get_messages", { chat_id: 2001, message_id: 2, limit: 0 });
    expect(JSON.stringify(res.body)).toContain("two");
    expect(JSON.stringify(res.body)).not.toContain("one");
    expect(JSON.stringify(res.body)).not.toContain("three");
  });

  it("links only resolve seeded chats", async () => {
    const { app } = fresh();
    await mcp(app, "alice", "send_message", { chat_id: 2001, text: "linked" });
    const made = await mcp(app, "alice", "get_message_link", { chat_id: 2001, message_id: 1 });
    expect(JSON.stringify(made.body)).toContain("tg://message?chat_id=2001&message_id=1");
    const ok = await mcp(app, "alice", "message_from_link", { link: "tg://message?chat_id=2001&message_id=1" });
    expect(JSON.stringify(ok.body)).toContain("linked");
    const bad = await mcp(app, "alice", "message_from_link", { link: "https://example.com/x" });
    expect(JSON.stringify(bad.body)).toContain("unsupported link");
    const tme = await mcp(app, "alice", "message_from_link", { link: "https://t.me/c/1234567890/1" });
    expect(JSON.stringify(tme.body)).toContain("unsupported link");
  });

  it("viewers in a private chat are only the caller", async () => {
    const { app } = fresh();
    await mcp(app, "alice", "send_message", { chat_id: 2001, text: "hi" });
    await mcp(app, "alice", "mark_as_read", { chat_id: 2001, message_id: 1 });
    const viewers = await mcp(app, "alice", "get_message_viewers", { chat_id: 2001, message_id: 1 });
    expect(JSON.stringify(viewers.body)).toContain("alice");
    expect(JSON.stringify(viewers.body)).not.toContain("bob");
  });
});
