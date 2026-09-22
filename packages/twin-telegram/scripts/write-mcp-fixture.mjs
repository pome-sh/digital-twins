#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveCanonicalMcpToolListing } from "@pome-sh/sdk/mcp-tool-fixture";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "fixtures");
mkdirSync(fixtures, { recursive: true });

const tools = [
  { name: "get_me", description: "The signed-in user.", inputSchema: { type: "object", properties: { account: { type: "string" } } } },
  { name: "list_accounts", description: "Named accounts in this twin.", inputSchema: { type: "object", properties: {} } },
  { name: "_manifest", description: "Staged tool listing.", inputSchema: { type: "object", properties: {} } },
  { name: "list_chats", description: "Chats visible to an account.", inputSchema: { type: "object", properties: { account: { type: "string" } } } },
  { name: "get_chat", description: "One chat.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" } }, required: ["chat_id"] } },
  { name: "get_history", description: "Messages in a chat.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" } }, required: ["chat_id"] } },
  { name: "send_message", description: "Send text to a chat.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, text: { type: "string" } }, required: ["chat_id", "text"] } },
  { name: "reply_to_message", description: "Reply to a message.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" }, text: { type: "string" } }, required: ["chat_id", "message_id", "text"] } },
  { name: "get_messages", description: "Context window around a message.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" }, limit: { type: "integer" } }, required: ["chat_id", "message_id"] } },
  { name: "search_messages", description: "Search one chat.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, query: { type: "string" } }, required: ["chat_id", "query"] } },
  { name: "search_global", description: "Search account-visible chats.", inputSchema: { type: "object", properties: { account: { type: "string" }, query: { type: "string" } }, required: ["query"] } },
  { name: "edit_message", description: "Edit a message the account authored.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" }, text: { type: "string" } }, required: ["chat_id", "message_id", "text"] } },
  { name: "delete_message", description: "Revoke own message or hide another locally.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" }, revoke: { type: "boolean" } }, required: ["chat_id", "message_id"] } },
  { name: "forward_message", description: "Forward a message, keeping attribution.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, from_chat_id: { type: "integer" }, message_id: { type: "integer" } }, required: ["chat_id", "from_chat_id", "message_id"] } },
  { name: "get_message_context", description: "Context window around a message.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" }, limit: { type: "integer" } }, required: ["chat_id", "message_id"] } },
  { name: "message_from_link", description: "Resolve a tg://message?chat_id=&message_id= link this twin emitted.", inputSchema: { type: "object", properties: { account: { type: "string" }, link: { type: "string" } }, required: ["link"] } },
  { name: "get_message_link", description: "Build a tg:// link for a seeded message.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" } }, required: ["chat_id", "message_id"] } },
  { name: "mark_as_read", description: "Advance the account read cursor.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" } }, required: ["chat_id", "message_id"] } },
  { name: "get_message_viewers", description: "Accounts whose read cursor passed a message.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" } }, required: ["chat_id", "message_id"] } },
  { name: "pin_message", description: "Pin an eligible message.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" } }, required: ["chat_id", "message_id"] } },
  { name: "unpin_message", description: "Unpin an eligible message.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" } }, required: ["chat_id"] } },
  { name: "get_pinned_messages", description: "List pinned messages in a chat.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" } }, required: ["chat_id"] } },
  { name: "send_reaction", description: "React to a message with one standard emoji.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" }, emoji: { type: "string" } }, required: ["chat_id", "message_id", "emoji"] } },
  { name: "remove_reaction", description: "Remove the caller's reaction.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" } }, required: ["chat_id", "message_id"] } },
  { name: "get_message_reactions", description: "List supported message reactions.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" } }, required: ["chat_id", "message_id"] } },
  { name: "create_poll", description: "Create a regular poll.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, question: { type: "string" }, options: { type: "array", items: { type: "string" } }, is_anonymous: { type: "boolean" }, allows_multiple_answers: { type: "boolean" } }, required: ["chat_id", "question", "options"] } },
  { name: "vote_poll", description: "Vote for poll options.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" }, option_ids: { type: "array", items: { type: "integer" } } }, required: ["chat_id", "message_id", "option_ids"] } },
  { name: "close_poll", description: "Close a poll authored by the caller.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" } }, required: ["chat_id", "message_id"] } },
  { name: "list_inline_buttons", description: "List callback buttons on a message.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" } }, required: ["chat_id", "message_id"] } },
  { name: "press_inline_button", description: "Press an inline callback button.", inputSchema: { type: "object", properties: { account: { type: "string" }, chat_id: { type: "integer" }, message_id: { type: "integer" }, callback_data: { type: "string" }, timeout: { type: "number" } }, required: ["chat_id", "message_id", "callback_data"] } },
];

const raw = { jsonrpc: "2.0", id: 1, result: { tools } };
const rawBytes = JSON.stringify(raw);
const rawHash = createHash("sha256").update(rawBytes, "utf8").digest("hex");

const meta = {
  twin: "telegram",
  substrate: "twin-authored-from-vendor-docs",
  endpoint: "in-process://twin-telegram/s/:sid/mcp",
  method: "tools/list",
  protocol: "JSON-RPC 2.0 over Streamable HTTP",
  protocolVersion: "2025-06-18",
  captureDate: "2026-09-21",
  rawFileSha256: rawHash,
  canonicalFileSha256: "0".repeat(64),
  liveToolCount: tools.length,
  liveToolOrder: tools.map((tool) => tool.name),
  transcription: {
    readFrom: "T04 spine tool names from the Telegram operation-ownership matrix and Tolboy's published names",
    contentOrigin: "packages/twin-telegram/src/tools.ts — twin-authored schemas, not a vendor capture",
    comparedToUpstream: "never compared. Capture is deferred until a two-account listing exists.",
  },
  notes: ["Not a vendor golden. Do not treat these schemas as Tolboy wire."],
  files: { raw: "mcp-tools-list.raw.json", canonical: "mcp-tools-list.canonical.json" },
};

const canonical = deriveCanonicalMcpToolListing({ raw, meta });
meta.canonicalFileSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
const canonicalFinal = deriveCanonicalMcpToolListing({ raw, meta });

writeFileSync(join(fixtures, "mcp-tools-list.raw.json"), rawBytes);
writeFileSync(join(fixtures, "mcp-tools-list.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
writeFileSync(join(fixtures, "mcp-tools-list.canonical.json"), canonicalFinal);
console.log("wrote fixtures", meta.rawFileSha256, meta.canonicalFileSha256);
