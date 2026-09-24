// SPDX-License-Identifier: Apache-2.0
import { createRecorderStore } from "@pome-sh/sdk/server";
import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSeedState, SYNTHETIC_BOT_TOKEN, type TelegramSeed } from "../src/seed.js";
import { createTelegramTwinApp } from "../src/twin.js";

const secret = "telegram-mcp-invites-test-secret";
const sid = "telegram-mcp-invites";
const previousSecret = process.env.TWIN_AUTH_SECRET;
const GROUP = -1001234567890;
const PUBLIC_CHANNEL = -1003000000001;
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

function publicSeed(): TelegramSeed {
  const seed = defaultSeedState();
  seed.chats.push(
    { id: PUBLIC_CHANNEL, type: "channel", title: "Public News", username: "publicnews", members: [2001] },
    { id: -1003000000002, type: "supergroup", title: "Public Lab", username: "publiclab", members: [2001] },
  );
  return seed;
}

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

describe("Telegram MCP invites, channels, and forum topics", () => {
  it("admits a user through a bot-created invite after approval", async () => {
    const recorder = createRecorderStore();
    const app = createTelegramTwinApp({ seed: publicSeed(), recorder, runId: "telegram-mcp-invites" });

    await call(app, aliceToken, "remove_user", { chat_id: GROUP, user_id: 2002 });
    const created = await bot(app, "createChatInviteLink", { chat_id: GROUP, creates_join_request: true });
    expect(created.status).toBe(200);
    const invite = created.body.result as { invite_link: string };

    const pending = JSON.parse(resultText(await call(app, bobToken, "join_chat_by_link", { link: invite.invite_link }))) as {
      pending: boolean;
      chat_id: number;
    };
    expect(pending).toEqual({ ok: true, pending: true, chat_id: GROUP });
    const hidden = await call(app, bobToken, "get_participants", { chat_id: GROUP });
    expect(hidden.result.isError).toBe(true);

    expect((await bot(app, "approveChatJoinRequest", { chat_id: GROUP, user_id: 2002 })).status).toBe(200);
    const participants = JSON.parse(resultText(await call(app, aliceToken, "get_participants", { chat_id: GROUP }))) as {
      total: number;
      participants: Array<{ id: number }>;
    };
    expect(participants.total).toBe(3);
    expect(participants.participants.map((row) => row.id).sort((a, b) => a - b)).toEqual([2001, 2002, 1100001]);
    expect(JSON.stringify(recorder.events())).not.toContain(SYNTHETIC_BOT_TOKEN);
  });

  it("creates a channel, searches the public catalog, and subscribes by username", async () => {
    const app = createTelegramTwinApp({ seed: publicSeed() });
    const created = JSON.parse(resultText(await call(app, aliceToken, "create_channel", {
      title: "Private Broadcast",
      about: "Alice only",
    }))) as { id: number; type: string; title: string };
    expect(created).toMatchObject({ type: "channel", title: "Private Broadcast" });

    const found = JSON.parse(resultText(await call(app, bobToken, "search_public_chats", { query: "Public" }))) as Array<{
      username?: string;
    }>;
    expect(found.map((row) => row.username).sort()).toEqual(["publiclab", "publicnews"]);
    expect(found.some((row) => row.username === undefined)).toBe(false);

    const joined = JSON.parse(resultText(await call(app, bobToken, "subscribe_public_channel", { channel: "@publicnews" }))) as {
      id: number;
      username?: string;
    };
    expect(joined).toMatchObject({ id: PUBLIC_CHANNEL, username: "publicnews" });
    const duplicate = await call(app, bobToken, "subscribe_public_channel", { channel: PUBLIC_CHANNEL });
    expect(duplicate.result.isError).toBe(true);

    const secret = await call(app, bobToken, "get_participants", { chat_id: created.id });
    expect(secret.result.isError).toBe(true);
  });

  it("exports, imports, and rejects an account override on invite joins", async () => {
    const app = createTelegramTwinApp({ seed: publicSeed() });
    await call(app, aliceToken, "remove_user", { chat_id: GROUP, user_id: 2002 });
    const exported = resultText(await call(app, aliceToken, "export_chat_invite", { chat_id: GROUP }));
    expect(exported.startsWith("https://t.me/+")).toBe(true);
    const primary = resultText(await call(app, aliceToken, "get_invite_link", { chat_id: GROUP }));
    expect(primary.startsWith("https://t.me/+")).toBe(true);

    const stolen = await call(app, aliceToken, "join_chat_by_link", { link: exported, account: "bob" });
    expect(stolen.result.isError).toBe(true);
    expect(JSON.parse(resultText(await call(app, bobToken, "import_chat_invite", {
      hash: exported.replace("https://t.me/+", ""),
    })))).toMatchObject({ id: GROUP });
  });

  it("enables forum topics and posts into a created topic", async () => {
    const app = createTelegramTwinApp({ seed: publicSeed() });
    expect(JSON.parse(resultText(await call(app, aliceToken, "enable_forum_topics", { chat_id: GROUP })))).toEqual({ ok: true });
    const topic = JSON.parse(resultText(await call(app, aliceToken, "create_forum_topic", {
      chat_id: GROUP,
      title: "Support",
    }))) as { chat_id: number; topic_id: number; title: string };
    expect(topic).toMatchObject({ chat_id: GROUP, title: "Support" });

    const listed = JSON.parse(resultText(await call(app, aliceToken, "list_topics", { chat_id: GROUP }))) as Array<{
      topic_id: number;
      title: string;
    }>;
    expect(listed.some((row) => row.topic_id === topic.topic_id && row.title === "Support")).toBe(true);

    await call(app, aliceToken, "promote_admin", {
      group_id: GROUP,
      user_id: 1100001,
      rights: { can_manage_topics: true },
    });
    const sent = await bot(app, "sendMessage", { chat_id: GROUP, text: "thread", message_thread_id: topic.topic_id });
    expect(sent.body.result).toMatchObject({ text: "thread", message_thread_id: topic.topic_id });
    expect((await bot(app, "closeForumTopic", { chat_id: GROUP, message_thread_id: topic.topic_id })).status).toBe(200);
    expect((await bot(app, "sendMessage", { chat_id: GROUP, text: "nope", message_thread_id: topic.topic_id })).status).toBe(400);
    expect((await bot(app, "reopenForumTopic", { chat_id: GROUP, message_thread_id: topic.topic_id })).status).toBe(200);
    expect((await bot(app, "deleteForumTopic", { chat_id: GROUP, message_thread_id: topic.topic_id })).status).toBe(200);
  });
});
