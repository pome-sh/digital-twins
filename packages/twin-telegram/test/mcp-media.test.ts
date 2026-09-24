// SPDX-License-Identifier: Apache-2.0
import { createRecorderStore } from "@pome-sh/sdk/server";
import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSeedState, SYNTHETIC_BOT_TOKEN } from "../src/seed.js";
import { telegramMcpToolFixture } from "../src/tools.js";
import { createTelegramTwinApp } from "../src/twin.js";

const secret = "telegram-mcp-media-test-secret";
const sid = "telegram-mcp-media";
const previousSecret = process.env.TWIN_AUTH_SECRET;
const OTHER_BOT_TOKEN = "1100002:BBHBBBBBBBBBBBBBBBBBBBBB";
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
    result: { isError?: boolean; content?: Array<{ text: string }>; structuredContent?: { result?: string } };
  };
}

function resultText(body: Awaited<ReturnType<typeof call>>): string {
  expect(body.result.isError).not.toBe(true);
  expect(body.result.structuredContent?.result).toEqual(expect.any(String));
  return body.result.structuredContent!.result!;
}

function twoBotSeed() {
  const seed = defaultSeedState();
  seed.bots.push({ id: 1100002, token: OTHER_BOT_TOKEN, first_name: "Y", username: "y_bot" });
  seed.chats[1]!.members.push(1100002);
  return seed;
}

