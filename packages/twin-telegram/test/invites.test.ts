// SPDX-License-Identifier: Apache-2.0
import { createRecorderStore } from "@pome-sh/sdk/server";
import { describe, expect, it } from "vitest";
import { openTelegramTwinDatabase } from "../src/db.js";
import { TelegramDomain } from "../src/domain.js";
import { defaultSeedState, SYNTHETIC_BOT_TOKEN, type TelegramSeed } from "../src/seed.js";
import { createTelegramTwinApp } from "../src/twin.js";

const BOT = { kind: "bot" as const, botId: 1100001 };
const GROUP = -1001234567890;
const PUBLIC_CHANNEL = -1003000000001;
const PUBLIC_SUPERGROUP = -1003000000002;
const ALICE = { kind: "user" as const, account: "alice" };
const BOB = { kind: "user" as const, account: "bob" };

function publicSeed(): TelegramSeed {
  const seed = defaultSeedState();
  seed.chats.push(
    { id: PUBLIC_CHANNEL, type: "channel", title: "Public News", username: "publicnews", members: [2001] },
    { id: PUBLIC_SUPERGROUP, type: "supergroup", title: "Public Lab", username: "publiclab", members: [2001] },
  );
  return seed;
}

function fresh(now: () => number = () => 1_700_000_000, seed: TelegramSeed = publicSeed()) {
  const db = openTelegramTwinDatabase(":memory:");
  const domain = new TelegramDomain(db, now);
  domain.seed(seed);
  return { db, domain };
}

async function bot(app: ReturnType<typeof createTelegramTwinApp>, method: string, body: Record<string, unknown>) {
  const response = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { ok: boolean; result: unknown; description?: string } };
}

