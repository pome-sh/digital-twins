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
const EXPOSED = [
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
] as const;

const MEMBERSHIP_SLICE_RULING =
  "Not modeled by the twin's current user-MCP membership slice; this fixture serves group create/invite/leave, participant and admin reads, title/about/photo edits, promote/demote/ban/unban_user/remove, default permissions, slow mode, edit_admin_rights, get_banned_users, and the admin log. Channels and invite-link joins stay dropped.";

/** Source registrations deliberately not exposed by this twin, with a ruling per name. */
const DROPPED: Record<string, string> = {
  "list_contacts": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "search_contacts": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_contact_ids": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_direct_chat_by_contact": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_contact_chats": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_last_interaction": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "add_contact": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "delete_contact": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "block_user": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "unblock_user": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "import_contacts": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "export_contacts": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_blocked_users": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "send_contact": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "set_contact_alias": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "list_contact_aliases": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "delete_contact_alias": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_chats": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "subscribe_public_channel": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "list_topics": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "enable_forum_topics": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "create_forum_topic": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "list_chats": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_chat": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "search_public_chats": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "resolve_username": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_full_chat": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "mute_chat": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "unmute_chat": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "archive_chat": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "unarchive_chat": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_common_chats": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_message_read_by": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_message_link": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_messages": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "send_message": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "send_scheduled_message": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_scheduled_messages": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "delete_scheduled_message": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",

  "list_messages": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "transcribe_voice": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_message_context": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_send_as": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "forward_message": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "forward_messages": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "edit_message": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "delete_message": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "delete_chat_history": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "delete_messages_bulk": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",

  "mark_as_read": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "reply_to_message": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "search_messages": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "search_global": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_history": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",

  "save_draft": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_drafts": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "clear_draft": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "create_channel": MEMBERSHIP_SLICE_RULING,
  "get_invite_link": MEMBERSHIP_SLICE_RULING,
  "join_chat_by_link": MEMBERSHIP_SLICE_RULING,
  "export_chat_invite": MEMBERSHIP_SLICE_RULING,
  "import_chat_invite": MEMBERSHIP_SLICE_RULING,
  "send_album": "Not modeled by the twin's current user-MCP media slice; albums, host uploads, GIFs, and photo-browser rows stay dropped. This fixture serves get_media_info, download_media, send_file, send_voice, send_sticker, and get_sticker_sets over the existing SQLite media store.",
  "upload_file": "Not modeled by the twin's current user-MCP media slice; albums, host uploads, GIFs, and photo-browser rows stay dropped. This fixture serves get_media_info, download_media, send_file, send_voice, send_sticker, and get_sticker_sets over the existing SQLite media store.",
  "get_gif_search": "Not modeled by the twin's current user-MCP media slice; albums, host uploads, GIFs, and photo-browser rows stay dropped. This fixture serves get_media_info, download_media, send_file, send_voice, send_sticker, and get_sticker_sets over the existing SQLite media store.",
  "send_gif": "Not modeled by the twin's current user-MCP media slice; albums, host uploads, GIFs, and photo-browser rows stay dropped. This fixture serves get_media_info, download_media, send_file, send_voice, send_sticker, and get_sticker_sets over the existing SQLite media store.",
  "list_photos": "Not modeled by the twin's current user-MCP media slice; albums, host uploads, GIFs, and photo-browser rows stay dropped. This fixture serves get_media_info, download_media, send_file, send_voice, send_sticker, and get_sticker_sets over the existing SQLite media store.",
  "open_photo": "Not modeled by the twin's current user-MCP media slice; albums, host uploads, GIFs, and photo-browser rows stay dropped. This fixture serves get_media_info, download_media, send_file, send_voice, send_sticker, and get_sticker_sets over the existing SQLite media store.",
  "get_photo_sheet": "Not modeled by the twin's current user-MCP media slice; albums, host uploads, GIFs, and photo-browser rows stay dropped. This fixture serves get_media_info, download_media, send_file, send_voice, send_sticker, and get_sticker_sets over the existing SQLite media store.",
  "update_profile": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "set_profile_photo": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "delete_profile_photo": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_privacy_settings": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "set_privacy_settings": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_full_user": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_bot_info": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "set_bot_commands": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_user_photos": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_user_status": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "list_folders": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "get_folder": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "create_folder": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "add_chat_to_folder": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "remove_chat_from_folder": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "delete_folder": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "reorder_folders": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "wait_for_new_message": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "wait_for_settled_message": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "enable_incoming_feed": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "disable_incoming_feed": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
  "incoming_feed_status": "Not modeled by the twin's current user-MCP interaction slice; this fixture serves only its account, pin, regular-poll, standard-emoji-reaction, and inline-callback source rows.",
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
    derivation: "Subtract-only projection of the approved oss-source capture. Account lookup, interaction rows, media rows over the existing SQLite store, and the membership/moderation rows (create_group through get_recent_actions) are carried verbatim; every other registration is named in projection.dropped.",
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