describe("Telegram MCP media projection", () => {
  it("lets Alice download the exact bytes a bot uploaded over HTTP", async () => {
    const recorder = createRecorderStore();
    const app = createTelegramTwinApp({ seed: defaultSeedState(), recorder, runId: "telegram-mcp-media" });
    const bytes = Buffer.from("bot-x-owned-bytes\n");
    const upload = new FormData();
    upload.set("chat_id", "2001");
    upload.set("document", new Blob([bytes], { type: "text/plain" }), "report.txt");
    const sent = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendDocument`, { method: "POST", body: upload });
    expect(sent.status).toBe(200);
    const message = (await sent.json()) as { result: { message_id: number; document: { file_id: string; file_size: number } } };

    const info = JSON.parse(resultText(await call(app, aliceToken, "get_media_info", {
      chat_id: "2001",
      message_id: message.result.message_id,
    }))) as { kind: string; file_id: string; file_size: number };
    expect(info).toMatchObject({
      kind: "document",
      file_id: message.result.document.file_id,
      file_size: bytes.length,
    });

    const downloaded = JSON.parse(resultText(await call(app, aliceToken, "download_media", {
      chat_id: 2001,
      message_id: message.result.message_id,
    }))) as { file_id: string; content_base64: string };
    expect(downloaded.file_id).toBe(info.file_id);
    expect(Buffer.from(downloaded.content_base64, "base64").equals(bytes)).toBe(true);
    expect(JSON.stringify(recorder.events())).not.toContain(SYNTHETIC_BOT_TOKEN);
  });

  it("refuses private media, foreign accounts, and unsafe file references", async () => {
    const app = createTelegramTwinApp({ seed: defaultSeedState() });
    const bytes = Buffer.from("alice-private\n");
    const upload = new FormData();
    upload.set("chat_id", "2001");
    upload.set("document", new Blob([bytes], { type: "text/plain" }), "secret.txt");
    const sent = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendDocument`, { method: "POST", body: upload });
    const message = (await sent.json()) as { result: { message_id: number; document: { file_id: string; file_unique_id: string } } };

    expect((await call(app, bobToken, "download_media", {
      chat_id: 2001,
      message_id: message.result.message_id,
    })).result.isError).toBe(true);
    expect((await call(app, aliceToken, "get_media_info", {
      chat_id: 2001,
      message_id: message.result.message_id,
      account: "bob",
    })).result.isError).toBe(true);

    for (const file_path of [
      message.result.document.file_id,
      message.result.document.file_unique_id,
      "https://example.test/file.bin",
      "/etc/passwd",
      "../secret.txt",
    ]) {
      expect((await call(app, aliceToken, "send_file", { chat_id: 2001, file_path })).result.isError).toBe(true);
    }
    for (const file_path of ["out.bin", "https://example.test/out.bin", "/tmp/out.bin"]) {
      const denied = await call(app, aliceToken, "download_media", {
        chat_id: 2001,
        message_id: message.result.message_id,
        file_path,
      });
      expect(denied.result.isError).toBe(true);
      expect(denied.result.content?.[0]?.text).toContain("destination file paths are unsupported");
    }
  });

  it("creates visible send_file and send_voice messages that the receiving bot can getFile", async () => {
    const seed = twoBotSeed();
    const app = createTelegramTwinApp({ seed });

    const fileMessage = JSON.parse(resultText(await call(app, aliceToken, "send_file", {
      chat_id: 2001,
      file_path: "sample.txt",
      caption: "fixture file",
    }))) as { message_id: number; document: { file_id: string }; caption: string };
    expect(fileMessage).toMatchObject({ caption: "fixture file" });
    expect(fileMessage.document.file_id).toMatch(/^file_/);
    expect((await call(app, aliceToken, "send_voice", {
      chat_id: 2001,
      file_path: fileMessage.document.file_id,
    })).result.isError).toBe(true);
    expect((await call(app, aliceToken, "send_sticker", {
      chat_id: 2001,
      file_path: fileMessage.document.file_id,
    })).result.isError).toBe(true);

    const voiceMessage = JSON.parse(resultText(await call(app, aliceToken, "send_voice", {
      chat_id: 2001,
      file_path: "voice.ogg",
    }))) as { message_id: number; voice: { file_id: string } };
    expect(voiceMessage.voice.file_id).toMatch(/^file_/);
    const voiceDownload = JSON.parse(resultText(await call(app, aliceToken, "download_media", {
      chat_id: 2001,
      message_id: voiceMessage.message_id,
    }))) as { content_base64: string };
    const voiceBytes = Buffer.from(voiceDownload.content_base64, "base64");
    expect(voiceBytes.subarray(0, 4).toString()).toBe("OggS");

    const updates = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeout: 0 }),
    });
    const updateBody = (await updates.json()) as { result: Array<{ message?: { message_id: number; document?: unknown; voice?: unknown } }> };
    expect(updateBody.result.some((update) => update.message?.message_id === fileMessage.message_id && update.message.document)).toBe(true);
    expect(updateBody.result.some((update) => update.message?.message_id === voiceMessage.message_id && update.message.voice)).toBe(true);

    const catalogBytes = Buffer.from("pome-telegram-fixture-file\n");
    const visible = JSON.parse(resultText(await call(app, aliceToken, "download_media", {
      chat_id: 2001,
      message_id: fileMessage.message_id,
    }))) as { content_base64: string };
    expect(Buffer.from(visible.content_base64, "base64").equals(catalogBytes)).toBe(true);

    const owned = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileMessage.document.file_id }),
    });
    expect(owned.status).toBe(200);
    const ownedBody = await owned.json() as { ok: boolean; result: { file_path: string; file_size: number } };
    expect(ownedBody).toMatchObject({ ok: true, result: { file_size: catalogBytes.length } });

    const foreign = await app.request(`/bot${OTHER_BOT_TOKEN}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileMessage.document.file_id }),
    });
    expect(foreign.status).toBe(400);
  });

  it("serves only the fixture sticker catalog and rejects unknown stickers", async () => {
    const app = createTelegramTwinApp({ seed: defaultSeedState() });
    const sets = JSON.parse(resultText(await call(app, aliceToken, "get_sticker_sets", {}))) as Array<{
      name: string;
      stickers: Array<{ file_path: string }>;
    }>;
    expect(sets).toEqual([
      expect.objectContaining({
        name: "pome_lab",
        stickers: [
          expect.objectContaining({ file_path: "pome_lab/wave.webp" }),
          expect.objectContaining({ file_path: "pome_lab/ok.webp" }),
        ],
      }),
    ]);
    const sent = JSON.parse(resultText(await call(app, aliceToken, "send_sticker", {
      chat_id: 2001,
      file_path: "pome_lab/wave.webp",
    }))) as { message_id: number; sticker: { file_id: string } };
    expect(sent.sticker.file_id).toMatch(/^file_/);
    const stickerDownload = JSON.parse(resultText(await call(app, aliceToken, "download_media", {
      chat_id: 2001,
      message_id: sent.message_id,
    }))) as { content_base64: string };
    const stickerBytes = Buffer.from(stickerDownload.content_base64, "base64");
    expect(stickerBytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(stickerBytes.includes(Buffer.from("WEBP"))).toBe(true);
    expect((await call(app, aliceToken, "send_sticker", {
      chat_id: 2001,
      file_path: "unknown/sticker.webp",
    })).result.isError).toBe(true);
  });

  it("lists the previous twelve tools plus the six media source rows", async () => {
    const app = createTelegramTwinApp({ seed: defaultSeedState() });
    const response = await app.request(`/s/${sid}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(telegramMcpToolFixture.toolNames);
    expect(telegramMcpToolFixture.toolNames).toEqual([
      "list_accounts",
      "get_me",
      "list_inline_buttons",
      "press_inline_button",
      "pin_message",
      "unpin_message",
      "unpin_all_messages",
      "get_pinned_messages",
      "create_poll",
      "send_reaction",
      "remove_reaction",
      "get_message_reactions",
      "get_media_info",
      "download_media",
      "send_file",
      "send_voice",
      "send_sticker",
      "get_sticker_sets",
    ]);
  });
});
