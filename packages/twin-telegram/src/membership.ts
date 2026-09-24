// SPDX-License-Identifier: Apache-2.0
// Member restrictions, default chat permissions, and admin rights are distinct
// records. Ban / unban / leave / invite / remove are distinct transitions.

import { telegramFail } from "./errors.js";
import { serializeUser, type UserRow } from "./serializers.js";

export const SLOW_MODE_SECONDS = [0, 10, 30, 60, 300, 900, 3600] as const;
export const MAX_CHAT_TITLE = 128;
export const MAX_CHAT_ABOUT = 255;
export const MAX_ADMIN_TITLE = 16;
export const ADMIN_LOG_LIMIT = 100;

export type ChatPermissions = {
  can_send_messages: boolean;
  can_send_audios: boolean;
  can_send_documents: boolean;
  can_send_photos: boolean;
  can_send_videos: boolean;
  can_send_video_notes: boolean;
  can_send_voice_notes: boolean;
  can_send_polls: boolean;
  can_send_other_messages: boolean;
  can_add_web_page_previews: boolean;
  can_change_info: boolean;
  can_invite_users: boolean;
  can_pin_messages: boolean;
  can_manage_topics: boolean;
};

export type AdminRights = {
  is_anonymous: boolean;
  can_manage_chat: boolean;
  can_delete_messages: boolean;
  can_manage_video_chats: boolean;
  can_restrict_members: boolean;
  can_promote_members: boolean;
  can_change_info: boolean;
  can_invite_users: boolean;
  can_post_stories: boolean;
  can_edit_stories: boolean;
  can_delete_stories: boolean;
  can_post_messages: boolean;
  can_edit_messages: boolean;
  can_pin_messages: boolean;
  can_manage_topics: boolean;
};

export type MemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

export const DEFAULT_CHAT_PERMISSIONS: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: false,
  can_invite_users: true,
  can_pin_messages: false,
  can_manage_topics: false,
};

export const FULL_ADMIN_RIGHTS: AdminRights = {
  is_anonymous: false,
  can_manage_chat: true,
  can_delete_messages: true,
  can_manage_video_chats: true,
  can_restrict_members: true,
  can_promote_members: true,
  can_change_info: true,
  can_invite_users: true,
  can_post_stories: true,
  can_edit_stories: true,
  can_delete_stories: true,
  can_post_messages: true,
  can_edit_messages: true,
  can_pin_messages: true,
  can_manage_topics: true,
};

export const ZERO_ADMIN_RIGHTS: AdminRights = {
  is_anonymous: false,
  can_manage_chat: false,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_post_messages: false,
  can_edit_messages: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

export const DEFAULT_PROMOTE_RIGHTS: AdminRights = {
  ...FULL_ADMIN_RIGHTS,
  can_promote_members: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_post_messages: false,
  can_edit_messages: false,
};

const PERMISSION_KEYS = Object.keys(DEFAULT_CHAT_PERMISSIONS) as Array<keyof ChatPermissions>;
const ADMIN_KEYS = Object.keys(FULL_ADMIN_RIGHTS) as Array<keyof AdminRights>;

const PERMISSION_ALIASES: Record<string, keyof ChatPermissions> = {
  can_send_messages: "can_send_messages",
  send_messages: "can_send_messages",
  can_send_audios: "can_send_audios",
  can_send_documents: "can_send_documents",
  can_send_photos: "can_send_photos",
  can_send_videos: "can_send_videos",
  can_send_video_notes: "can_send_video_notes",
  can_send_voice_notes: "can_send_voice_notes",
  can_send_polls: "can_send_polls",
  send_polls: "can_send_polls",
  can_send_other_messages: "can_send_other_messages",
  send_media: "can_send_other_messages",
  send_stickers: "can_send_other_messages",
  send_gifs: "can_send_other_messages",
  send_games: "can_send_other_messages",
  send_inline: "can_send_other_messages",
  can_add_web_page_previews: "can_add_web_page_previews",
  embed_links: "can_add_web_page_previews",
  can_change_info: "can_change_info",
  change_info: "can_change_info",
  can_invite_users: "can_invite_users",
  invite_users: "can_invite_users",
  can_pin_messages: "can_pin_messages",
  pin_messages: "can_pin_messages",
  can_manage_topics: "can_manage_topics",
};

const ADMIN_ALIASES: Record<string, keyof AdminRights> = {
  is_anonymous: "is_anonymous",
  anonymous: "is_anonymous",
  can_manage_chat: "can_manage_chat",
  other: "can_manage_chat",
  can_delete_messages: "can_delete_messages",
  delete_messages: "can_delete_messages",
  can_manage_video_chats: "can_manage_video_chats",
  manage_call: "can_manage_video_chats",
  can_restrict_members: "can_restrict_members",
  ban_users: "can_restrict_members",
  can_promote_members: "can_promote_members",
  add_admins: "can_promote_members",
  can_change_info: "can_change_info",
  change_info: "can_change_info",
  can_invite_users: "can_invite_users",
  invite_users: "can_invite_users",
  can_post_stories: "can_post_stories",
  can_edit_stories: "can_edit_stories",
  can_delete_stories: "can_delete_stories",
  can_post_messages: "can_post_messages",
  post_messages: "can_post_messages",
  can_edit_messages: "can_edit_messages",
  edit_messages: "can_edit_messages",
  can_pin_messages: "can_pin_messages",
  pin_messages: "can_pin_messages",
  can_manage_topics: "can_manage_topics",
  manage_topics: "can_manage_topics",
};

export function parseChatPermissions(input: unknown, fallback: ChatPermissions = DEFAULT_CHAT_PERMISSIONS): ChatPermissions {
  if (input === undefined || input === null) return { ...fallback };
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      telegramFail(400, 400, "Bad Request: permissions is invalid");
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) telegramFail(400, 400, "Bad Request: permissions is invalid");
  const raw = input as Record<string, unknown>;
  const next = { ...fallback };
  if ("send_media" in raw && typeof raw.send_media === "boolean") {
    next.can_send_audios = raw.send_media;
    next.can_send_documents = raw.send_media;
    next.can_send_photos = raw.send_media;
    next.can_send_videos = raw.send_media;
    next.can_send_video_notes = raw.send_media;
    next.can_send_voice_notes = raw.send_media;
    next.can_send_other_messages = raw.send_media;
  }
  for (const [key, value] of Object.entries(raw)) {
    const mapped = PERMISSION_ALIASES[key];
    if (!mapped) continue;
    if (typeof value !== "boolean") telegramFail(400, 400, `Bad Request: ${key} must be a boolean`);
    next[mapped] = value;
  }
  return next;
}

