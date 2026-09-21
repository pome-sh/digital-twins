#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Completeness of config/telegram-operation-ownership.json. A missing or
// double-claimed name is the failure this file exists to catch.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(join(ROOT, "config/telegram-operation-ownership.json"), "utf8");
const table = JSON.parse(raw);

/** Top-level keys of `"property": { ... }` as written, including duplicates JSON.parse would drop. */
function keysOf(text, property) {
  const match = text.match(new RegExp(`"${property}": \\{\\n([\\s\\S]*?)\\n  \\}`));
  if (!match) throw new Error(`missing object ${property}`);
  return [...match[1].matchAll(/^    "([^"]+)":/gm)].map((item) => item[1]);
}

function unique(keys, label) {
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) return `${label}: duplicate key ${key}`;
    seen.add(key);
  }
  return null;
}

const METHODS = [
  "answerCallbackQuery",
  "approveChatJoinRequest",
  "banChatMember",
  "closeForumTopic",
  "copyMessage",
  "createChatInviteLink",
  "createForumTopic",
  "declineChatJoinRequest",
  "deleteForumTopic",
  "deleteMessage",
  "deleteMessages",
  "deleteMyCommands",
  "deleteWebhook",
  "editChatInviteLink",
  "editForumTopic",
  "editMessageCaption",
  "editMessageReplyMarkup",
  "editMessageText",
  "forwardMessage",
  "getChat",
  "getChatAdministrators",
  "getChatMember",
  "getChatMemberCount",
  "getFile",
  "getMe",
  "getMyCommands",
  "getUpdates",
  "getUserProfilePhotos",
  "getWebhookInfo",
  "leaveChat",
  "pinChatMessage",
  "promoteChatMember",
  "reopenForumTopic",
  "restrictChatMember",
  "revokeChatInviteLink",
  "sendAudio",
  "sendChatAction",
  "sendDocument",
  "sendMediaGroup",
  "sendMessage",
  "sendPhoto",
  "sendPoll",
  "sendVideo",
  "sendVoice",
  "setChatDescription",
  "setChatPermissions",
  "setChatTitle",
  "setMessageReaction",
  "setMyCommands",
  "setWebhook",
  "stopPoll",
  "unbanChatMember",
  "unpinAllChatMessages",
  "unpinChatMessage",
];

const TOOLS = [
  "_manifest",
  "add_contact",
  "archive_chat",
  "ban_user",
  "block_user",
  "cancel_scheduled_message",
  "clear_draft",
  "close_forum_topic",
  "close_poll",
  "configure_chat_folder",
  "create_channel",
  "create_group",
  "create_poll",
  "create_supergroup",
  "create_topic",
  "delete_chat_folder",
  "delete_chat_photo",
  "delete_contact",
  "delete_message",
  "delete_profile_photo",
  "demote_admin",
  "download_media",
  "edit_chat_photo",
  "edit_chat_title",
  "edit_forum_topic",
  "edit_message",
  "forward_message",
  "get_admins",
  "get_banned_users",
  "get_blocked_users",
  "get_bot_commands",
  "get_chat",
  "get_chat_folder",
  "get_common_chats",
  "get_drafts",
  "get_group_permissions",
  "get_history",
  "get_invite_link",
  "get_last_interaction",
  "get_me",
  "get_media_info",
  "get_message_context",
  "get_message_link",
  "get_message_reactions",
  "get_message_viewers",
  "get_messages",
  "get_participants",
  "get_pinned_messages",
  "get_privacy_settings",
  "get_recent_actions",
  "get_sticker_sets",
  "get_user_photos",
  "get_user_status",
  "invite_to_group",
  "join_chat_by_link",
  "leave_chat",
  "list_accounts",
  "list_chats",
  "list_chat_folders",
  "list_contacts",
  "list_inline_buttons",
  "list_invite_links",
  "list_scheduled_messages",
  "list_topics",
  "mark_as_read",
  "message_from_link",
  "mute_chat",
  "pin_message",
  "press_inline_button",
  "promote_admin",
  "remove_reaction",
  "reorder_chat_folders",
  "reopen_forum_topic",
  "reply_to_message",
  "reschedule_message",
  "resolve_username",
  "revoke_invite_link",
  "save_draft",
  "schedule_message",
  "search_contacts",
  "search_global",
  "search_messages",
  "search_public_chats",
  "send_file",
  "send_message",
  "send_reaction",
  "send_sticker",
  "send_voice",
  "set_admin_rights",
  "set_bot_commands",
  "set_chat_description",
  "set_forum_topics_enabled",
  "set_group_permissions",
  "set_member_permissions",
  "set_privacy_settings",
  "set_profile_photo",
  "set_slow_mode",
  "subscribe_public_channel",
  "unarchive_chat",
  "unban_user",
  "unblock_user",
  "unmute_chat",
  "unpin_message",
  "update_profile",
  "vote_poll",
];

const EXCLUDED = [
  "discover_public_chats",
  "export_chat_history",
  "register_internal_chat",
  "search_public_messages",
  "transcribe_voice_note",
];

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error(`FAIL  ${msg}`);
}

function sameSet(actual, expected, label) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  assert(a.length === e.length, `${label}: expected ${e.length} names, got ${a.length}`);
  for (const name of e) assert(actual.has(name), `${label}: missing ${name}`);
  for (const name of a) assert(expected.includes(name), `${label}: unexpected ${name}`);
}

const slices = new Set(table.slices);
const methods = new Map(Object.entries(table.methods));
const tools = new Map(Object.entries(table.tools));
const excluded = new Map(Object.entries(table.excluded));

assert(
  unique(
    keysOf('{ "methods": {\n    "getMe": "conversation",\n    "getMe": "history"\n  } }', "methods"),
    "methods",
  ) === "methods: duplicate key getMe",
  "duplicate JSON keys fail before JSON.parse collapses them",
);
for (const property of ["methods", "tools", "excluded"]) {
  const clash = unique(keysOf(raw, property), property);
  assert(clash === null, clash ?? property);
}

assert(METHODS.length === 54, "frozen method list is 54 names");
assert(TOOLS.length === 105, "frozen tool list is 105 names");
assert(EXCLUDED.length === 5, "frozen exclusion list is 5 names");

sameSet(new Set(methods.keys()), METHODS, "methods");
sameSet(new Set(tools.keys()), TOOLS, "tools");
sameSet(new Set(excluded.keys()), EXCLUDED, "excluded");

for (const [name, slice] of [...methods, ...tools]) {
  assert(slices.has(slice), `${name}: unknown slice ${JSON.stringify(slice)}`);
}
for (const name of excluded.keys()) {
  assert(!tools.has(name), `excluded tool ${name} is also assigned`);
  assert(typeof table.excluded[name] === "string" && table.excluded[name].length > 0, `${name}: exclusion needs a reason`);
}

if (failures > 0) {
  console.error(`\ntelegram-operation-ownership.test.mjs: ${failures} failure(s)`);
  process.exit(1);
}
console.log("telegram-operation-ownership.test.mjs: all assertions passed");
