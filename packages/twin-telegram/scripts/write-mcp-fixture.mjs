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
