// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveCanonicalMcpToolListing } from "@pome-sh/sdk";
import { telegramToolFixture } from "../src/tools.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

function read(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

describe("telegram MCP fixture", () => {
  it("raw bytes match the declared sha", () => {
    const raw = JSON.parse(read("mcp-tools-list.raw.json")) as unknown;
    expect(createHash("sha256").update(JSON.stringify(raw), "utf8").digest("hex")).toBe(
      telegramToolFixture.meta.rawFileSha256,
    );
  });

  it("canonical file is derived", () => {
    const raw = JSON.parse(read("mcp-tools-list.raw.json")) as unknown;
    const meta = JSON.parse(read("mcp-tools-list.meta.json")) as unknown;
    expect(read("mcp-tools-list.canonical.json")).toBe(deriveCanonicalMcpToolListing({ raw, meta }));
  });

  it("serves the staged conversation and history tools", () => {
    expect([...telegramToolFixture.toolNames]).toEqual([
      "get_me",
      "list_accounts",
      "_manifest",
      "list_chats",
      "get_chat",
      "get_history",
      "send_message",
      "reply_to_message",
      "get_messages",
      "search_messages",
      "search_global",
      "edit_message",
      "delete_message",
      "forward_message",
      "get_message_context",
      "message_from_link",
      "get_message_link",
      "mark_as_read",
      "get_message_viewers",
      "pin_message",
      "unpin_message",
      "get_pinned_messages",
      "send_reaction",
      "remove_reaction",
      "get_message_reactions",
      "create_poll",
      "vote_poll",
      "close_poll",
      "list_inline_buttons",
      "press_inline_button",
    ]);
  });
});
