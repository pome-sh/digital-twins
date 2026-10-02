// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveCanonicalMcpToolListing, diffServedToolsAgainstFixture } from "@pome-sh/sdk";
import { defaultSeedState } from "../src/seed.js";
import { createTelegramTwinApp } from "../src/twin.js";
import { telegramMcpToolFixture } from "../src/tools.js";

const secret = "telegram-fixture-test-secret-32-characters";
const sid = "telegram-fixture-session";
const previousSecret = process.env.TWIN_AUTH_SECRET;
const fixtures = join(import.meta.dirname, "..", "fixtures");
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = secret;
  token = await sign(
    { sid, team_id: "tm_telegram", login: "alice", exp: Math.floor(Date.now() / 1000) + 3600 },
    secret,
  );
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const read = (name: string) => readFileSync(join(fixtures, name), "utf8");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function servedTools(): Promise<unknown> {
  const app = createTelegramTwinApp({ seed: defaultSeedState() });
  const response = await app.request(`/s/${sid}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result?: { tools?: unknown } };
  return body.result?.tools;
}

describe("Telegram MCP source fixture", () => {
  const meta = telegramMcpToolFixture.meta;

  it("hashes and canonically derives the source projection", () => {
    expect(sha256(read(meta.files.raw))).toBe(meta.rawFileSha256);
    const canonical = deriveCanonicalMcpToolListing({
      raw: JSON.parse(read(meta.files.raw)),
      meta: JSON.parse(read("mcp-tools-list.meta.json")),
    });
    expect(read(meta.files.canonical)).toBe(canonical);
    expect(sha256(canonical)).toBe(meta.canonicalFileSha256);
  });

  it("projects source rows byte-for-byte and names every omitted source tool", () => {
    const source = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list", "telegram.raw.json"), "utf8"),
    ) as { result: { tools: Array<{ name: string }> } };
    const sourceMeta = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list", "telegram.meta.json"), "utf8"),
    ) as { rawFileSha256: string };
    const rows = new Map(source.result.tools.map((tool) => [tool.name, tool]));

    expect(meta.substrate).toBe("upstream-capture-projection");
    expect(meta.projection?.sourceRawFileSha256).toBe(sourceMeta.rawFileSha256);
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
      "create_group",
      "invite_to_group",
      "leave_chat",
      "get_participants",
      "edit_chat_title",
      "edit_chat_about",
      "edit_chat_photo",
      "delete_chat_photo",
      "promote_admin",
      "demote_admin",
      "ban_user",
      "unban_user",
      "remove_user",
      "set_default_chat_permissions",
      "toggle_slow_mode",
      "edit_admin_rights",
      "get_admins",
      "get_banned_users",
      "get_recent_actions",
      "subscribe_public_channel",
      "list_topics",
      "enable_forum_topics",
      "create_forum_topic",
      "search_public_chats",
      "create_channel",
      "get_invite_link",
      "join_chat_by_link",
      "export_chat_invite",
      "import_chat_invite",
    ]);
    for (const tool of telegramMcpToolFixture.tools) expect(tool).toEqual(rows.get(tool.name));
    expect(Object.keys(meta.projection?.dropped ?? []).sort()).toEqual(
      source.result.tools.map((tool) => tool.name).filter((name) => !telegramMcpToolFixture.toolNames.includes(name)).sort(),
    );
  });

  it("serves exactly the fixture listing", async () => {
    expect(diffServedToolsAgainstFixture(await servedTools(), telegramMcpToolFixture)).toEqual([]);
  });

  it("returns the source string result envelope for account operations", async () => {
    const app = createTelegramTwinApp({ seed: defaultSeedState() });
    const response = await app.request(`/s/${sid}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_me", arguments: {} } }),
    });
    const body = (await response.json()) as { result?: { structuredContent?: { result?: string } }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result).toMatchObject({ structuredContent: { result: expect.any(String) } });
    expect(JSON.parse(body.result!.structuredContent!.result!)).toMatchObject({ id: 2001, username: "alice" });
  });

  it("lists seeded account profile names in the source text format", async () => {
    const app = createTelegramTwinApp({ seed: defaultSeedState() });
    const response = await app.request(`/s/${sid}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_accounts", arguments: {} } }),
    });
    const body = (await response.json()) as { result?: { structuredContent?: { result?: string } }; error?: unknown };

    expect(body.error).toBeUndefined();
    expect(body.result?.structuredContent?.result).toBe("alice: Alice (+N/A) — unknown\nbob: Bob (+N/A) — unknown");
  });
});
