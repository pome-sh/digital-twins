// SPDX-License-Identifier: Apache-2.0
import { createRecorderStore } from "@pome-sh/sdk/server";
import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSeedState, SYNTHETIC_BOT_TOKEN } from "../src/seed.js";
import { telegramMcpToolFixture } from "../src/tools.js";
import { createTelegramTwinApp } from "../src/twin.js";

const secret = "telegram-mcp-membership-test-secret";
const sid = "telegram-mcp-membership";
const previousSecret = process.env.TWIN_AUTH_SECRET;
let aliceToken: string;
let bobToken: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = secret;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  aliceToken = await sign({ sid, team_id: "tm_telegram", login: "alice", exp: expires }, secret);
  bobToken = await sign({ sid, team_id: "tm_telegram", login: "bob", exp: expires }, secret);
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

async function call(app: ReturnType<typeof createTelegramTwinApp>, token: string, name: string, args: Record<string, unknown>) {
  const response = await app.request(`/s/${sid}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result: { isError?: boolean; structuredContent?: { result?: string } };
  };
}

function resultText(body: Awaited<ReturnType<typeof call>>): string {
  expect(body.result.isError).not.toBe(true);
  expect(body.result.structuredContent?.result).toEqual(expect.any(String));
  return body.result.structuredContent!.result!;
}

async function bot(app: ReturnType<typeof createTelegramTwinApp>, method: string, body: Record<string, unknown>) {
  const response = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { ok: boolean; result: unknown; description?: string } };
}

describe("Telegram MCP membership projection", () => {
  it("creates a group, grants the bot authority, and reads HTTP moderation immediately", async () => {
    const recorder = createRecorderStore();
    const app = createTelegramTwinApp({ seed: defaultSeedState(), recorder, runId: "telegram-mcp-membership" });

    const created = JSON.parse(resultText(await call(app, aliceToken, "create_group", {
      title: "Moderation lab",
      user_ids: ["bob"],
    }))) as { id: number; title: string };
    expect(created.title).toBe("Moderation lab");

    expect(JSON.parse(resultText(await call(app, aliceToken, "invite_to_group", {
      group_id: created.id,
      user_ids: ["x_bot"],
    })))).toMatchObject({ ok: true, added: [1100001] });

    expect(JSON.parse(resultText(await call(app, aliceToken, "promote_admin", {
      group_id: created.id,
      user_id: 1100001,
      rights: { ban_users: true, change_info: true, invite_users: true },
    })))).toEqual({ ok: true });

    const banned = await bot(app, "banChatMember", { chat_id: created.id, user_id: 2002 });
    expect(banned).toMatchObject({ status: 200, body: { ok: true, result: true } });
    const restricted = await bot(app, "restrictChatMember", {
      chat_id: created.id,
      user_id: 2002,
      permissions: { can_send_messages: false },
    });
    expect(restricted.status).toBe(400);

    const participants = JSON.parse(resultText(await call(app, aliceToken, "get_participants", { chat_id: created.id }))) as {
      total: number;
      participants: Array<{ id: number; status: string }>;
    };
    const admins = JSON.parse(resultText(await call(app, aliceToken, "get_admins", { chat_id: created.id }))) as Array<{ status: string; user?: { id: number }; id?: number }>;
    const bannedUsers = JSON.parse(resultText(await call(app, aliceToken, "get_banned_users", { chat_id: created.id }))) as Array<{ id: number; status: string }>;
    const counted = await bot(app, "getChatMemberCount", { chat_id: created.id });
    const httpAdmins = await bot(app, "getChatAdministrators", { chat_id: created.id });

    expect(participants.total).toBe(2);
    expect(participants.participants.map((row) => row.id).sort((a, b) => a - b)).toEqual([2001, 1100001]);
    expect(bannedUsers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 2002, status: "kicked" })]));
    expect(counted.body.result).toBe(2);
    expect(admins.some((row) => row.status === "creator" || row.user?.id === 2001 || row.id === 2001)).toBe(true);
    expect((httpAdmins.body.result as Array<{ user: { id: number } }>).some((row) => row.user.id === 1100001)).toBe(true);
    expect(JSON.stringify(recorder.events())).not.toContain(SYNTHETIC_BOT_TOKEN);
  });

  it("grants, acts, revokes, and then denies", async () => {
    const app = createTelegramTwinApp({ seed: defaultSeedState() });
    await call(app, aliceToken, "promote_admin", {
      group_id: -1001234567890,
      user_id: "x_bot",
      rights: { ban_users: true },
    });
    expect((await bot(app, "banChatMember", { chat_id: -1001234567890, user_id: 2002 })).status).toBe(200);
    await call(app, aliceToken, "unban_user", { chat_id: -1001234567890, user_id: 2002 });
    await call(app, aliceToken, "invite_to_group", { group_id: -1001234567890, user_ids: [2002] });
    await call(app, aliceToken, "demote_admin", { group_id: -1001234567890, user_id: 1100001 });
    expect((await bot(app, "banChatMember", { chat_id: -1001234567890, user_id: 2002 })).status).toBe(400);
  });

  it("refuses an unauthorized account selector and private visibility", async () => {
    const app = createTelegramTwinApp({ seed: defaultSeedState() });
    const created = JSON.parse(resultText(await call(app, aliceToken, "create_group", {
      title: "Secret",
      user_ids: [],
    }))) as { id: number };
    const overridden = await call(app, aliceToken, "get_participants", { chat_id: created.id, account: "bob" });
    expect(overridden.result.isError).toBe(true);
    const hidden = await call(app, bobToken, "get_participants", { chat_id: created.id });
    expect(hidden.result.isError).toBe(true);
    const title = await call(app, aliceToken, "edit_chat_title", { chat_id: created.id, title: "Still secret" });
    expect(JSON.parse(resultText(title))).toEqual({ ok: true });
    const about = await call(app, aliceToken, "edit_chat_about", { chat_id: created.id, about: "Alice only" });
    expect(JSON.parse(resultText(about))).toEqual({ ok: true });
    const photo = await call(app, aliceToken, "edit_chat_photo", { chat_id: created.id, file_path: "photo.webp" });
    expect(JSON.parse(resultText(photo))).toEqual({ ok: true });
    expect(JSON.parse(resultText(await call(app, aliceToken, "delete_chat_photo", { chat_id: created.id })))).toEqual({ ok: true });
    expect(JSON.parse(resultText(await call(app, aliceToken, "toggle_slow_mode", { chat_id: created.id, seconds: 30 })))).toEqual({ ok: true });
    expect(JSON.parse(resultText(await call(app, aliceToken, "get_recent_actions", { chat_id: created.id }))).length).toBeGreaterThan(0);
  });

  it("lists the previous 18 tools plus these 19 membership tools", async () => {
    const app = createTelegramTwinApp({ seed: defaultSeedState() });
    const response = await app.request(`/s/${sid}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(telegramMcpToolFixture.toolNames);
    expect(telegramMcpToolFixture.toolNames).toHaveLength(37);
  });
});
