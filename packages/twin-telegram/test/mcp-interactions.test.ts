// SPDX-License-Identifier: Apache-2.0
import { createRecorderStore } from "@pome-sh/sdk/server";
import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLBACK_QUERY_TTL_SEC } from "../src/domain.js";
import { defaultSeedState, SYNTHETIC_BOT_TOKEN } from "../src/seed.js";
import { createTelegramTwinApp } from "../src/twin.js";

const secret = "telegram-mcp-interactions-test-secret";
const sid = "telegram-mcp-interactions";
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

describe("Telegram MCP interaction projection", () => {
  it("uses source rows for user-scoped pins, reactions, and regular polls with trace deltas", async () => {
    const recorder = createRecorderStore();
    const seed = defaultSeedState();
    seed.messages = [{ chat_id: 2001, message_id: 1, from_id: 2001, text: "target" }];
    const app = createTelegramTwinApp({ seed, recorder, runId: "telegram-mcp-interactions" });
    const sent = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: 2001, text: "target" }),
    });
    expect(sent.status).toBe(200);

    expect(JSON.parse(resultText(await call(app, aliceToken, "pin_message", { chat_id: "2001", message_id: 1 })))).toEqual({ ok: true });
    expect(JSON.parse(resultText(await call(app, aliceToken, "get_pinned_messages", { chat_id: 2001 })))).toMatchObject([{ message_id: 1, text: "target" }]);
    expect(JSON.parse(resultText(await call(app, aliceToken, "unpin_message", { chat_id: 2001, message_id: 1 })))).toEqual({ ok: true });
    await call(app, aliceToken, "pin_message", { chat_id: 2001, message_id: 1 });
    expect(JSON.parse(resultText(await call(app, aliceToken, "unpin_all_messages", { chat_id: 2001 })))).toEqual({ ok: true });

    expect(JSON.parse(resultText(await call(app, aliceToken, "send_reaction", { chat_id: 2001, message_id: 2, emoji: "👍" })))).toEqual({ ok: true });
    expect(JSON.parse(resultText(await call(app, aliceToken, "get_message_reactions", { chat_id: 2001, message_id: 2 })))).toMatchObject([{ user: { username: "alice" }, reaction: { emoji: "👍" } }]);
    expect(JSON.parse(resultText(await call(app, aliceToken, "remove_reaction", { chat_id: 2001, message_id: 2 })))).toEqual({ ok: true });

    const poll = JSON.parse(resultText(await call(app, aliceToken, "create_poll", {
      chat_id: 2001,
      question: "Pick one",
      options: ["A", "B"],
      multiple_choice: false,
      public_votes: true,
    }))) as { poll: { is_anonymous: boolean; allows_multiple_answers: boolean } };
    expect(poll.poll).toMatchObject({ is_anonymous: false, allows_multiple_answers: false });

    const events = recorder.events().filter((event) => event.tool !== undefined);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "pin_message", state_mutation: true, state_delta: expect.objectContaining({ after: expect.objectContaining({ pinned: true }) }) }),
      expect.objectContaining({ tool: "send_reaction", state_mutation: true, state_delta: expect.objectContaining({ after: expect.objectContaining({ reaction: "👍" }) }) }),
      expect.objectContaining({ tool: "create_poll", state_mutation: true, state_delta: expect.objectContaining({ after: expect.objectContaining({ mutations: expect.any(Array) }) }) }),
    ]));
  });

  it("operates HTTP-created inline callbacks, isolates sessions, and clears callback state on reset", async () => {
    let now = 1_700_000_000;
    const app = createTelegramTwinApp({ seed: defaultSeedState(), now: () => now });
    const sent = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: 2001,
        text: "choose",
        reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "go" }]] },
      }),
    });
    const message = (await sent.json()) as { result: { message_id: number } };

    expect(JSON.parse(resultText(await call(app, aliceToken, "list_inline_buttons", {
      chat_id: "2001",
      message_id: String(message.result.message_id),
    })))).toEqual([{ text: "Go", callback_data: "go" }]);
    const pressed = JSON.parse(resultText(await call(app, aliceToken, "press_inline_button", {
      chat_id: 2001,
      message_id: message.result.message_id,
      button_text: "go",
    }))) as { callback_query_id: string };
    expect(pressed.callback_query_id).toMatch(/^cb:/);

    const foreign = await call(app, bobToken, "press_inline_button", {
      chat_id: 2001,
      message_id: message.result.message_id,
      button_index: 0,
    });
    expect(foreign.result.isError).toBe(true);
    const overridden = await call(app, aliceToken, "get_pinned_messages", { chat_id: 2001, account: "bob" });
    expect(overridden.result.isError).toBe(true);

    now += CALLBACK_QUERY_TTL_SEC;
    const expired = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: pressed.callback_query_id }),
    });
    expect(expired.status).toBe(400);

    const fresh = JSON.parse(resultText(await call(app, aliceToken, "press_inline_button", {
      chat_id: 2001,
      message_id: message.result.message_id,
      button_index: 0,
    }))) as { callback_query_id: string };
    expect((await app.request("/admin/reset", { method: "POST" })).status).toBe(200);
    const cancelled = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: fresh.callback_query_id }),
    });
    expect(cancelled.status).toBe(400);
  });
});
