// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { describe, expect, it } from "vitest";
import { openTelegramTwinDatabase } from "../src/db.js";
import { TelegramDomain } from "../src/domain.js";
import { resolveCatalogFile, resolveChatPhoto, type CatalogFile } from "../src/media-catalog.js";
import { FULL_CHAT_PERMISSIONS } from "../src/membership.js";
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

  it("refuses to kick creator, admin, or self through unban when only_if_banned is false", () => {
    const { domain } = fresh();
    expect(() => domain.unbanChatMember(ALICE, { chat_id: GROUP, user_id: 2001, only_if_banned: false })).toThrow(/self/);
    domain.promoteChatMember(ALICE, { chat_id: GROUP, user_id: 2002, rights: { can_restrict_members: true } });
    expect(() => domain.unbanChatMember(BOB, { chat_id: GROUP, user_id: 2001, only_if_banned: false })).toThrow(/creator/);
    domain.promoteChatMember(ALICE, { chat_id: GROUP, user_id: 1100001, rights: { can_invite_users: true } });
    expect(() => domain.unbanChatMember(BOB, { chat_id: GROUP, user_id: 1100001, only_if_banned: false })).toThrow(/administrator/);
    expect(domain.getChatMember(ALICE, { chat_id: GROUP, user_id: 1100001 })).toMatchObject({ status: "administrator" });
  });

  it("grants only the supplied editAdminRights flags", () => {
    const { domain } = fresh();
    domain.editAdminRights(ALICE, { chat_id: GROUP, user_id: 2002, rights: { delete_messages: true } });
    expect(domain.getChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toMatchObject({
      status: "administrator",
      can_delete_messages: true,
      can_manage_chat: false,
      can_restrict_members: false,
      can_promote_members: false,
      can_invite_users: false,
    });
  });

  it("restores a restricted member when restrictChatMember is a full allow", () => {
    const { domain } = fresh();
    domain.restrictChatMember(ALICE, { chat_id: GROUP, user_id: 2002, permissions: { can_send_messages: false } });
    expect(domain.getChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toMatchObject({ status: "restricted" });
    expect(() => domain.sendMessage(BOB, { chat_id: GROUP, text: "blocked" })).toThrow(/rights/);
    domain.restrictChatMember(ALICE, { chat_id: GROUP, user_id: 2002, permissions: FULL_CHAT_PERMISSIONS });
    expect(domain.getChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toMatchObject({ status: "member" });
    expect(domain.sendMessage(BOB, { chat_id: GROUP, text: "restored" }).text).toBe("restored");
  });

  it("rejects non-photo chat catalog files and keeps photo.webp bytes distinct from stickers", () => {
    expect(() => resolveChatPhoto("pome_lab/wave.webp")).toThrow(/photo/);
    expect(() => resolveChatPhoto("sample.txt")).toThrow(/photo/);
    const photo = resolveChatPhoto("photo.webp") as CatalogFile;
    const sticker = resolveCatalogFile("pome_lab/wave.webp", "sticker") as CatalogFile;
    expect(photo.kind).toBe("photo");
    expect(sticker.kind).toBe("sticker");
    expect(photo.bytes.equals(sticker.bytes)).toBe(false);
  });

  it("requires a permissions object on setChatPermissions and restrictChatMember", () => {
    const { domain } = fresh();
    expect(() => domain.setChatPermissions(ALICE, { chat_id: GROUP })).toThrow(/permissions/);
    expect(() => domain.restrictChatMember(ALICE, { chat_id: GROUP, user_id: 2002 })).toThrow(/permissions/);
  });

  it("backfills creator_id on existing file-backed chats the same way seed assigns a creator", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-migrate-"));
    const path = join(dir, "twin.db");
    try {
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE chats (id INTEGER PRIMARY KEY, type TEXT NOT NULL, title TEXT);
        CREATE TABLE chat_members (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (chat_id, user_id));
        CREATE TABLE users (id INTEGER PRIMARY KEY, account TEXT, first_name TEXT, username TEXT);
        INSERT INTO users VALUES (2001, 'alice', 'Alice', 'alice');
        INSERT INTO users VALUES (2002, 'bob', 'Bob', 'bob');
        INSERT INTO chats VALUES (-100, 'supergroup', 'Old');
        INSERT INTO chats VALUES (2001, 'private', NULL);
        INSERT INTO chat_members VALUES (-100, 2001);
        INSERT INTO chat_members VALUES (-100, 2002);
        INSERT INTO chat_members VALUES (2001, 2001);
      `);
      old.close();
      const db = openTelegramTwinDatabase(path);
      expect(db.prepare("SELECT creator_id FROM chats WHERE id = -100").get()).toEqual({ creator_id: 2001 });
      expect(db.prepare("SELECT status FROM chat_members WHERE chat_id = -100 AND user_id = 2001").get()).toEqual({ status: "creator" });
      expect(db.prepare("SELECT creator_id FROM chats WHERE id = 2001").get()).toEqual({ creator_id: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
