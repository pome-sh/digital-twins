// SPDX-License-Identifier: Apache-2.0
import { createRecorderStore } from "@pome-sh/sdk/server";
import { describe, expect, it } from "vitest";
import { openTelegramTwinDatabase } from "../src/db.js";
import { TelegramDomain } from "../src/domain.js";
import { defaultSeedState, SYNTHETIC_BOT_TOKEN } from "../src/seed.js";
import { createTelegramTwinApp } from "../src/twin.js";

const BOT = { kind: "bot" as const, botId: 1100001 };
const GROUP = -1001234567890;
const ALICE = { kind: "user" as const, account: "alice" };
const BOB = { kind: "user" as const, account: "bob" };

function fresh(now: () => number = () => 1_700_000_000) {
  const db = openTelegramTwinDatabase(":memory:");
  const domain = new TelegramDomain(db, now);
  domain.seed(defaultSeedState());
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

describe("Telegram membership domain", () => {
  it("keeps invite, remove, ban, unban, and leave as different transitions", () => {
    const { domain } = fresh();
    domain.removeUser(ALICE, { chat_id: GROUP, user_id: 2002 });
    expect(domain.getChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toMatchObject({ status: "left" });
    expect(domain.getChatMemberCount(ALICE, GROUP)).toBe(2);

    domain.inviteToGroup("alice", { group_id: GROUP, user_ids: [2002] });
    expect(domain.getChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toMatchObject({ status: "member" });
    expect(domain.getChatMemberCount(ALICE, GROUP)).toBe(3);

    domain.banChatMember(ALICE, { chat_id: GROUP, user_id: 2002 });
    expect(domain.getChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toMatchObject({ status: "kicked" });
    expect(domain.getBannedUsers("alice", { chat_id: GROUP }).map((row) => row.id)).toEqual([2002]);
    expect(() => domain.inviteToGroup("alice", { group_id: GROUP, user_ids: [2002] })).toThrow(/banned/);

    domain.unbanChatMember(ALICE, { chat_id: GROUP, user_id: 2002, only_if_banned: true });
    expect(domain.getChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toMatchObject({ status: "left" });
    expect(domain.getBannedUsers("alice", { chat_id: GROUP })).toEqual([]);
    domain.inviteToGroup("alice", { group_id: GROUP, user_ids: ["bob"] });
    expect(domain.getChatMemberCount(ALICE, GROUP)).toBe(3);

    domain.leaveChat(BOB, { chat_id: GROUP });
    expect(domain.getChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toMatchObject({ status: "left" });
    expect(domain.getBannedUsers("alice", { chat_id: GROUP })).toEqual([]);
  });

  it("refuses rights the actor lacks and keeps creator edges explicit", () => {
    const { domain } = fresh();
    expect(() => domain.promoteChatMember(BOB, { chat_id: GROUP, user_id: 1100001 })).toThrow(/rights/);
    expect(() => domain.banChatMember(ALICE, { chat_id: GROUP, user_id: 2001 })).toThrow(/creator|self/);
    domain.promoteChatMember(ALICE, { chat_id: GROUP, user_id: 2002, rights: { can_invite_users: true, can_restrict_members: false, can_promote_members: true } });
    expect(() => domain.promoteChatMember(BOB, { chat_id: GROUP, user_id: 1100001, rights: { can_restrict_members: true } })).toThrow(/lacks/);
    expect(() => domain.banChatMember(BOB, { chat_id: GROUP, user_id: 1100001 })).toThrow(/rights/);
    expect(() => domain.demoteChatMember(BOB, { chat_id: GROUP, user_id: 2001 })).toThrow(/creator/);
  });

  it("expires restrictions and slow mode through the injected clock", () => {
    let now = 1_700_000_000;
    const { domain } = fresh(() => now);
    domain.restrictChatMember(ALICE, {
      chat_id: GROUP,
      user_id: 2002,
      permissions: { can_send_messages: false },
      until_date: now + 60,
    });
    expect(() => domain.sendMessage(BOB, { chat_id: GROUP, text: "blocked" })).toThrow(/rights/);
    now += 60;
    expect(domain.sendMessage(BOB, { chat_id: GROUP, text: "after expiry" }).text).toBe("after expiry");

    now += 10;
    domain.toggleSlowMode(ALICE, { chat_id: GROUP, seconds: 10 });
    domain.sendMessage(BOB, { chat_id: GROUP, text: "first" });
    expect(() => domain.sendMessage(BOB, { chat_id: GROUP, text: "too soon" })).toThrow(/slow mode/);
    now += 10;
    expect(domain.sendMessage(BOB, { chat_id: GROUP, text: "later" }).text).toBe("later");
  });

  it("hides private groups and treats invalid or no-op mutations truthfully", () => {
    const { domain } = fresh();
    const created = domain.createGroup("alice", { title: "Alice only", user_ids: [] });
    const chatId = created.id as number;
    expect(() => domain.getParticipants("bob", { chat_id: chatId })).toThrow(/chat not found/);
    expect(() => domain.getChat(BOB, chatId)).toThrow(/chat not found/);

    expect(domain.banChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toEqual({ ok: true });
    expect(domain.banChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toEqual({ ok: true });
    expect(domain.unbanChatMember(ALICE, { chat_id: GROUP, user_id: 2002, only_if_banned: true })).toEqual({ ok: true });
    expect(domain.unbanChatMember(ALICE, { chat_id: GROUP, user_id: 2002, only_if_banned: true })).toEqual({ ok: true });
    expect(domain.inviteToGroup("alice", { group_id: GROUP, user_ids: [2002] })).toMatchObject({ ok: true, added: [2002] });
    expect(domain.inviteToGroup("alice", { group_id: GROUP, user_ids: [2002] })).toMatchObject({ ok: true, added: [] });
    expect(() => domain.banChatMember(ALICE, { chat_id: GROUP, user_id: 9999 })).toThrow(/user not found/);
    expect(domain.setChatTitle(ALICE, { chat_id: GROUP, title: "Lab" })).toEqual({ ok: true });
  });

  it("keeps membership counts aligned across administrators, participants, and HTTP", async () => {
    const recorder = createRecorderStore();
    const app = createTelegramTwinApp({ seed: defaultSeedState(), recorder, runId: "membership-count" });
    const { domain } = fresh();
    expect(domain.getChatMemberCount(BOT, GROUP)).toBe(3);
    expect(domain.getParticipants("alice", { chat_id: GROUP }).total).toBe(3);
    expect(domain.getAdmins("alice", { chat_id: GROUP })).toHaveLength(1);
    expect(domain.getChatAdministrators(BOT, GROUP)[0]).toMatchObject({ status: "creator", user: { id: 2001 } });

    const counted = await bot(app, "getChatMemberCount", { chat_id: GROUP });
    expect(counted).toMatchObject({ status: 200, body: { ok: true, result: 3 } });
    const member = await bot(app, "getChatMember", { chat_id: GROUP, user_id: 2001 });
    expect(member.body.result).toMatchObject({ status: "creator", user: { username: "alice" } });
    expect(JSON.stringify(recorder.events())).not.toContain(SYNTHETIC_BOT_TOKEN);
  });

  it("does not wipe an already-seeded store when a second domain opens without a seed", () => {
    const db = openTelegramTwinDatabase(":memory:");
    const first = new TelegramDomain(db);
    first.seed(defaultSeedState());
    first.setChatTitle(ALICE, { chat_id: GROUP, title: "Keep" });
    const second = new TelegramDomain(db);
    expect(second.getChat(ALICE, GROUP).title).toBe("Keep");
  });
});