describe("Telegram invites, channels, and forum topics", () => {
  it("keeps membership and history aligned after an invite join", () => {
    const { domain } = fresh();
    domain.sendMessage(ALICE, { chat_id: GROUP, text: "before join" });
    domain.removeUser(ALICE, { chat_id: GROUP, user_id: 2002 });
    expect(domain.getChatMemberCount(ALICE, GROUP)).toBe(2);
    expect(() => domain.getHistory("bob", GROUP)).toThrow(/chat not found/);

    const link = domain.exportChatInvite("alice", { chat_id: GROUP });
    const joined = domain.joinChatByLink("bob", { link });
    expect(joined).toMatchObject({ id: GROUP, title: "Lab" });
    expect(domain.getChatMemberCount(ALICE, GROUP)).toBe(3);
    expect(domain.getParticipants("alice", { chat_id: GROUP }).total).toBe(3);
    expect(domain.getHistory("bob", GROUP).some((row) => row.text === "before join")).toBe(true);
    expect(domain.getChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toMatchObject({ status: "member" });
  });

  it("refuses expired, revoked, and overused invite links", () => {
    let now = 1_700_000_000;
    const { domain } = fresh(() => now);
    domain.removeUser(ALICE, { chat_id: GROUP, user_id: 2002 });

    const expired = domain.createChatInviteLink(ALICE, { chat_id: GROUP, expire_date: now + 30 });
    now += 30;
    expect(() => domain.joinChatByLink("bob", { link: expired.invite_link as string })).toThrow(/expired/);

    now += 1;
    const limited = domain.createChatInviteLink(ALICE, { chat_id: GROUP, member_limit: 1 });
    domain.joinChatByLink("bob", { link: limited.invite_link as string });
    domain.leaveChat(BOB, { chat_id: GROUP });
    expect(() => domain.joinChatByLink("bob", { link: limited.invite_link as string })).toThrow(/no longer valid/);

    const revocable = domain.createChatInviteLink(ALICE, { chat_id: GROUP });
    domain.revokeChatInviteLink(ALICE, { chat_id: GROUP, invite_link: revocable.invite_link as string });
    expect(() => domain.joinChatByLink("bob", { link: revocable.invite_link as string })).toThrow(/revoked/);
  });

  it("refuses a duplicate join and a second pending request", () => {
    const { domain } = fresh();
    const open = domain.exportChatInvite("alice", { chat_id: GROUP });
    expect(() => domain.joinChatByLink("bob", { link: open })).toThrow(/already a participant/);

    domain.removeUser(ALICE, { chat_id: GROUP, user_id: 2002 });
    const approval = domain.createChatInviteLink(ALICE, { chat_id: GROUP, creates_join_request: true });
    expect(domain.joinChatByLink("bob", { link: approval.invite_link as string })).toMatchObject({ pending: true, chat_id: GROUP });
    expect(() => domain.getHistory("bob", GROUP)).toThrow(/chat not found/);
    expect(() => domain.joinChatByLink("bob", { link: approval.invite_link as string })).toThrow(/already sent/);
  });

  it("approves and declines pending join requests", () => {
    const { domain } = fresh();
    domain.removeUser(ALICE, { chat_id: GROUP, user_id: 2002 });
    const approval = domain.createChatInviteLink(ALICE, { chat_id: GROUP, creates_join_request: true });
    domain.joinChatByLink("bob", { link: approval.invite_link as string });
    expect(domain.approveChatJoinRequest(ALICE, { chat_id: GROUP, user_id: 2002 })).toEqual({ ok: true });
    expect(domain.getChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toMatchObject({ status: "member" });
    expect(domain.getHistory("bob", GROUP)).toEqual(expect.any(Array));

    domain.leaveChat(BOB, { chat_id: GROUP });
    const second = domain.createChatInviteLink(ALICE, { chat_id: GROUP, creates_join_request: true });
    domain.joinChatByLink("bob", { link: second.invite_link as string });
    expect(domain.declineChatJoinRequest(ALICE, { chat_id: GROUP, user_id: 2002 })).toEqual({ ok: true });
    expect(() => domain.getHistory("bob", GROUP)).toThrow(/chat not found/);
    expect(domain.getChatMemberCount(ALICE, GROUP)).toBe(2);
  });

  it("refuses an unauthorized creator and arbitrary external links", () => {
    const { domain } = fresh();
    const created = domain.createChatInviteLink(ALICE, { chat_id: GROUP, name: "alice-only" });
    expect(() => domain.editChatInviteLink(BOB, {
      chat_id: GROUP,
      invite_link: created.invite_link as string,
      name: "stolen",
    })).toThrow(/rights/);
    expect(() => domain.revokeChatInviteLink(BOB, {
      chat_id: GROUP,
      invite_link: created.invite_link as string,
    })).toThrow(/rights/);
    expect(() => domain.joinChatByLink("bob", { link: "https://evil.example/+not-telegram" })).toThrow(/invalid/);
    expect(() => domain.joinChatByLink("bob", { link: "https://t.me/publicnews" })).toThrow(/invalid/);
    expect(() => domain.importChatInvite("bob", { hash: "no-such-hash" })).toThrow(/invalid/);

    const valid = domain.exportChatInvite("alice", { chat_id: GROUP });
    domain.removeUser(ALICE, { chat_id: GROUP, user_id: 2002 });
    expect(domain.importChatInvite("bob", { hash: valid.replace("https://t.me/+", "") })).toMatchObject({ id: GROUP });
  });

  it("restricts channel posting to creator and can_post_messages", () => {
    const { domain } = fresh();
    expect(() => domain.sendMessage(BOB, { chat_id: PUBLIC_CHANNEL, text: "no" })).toThrow(/chat not found/);
    domain.subscribePublicChannel("bob", { channel: "publicnews" });
    expect(() => domain.sendMessage(BOB, { chat_id: PUBLIC_CHANNEL, text: "member post" })).toThrow(/rights to post/);
    expect(domain.sendMessage(ALICE, { chat_id: PUBLIC_CHANNEL, text: "owner post" }).text).toBe("owner post");

    domain.inviteToGroup("alice", { group_id: PUBLIC_CHANNEL, user_ids: [1100001] });
    expect(() => domain.sendMessage(BOT, { chat_id: PUBLIC_CHANNEL, text: "bot member" })).toThrow(/rights to post/);
    domain.promoteChatMember(ALICE, { chat_id: PUBLIC_CHANNEL, user_id: 1100001, rights: { can_post_messages: true } });
    expect(domain.sendMessage(BOT, { chat_id: PUBLIC_CHANNEL, text: "bot post" }).text).toBe("bot post");
  });

  it("searches only the seeded public catalog", () => {
    const { domain } = fresh();
    expect(domain.searchPublicChats("bob", { query: "Lab" })).toEqual([
      { id: PUBLIC_SUPERGROUP, type: "supergroup", title: "Public Lab", username: "publiclab" },
    ]);
    expect(domain.searchPublicChats("bob", { query: "publicnews" })).toEqual([
      { id: PUBLIC_CHANNEL, type: "channel", title: "Public News", username: "publicnews" },
    ]);
    expect(domain.searchPublicChats("alice", { query: "no-such-chat" })).toEqual([]);
  });

  it("closes, reopens, and deletes topics without dropping thread history on close", () => {
    const { domain } = fresh();
    domain.enableForumTopics("alice", { chat_id: GROUP });
    const created = domain.createForumTopic(ALICE, { chat_id: GROUP, title: "Bugs" });
    expect(created).toMatchObject({ chat_id: GROUP, title: "Bugs" });
    const topicId = created.topic_id as number;
    expect(domain.sendMessage(ALICE, { chat_id: GROUP, text: "in topic", message_thread_id: topicId })).toMatchObject({
      text: "in topic",
      message_thread_id: topicId,
    });
    expect(domain.closeForumTopic(ALICE, { chat_id: GROUP, message_thread_id: topicId })).toEqual({ ok: true });
    expect(() => domain.sendMessage(ALICE, { chat_id: GROUP, text: "closed", message_thread_id: topicId })).toThrow(/closed/);
    expect(domain.getHistory("alice", GROUP).some((row) => row.message_thread_id === topicId && row.text === "in topic")).toBe(true);
    expect(domain.reopenForumTopic(ALICE, { chat_id: GROUP, message_thread_id: topicId })).toEqual({ ok: true });
    expect(domain.sendMessage(BOB, { chat_id: GROUP, text: "reopened", message_thread_id: topicId }).text).toBe("reopened");
    expect(domain.deleteForumTopic(ALICE, { chat_id: GROUP, message_thread_id: topicId })).toEqual({ ok: true });
    expect(domain.listTopics("alice", { chat_id: GROUP }).some((row) => row.topic_id === topicId)).toBe(false);
    expect(domain.getHistory("alice", GROUP).filter((row) => row.message_thread_id === topicId)).toHaveLength(2);
    expect(() => domain.sendMessage(ALICE, { chat_id: GROUP, text: "gone", message_thread_id: topicId })).toThrow(/topic not found/);
  });

  it("clears invites, join requests, and topics on seed/reset", () => {
    const { domain } = fresh();
    domain.enableForumTopics("alice", { chat_id: GROUP });
    domain.createForumTopic(ALICE, { chat_id: GROUP, title: "Temp" });
    const link = domain.exportChatInvite("alice", { chat_id: GROUP });
    domain.seed(publicSeed());
    expect(() => domain.joinChatByLink("bob", { link })).toThrow(/invalid/);
    expect(() => domain.listTopics("alice", { chat_id: GROUP })).toThrow(/not a forum/);
  });

  it("creates and uses invite links over HTTP", async () => {
    const recorder = createRecorderStore();
    const app = createTelegramTwinApp({ seed: publicSeed(), recorder, runId: "telegram-invites-http" });
    const created = await bot(app, "createChatInviteLink", { chat_id: GROUP, name: "http-link" });
    expect(created).toMatchObject({
      status: 200,
      body: { ok: true, result: { name: "http-link", is_primary: false, is_revoked: false } },
    });
    const invite = created.body.result as { invite_link: string };
    expect(invite.invite_link.startsWith("https://t.me/+")).toBe(true);
    expect(JSON.stringify(recorder.events())).not.toContain(SYNTHETIC_BOT_TOKEN);
  });
});
