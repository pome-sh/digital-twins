// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { openTelegramTwinDatabase } from "../src/db.js";
import { CALLBACK_QUERY_TTL_SEC, TelegramDomain } from "../src/domain.js";
import { defaultSeedState, SYNTHETIC_BOT_TOKEN } from "../src/seed.js";
import { createTelegramTwinApp } from "../src/twin.js";

const BOT = { kind: "bot" as const, botId: 1100001 };
const GROUP = -1001234567890;

function fresh(now: () => number = () => 1_700_000_000) {
  const db = openTelegramTwinDatabase(":memory:");
  const domain = new TelegramDomain(db, now);
  domain.seed(defaultSeedState());
  return { db, domain };
}

describe("interaction state", () => {
  it("uses the same poll and reaction subset through Bot API routes", async () => {
    const app = createTelegramTwinApp({ seed: defaultSeedState() });
    const poll = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendPoll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: 2001, question: "Pick", options: ["A", "B"] }) });
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({ ok: true, result: { poll: { question: "Pick" } } });
    const paid = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendPoll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: 2001, question: "Pick", options: ["A", "B"], allow_paid_broadcast: true }) });
    expect(paid.status).toBe(400);
    const custom = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/setMessageReaction`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: 2001, message_id: 1, reaction: [{ type: "custom_emoji", custom_emoji_id: "1" }] }) });
    expect(custom.status).toBe(400);
  });
  it("persists pins by chat and enforces user pin authority", () => {
    const { domain } = fresh();
    const alice = domain.sendMessage({ kind: "user", account: "alice" }, { chat_id: 2001, text: "mine" });
    domain.pinChatMessage({ kind: "user", account: "alice" }, { chat_id: 2001, message_id: alice.message_id as number });
    expect(domain.getPinnedMessages("alice", { chat_id: 2001 })).toHaveLength(1);
    domain.sendMessage({ kind: "user", account: "bob" }, { chat_id: GROUP, text: "bob" });
    expect(() => domain.pinChatMessage({ kind: "user", account: "alice" }, { chat_id: GROUP, message_id: 1 })).toThrow(/rights/);
    domain.pinChatMessage(BOT, { chat_id: GROUP, message_id: 1 });
    expect(domain.getPinnedMessages("alice", { chat_id: GROUP })).toHaveLength(1);
    expect(domain.getPinnedMessages("alice", { chat_id: 2001 })).toHaveLength(1);
  });

  it("stores inline callbacks separately, rejects byte-overflow, and allows exactly one answer", () => {
    let now = 1_700_000_000;
    const { domain } = fresh(() => now);
    const sent = domain.sendMessage(BOT, {
      chat_id: 2001,
      text: "choose",
      reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
    });
    const pressed = domain.pressInlineButton("alice", { chat_id: 2001, message_id: sent.message_id as number, callback_data: "go" });
    expect(domain.getUpdates(BOT, { allowed_updates: ["callback_query"] })[0]).toMatchObject({ callback_query: { id: pressed.callback_query_id, data: "go" } });
    expect(domain.answerCallbackQuery(BOT, { callback_query_id: pressed.callback_query_id })).toEqual({ ok: true });
    expect(() => domain.answerCallbackQuery(BOT, { callback_query_id: pressed.callback_query_id })).toThrow(/too old/);
    const again = domain.pressInlineButton("alice", { chat_id: 2001, message_id: 1, callback_data: "go" });
    now += CALLBACK_QUERY_TTL_SEC + 1;
    expect(() => domain.answerCallbackQuery(BOT, { callback_query_id: again.callback_query_id })).toThrow(/too old/);
    expect(() => domain.sendMessage(BOT, { chat_id: 2001, text: "bad", reply_markup: { inline_keyboard: [[{ text: "x", callback_data: "é".repeat(33) }]] } })).toThrow(/too long/);
  });

  it("waits for a concurrent bot callback answer without a database transaction held open", async () => {
    const { domain } = fresh();
    domain.sendMessage(BOT, { chat_id: 2001, text: "choose", reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] } });
    const pressed = domain.pressInlineButton("alice", { chat_id: 2001, message_id: 1, callback_data: "go" });
    const waiting = domain.waitForCallbackAnswer(pressed.callback_query_id, 1);
    await Promise.resolve();
    expect(domain.answerCallbackQuery(BOT, { callback_query_id: pressed.callback_query_id })).toEqual({ ok: true });
    await expect(waiting).resolves.toEqual({ callback_query_id: pressed.callback_query_id, answered: true });
  });

  it("turns reply keyboard taps into user messages and removes markup", () => {
    const { domain } = fresh();
    const sent = domain.sendMessage(BOT, { chat_id: 2001, text: "reply", reply_markup: { keyboard: [["yes"]] } });
    const reply = domain.pressReplyKeyboard("alice", { chat_id: 2001, message_id: sent.message_id as number, text: "yes" });
    expect(reply.text).toBe("yes");
    expect(domain.getUpdates(BOT, { allowed_updates: ["callback_query"] })[0]).toMatchObject({ message: { text: "yes" } });
    domain.editMessageReplyMarkup(BOT, { chat_id: 2001, message_id: 1, reply_markup: null });
    expect(() => domain.pressReplyKeyboard("alice", { chat_id: 2001, message_id: 1, text: "yes" })).toThrow(/not found/);
  });

  it("isolates reactions and polls to their owning bot and handles vote changes and closure", () => {
    const { domain } = fresh();
    const first = domain.sendMessage(BOT, { chat_id: 2001, text: "reaction" });
    domain.setMessageReaction({ kind: "user", account: "alice" }, { chat_id: 2001, message_id: first.message_id as number, reaction: [{ type: "emoji", emoji: "👍" }] });
    expect(domain.getUpdates(BOT, { allowed_updates: ["message_reaction"] })).toHaveLength(1);
    expect(domain.getMessageReactions("alice", { chat_id: 2001, message_id: 1 })).toMatchObject([{ reaction: { emoji: "👍" } }]);
    const poll = domain.sendPoll(BOT, { chat_id: GROUP, question: "Pick", options: ["A", "B"], is_anonymous: true });
    const messageId = (poll as { message_id: number }).message_id;
    // sendPoll returns the message shape with a poll after persistence.
    domain.votePoll("alice", { chat_id: GROUP, message_id: messageId, option_ids: [0] });
    const changed = domain.votePoll("alice", { chat_id: GROUP, message_id: messageId, option_ids: [1] }) as { options: Array<{ voter_count: number }>; recent_voters?: unknown[] };
    expect(changed.options.map((option) => option.voter_count)).toEqual([0, 1]);
    expect(changed.recent_voters).toBeUndefined();
    const visiblePoll = domain.sendPoll(BOT, { chat_id: GROUP, question: "Visible", options: ["A", "B"], is_anonymous: false });
    const visibleVote = domain.votePoll("alice", { chat_id: GROUP, message_id: visiblePoll.message_id as number, option_ids: [0] }) as { recent_voters?: Array<{ username: string }> };
    expect(visibleVote.recent_voters).toEqual([expect.objectContaining({ username: "alice" })]);
    domain.stopPoll(BOT, { chat_id: GROUP, message_id: messageId });
    expect(() => domain.votePoll("alice", { chat_id: GROUP, message_id: messageId, option_ids: [0] })).toThrow(/closed/);
  });
});
