// SPDX-License-Identifier: Apache-2.0
//
// Project the approved Telegram MCP source capture onto the operations this
// twin can actually execute. The source golden is generated from
// chigwell/telegram-mcp's pinned FastMCP registration runtime; this producer
// only subtracts named operations. It never writes a tool description or
// schema, so every served row remains the source runtime's row verbatim.
//
//   npx tsx scripts/adopt-upstream-mcp-fixture.ts            # write
//   npx tsx scripts/adopt-upstream-mcp-fixture.ts --check     # compare only

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveCanonicalMcpToolListing } from "@pome-sh/sdk";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const UPSTREAM = join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list");
const RAW = "mcp-tools-list.raw.json";
const META = "mcp-tools-list.meta.json";
const CANONICAL = "mcp-tools-list.canonical.json";
const SOURCE_FIXTURE = "fixtures/mcp-tools-list/telegram.raw.json";
const PRODUCER =
  "packages/twin-telegram/scripts/adopt-upstream-mcp-fixture.ts — re-derive and diff with " +
  "\`npm run gate:mcp-fixture -w @pome-sh/twin-telegram\`";

/**
 * The only source operations this twin can serve without widening this change.
 * They accept exactly the source input surface and return the source's string
 * result envelope. All other registered operations are explicitly dropped.
 */
const EXPOSED = ["list_accounts", "get_me"] as const;

/** Source registrations deliberately not exposed by this twin, with a ruling per name. */
const DROPPED: Record<string, string> = {
  "list_contacts": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "search_contacts": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_contact_ids": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_direct_chat_by_contact": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_contact_chats": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_last_interaction": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "add_contact": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "delete_contact": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "block_user": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "unblock_user": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "import_contacts": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "export_contacts": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_blocked_users": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "send_contact": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "set_contact_alias": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "list_contact_aliases": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "delete_contact_alias": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_chats": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "subscribe_public_channel": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "list_topics": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "enable_forum_topics": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "create_forum_topic": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "list_chats": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_chat": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "search_public_chats": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "resolve_username": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_full_chat": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "mute_chat": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "unmute_chat": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "archive_chat": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "unarchive_chat": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_common_chats": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_message_read_by": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_message_link": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_messages": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "send_message": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "send_scheduled_message": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_scheduled_messages": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "delete_scheduled_message": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "list_inline_buttons": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "press_inline_button": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "list_messages": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "transcribe_voice": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_message_context": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_send_as": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "forward_message": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "forward_messages": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "edit_message": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "delete_message": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "delete_chat_history": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "delete_messages_bulk": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "pin_message": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "unpin_message": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "unpin_all_messages": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "mark_as_read": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "reply_to_message": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "search_messages": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "search_global": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_history": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_pinned_messages": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "create_poll": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "send_reaction": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "remove_reaction": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_message_reactions": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "save_draft": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_drafts": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "clear_draft": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "create_group": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "invite_to_group": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "leave_chat": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_participants": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "create_channel": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "edit_chat_title": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "edit_chat_photo": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "edit_chat_about": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "delete_chat_photo": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "promote_admin": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "demote_admin": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "ban_user": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "unban_user": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "remove_user": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "set_default_chat_permissions": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "toggle_slow_mode": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "edit_admin_rights": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_admins": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_banned_users": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_invite_link": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "join_chat_by_link": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "export_chat_invite": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "import_chat_invite": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_recent_actions": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "send_file": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "send_album": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "download_media": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "send_voice": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "upload_file": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_media_info": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_sticker_sets": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "send_sticker": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_gif_search": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "send_gif": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "list_photos": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "open_photo": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_photo_sheet": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "update_profile": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "set_profile_photo": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "delete_profile_photo": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_privacy_settings": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "set_privacy_settings": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_full_user": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_bot_info": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "set_bot_commands": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_user_photos": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_user_status": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "list_folders": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "get_folder": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "create_folder": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "add_chat_to_folder": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "remove_chat_from_folder": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "delete_folder": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "reorder_folders": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "wait_for_new_message": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "wait_for_settled_message": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "enable_incoming_feed": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "disable_incoming_feed": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
  "incoming_feed_status": "Not modeled by the twin's current user-MCP slice; this fixture deliberately serves only list_accounts and get_me, whose source schemas and behavior it can fulfill.",
};