export function parseAdminRights(input: unknown, fallback: AdminRights = DEFAULT_PROMOTE_RIGHTS): AdminRights {
  if (input === undefined || input === null) return { ...fallback };
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      telegramFail(400, 400, "Bad Request: rights are invalid");
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) telegramFail(400, 400, "Bad Request: rights are invalid");
  const next = { ...fallback };
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const mapped = ADMIN_ALIASES[key];
    if (!mapped) continue;
    if (typeof value !== "boolean") telegramFail(400, 400, `Bad Request: ${key} must be a boolean`);
    next[mapped] = value;
  }
  return next;
}

export function adminRightsFromFlags(flags: Partial<Record<keyof AdminRights, boolean | undefined>>, fallback: AdminRights = DEFAULT_PROMOTE_RIGHTS): AdminRights {
  const next = { ...fallback };
  for (const key of ADMIN_KEYS) {
    const value = flags[key];
    if (value !== undefined) next[key] = value;
  }
  return next;
}

export function noAdminRights(rights: AdminRights): boolean {
  return ADMIN_KEYS.every((key) => key === "is_anonymous" || rights[key] === false);
}

export function rightsSubset(granted: AdminRights, actor: AdminRights): boolean {
  return ADMIN_KEYS.every((key) => key === "is_anonymous" || !granted[key] || actor[key]);
}

export function parseUntilDate(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const until = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(until) || until < 0) telegramFail(400, 400, "Bad Request: until_date is invalid");
  return until;
}

export function parseSlowMode(value: unknown): number {
  const seconds = value === undefined || value === null ? 0 : typeof value === "number" ? value : Number(value);
  if (!SLOW_MODE_SECONDS.includes(seconds as (typeof SLOW_MODE_SECONDS)[number])) {
    telegramFail(400, 400, "Bad Request: slow mode must be 0, 10, 30, 60, 300, 900, or 3600 seconds");
  }
  return seconds;
}

export function requireChatTitle(title: string): string {
  if (title.length === 0 || title.length > MAX_CHAT_TITLE) {
    telegramFail(400, 400, `Bad Request: chat title must be 1-${MAX_CHAT_TITLE} characters`);
  }
  return title;
}

export function requireChatAbout(about: string): string {
  if (about.length > MAX_CHAT_ABOUT) {
    telegramFail(400, 400, `Bad Request: chat description must be at most ${MAX_CHAT_ABOUT} characters`);
  }
  return about;
}

export function requireAdminTitle(rank: string): string {
  if (rank.length > MAX_ADMIN_TITLE) {
    telegramFail(400, 400, `Bad Request: custom title must be at most ${MAX_ADMIN_TITLE} characters`);
  }
  return rank;
}

export function effectivePermissions(args: {
  status: MemberStatus;
  restrictions?: ChatPermissions | null;
  defaults: ChatPermissions;
}): ChatPermissions {
  if (args.status === "creator" || args.status === "administrator") {
    return {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: true,
      can_invite_users: true,
      can_pin_messages: true,
      can_manage_topics: true,
    };
  }
  if (args.status === "restricted" && args.restrictions) return args.restrictions;
  return args.defaults;
}

export function serializeChatMember(args: {
  status: MemberStatus;
  user: UserRow;
  isAnonymous?: boolean;
  customTitle?: string | null;
  rights?: AdminRights | null;
  permissions?: ChatPermissions | null;
  untilDate?: number;
  isMember?: boolean;
}): Record<string, unknown> {
  const user = serializeUser(args.user);
  if (args.status === "creator") {
    return {
      status: "creator",
      user,
      is_anonymous: Boolean(args.isAnonymous),
      ...(args.customTitle ? { custom_title: args.customTitle } : {}),
    };
  }
  if (args.status === "administrator") {
    const rights = args.rights ?? DEFAULT_PROMOTE_RIGHTS;
    return {
      status: "administrator",
      user,
      can_be_edited: true,
      ...rights,
      ...(args.customTitle ? { custom_title: args.customTitle } : {}),
    };
  }
  if (args.status === "restricted") {
    return {
      status: "restricted",
      user,
      is_member: args.isMember !== false,
      until_date: args.untilDate ?? 0,
      ...(args.permissions ?? DEFAULT_CHAT_PERMISSIONS),
    };
  }
  if (args.status === "kicked") {
    return { status: "kicked", user, until_date: args.untilDate ?? 0 };
  }
  if (args.status === "left") return { status: "left", user };
  return { status: "member", user };
}

export function presentParticipant(user: UserRow, status: MemberStatus, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: user.id,
    name: user.first_name,
    username: user.username,
    is_bot: user.is_bot,
    status,
    ...extra,
  };
}