type ToolRow = { name: string } & Record<string, unknown>;
type Envelope = { jsonrpc: string; id: number | string; result: { tools: ToolRow[] } };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const check = process.argv.includes("--check");
const read = (path: string) => readFileSync(path, "utf8");

const upstreamRawText = read(join(UPSTREAM, "telegram.raw.json"));
const upstreamMeta = JSON.parse(read(join(UPSTREAM, "telegram.meta.json"))) as {
  rawFileSha256: string;
  captureDate: string;
  substrate: string;
  endpoint: string;
  method: string;
  protocol: string;
  protocolVersion: string;
  configuration: Record<string, unknown>;
  source: { commit: string };
};
if (sha256(upstreamRawText) !== upstreamMeta.rawFileSha256) {
  throw new Error("Telegram source golden does not match its declared raw digest; re-capture before projecting it.");
}

const upstream = JSON.parse(upstreamRawText) as Envelope;
const rows = new Map(upstream.result.tools.map((tool) => [tool.name, tool]));
const expected = new Set([...EXPOSED, ...Object.keys(DROPPED)]);
const actual = new Set(rows.keys());
for (const name of expected) if (!actual.has(name)) throw new Error(`Projection names '${name}' absent from source capture. Retire its ruling or re-capture.`);
for (const name of actual) if (!expected.has(name)) throw new Error(`Source capture gained '${name}' without an exposure or subtraction ruling.`);

const tools = EXPOSED.map((name) => rows.get(name)!);
const raw = JSON.stringify({ jsonrpc: upstream.jsonrpc, id: upstream.id, result: { tools } });
const projection = {
  sourceFixture: SOURCE_FIXTURE,
  sourceRawFileSha256: upstreamMeta.rawFileSha256,
  sourceCaptureDate: upstreamMeta.captureDate,
  sourceSubstrate: upstreamMeta.substrate,
  sourceCommit: upstreamMeta.source.commit,
  producer: PRODUCER,
  dropped: DROPPED,
  carried: {},
};
const meta = {
  twin: "telegram",
  substrate: "upstream-capture-projection",
  endpoint: upstreamMeta.endpoint,
  method: upstreamMeta.method,
  protocol: upstreamMeta.protocol,
  protocolVersion: upstreamMeta.protocolVersion,
  captureDate: upstreamMeta.captureDate,
  rawFileSha256: sha256(raw),
  canonicalFileSha256: "0".repeat(64),
  liveToolCount: tools.length,
  liveToolOrder: tools.map((tool) => tool.name),
  configuration: {
    derivation: "Subtract-only projection of the approved oss-source capture. list_accounts and get_me are the only source rows this twin currently fulfills; every other registration is named in projection.dropped.",
    sourceConfiguration: upstreamMeta.configuration,
  },
  projection,
  files: { raw: RAW, canonical: CANONICAL },
};
const canonical = deriveCanonicalMcpToolListing({ raw: JSON.parse(raw), meta });
meta.canonicalFileSha256 = sha256(canonical);
const metaText = `${JSON.stringify(meta, null, 2)}\n`;

const derived = new Map([[RAW, raw], [META, metaText], [CANONICAL, canonical]]);
if (check) {
  const drift = [...derived].filter(([name, value]) => read(join(FIXTURES, name)) !== value).map(([name]) => name);
  if (drift.length > 0) {
    console.error(`[adopt-upstream-mcp-fixture] ${drift.join(", ")} differ from the approved source projection`);
    process.exit(1);
  }
  console.log(`[adopt-upstream-mcp-fixture] ${tools.length} tools, source capture minus ${Object.keys(DROPPED).length} ruled operations`);
} else {
  for (const [name, value] of derived) writeFileSync(join(FIXTURES, name), value);
  console.log(`[adopt-upstream-mcp-fixture] wrote ${tools.length} source-derived tools`);
}
