// SPDX-License-Identifier: Apache-2.0
// Invite tokens are bound to chat and creator. Public search never leaves the
// seeded catalog. Topic close is not delete.

import { telegramFail } from "./errors.js";
import { serializeUser, type UserRow } from "./serializers.js";

export const MAX_INVITE_NAME = 32;
export const MAX_TOPIC_TITLE = 128;
export const MIN_MEMBER_LIMIT = 1;
export const MAX_MEMBER_LIMIT = 99_999;

export type InviteLinkRow = {
  token: string;
  chat_id: number;
  creator_id: number;
  name: string | null;
  expire_date: number;
  member_limit: number;
  creates_join_request: number;
  is_primary: number;
  is_revoked: number;
  usage_count: number;
  created_at: number;
};

export type ForumTopicRow = {
  chat_id: number;
  topic_id: number;
  title: string;
  icon_color: number | null;
  icon_emoji_id: string | null;
  is_closed: number;
  created_by_id: number;
  created_at: number;
};

export type InviteOptions = {
  name?: string;
  expire_date?: number;
  member_limit?: number;
  creates_join_request?: boolean;
};

export function formatInviteLink(token: string): string {
  return `https://t.me/+${token}`;
}

export function parseInviteLink(link: string): string {
  const trimmed = link.trim();
  const plus = trimmed.match(/^(?:https?:\/\/)?t\.me\/\+([A-Za-z0-9_-]+)$/i);
  if (plus?.[1]) return plus[1];
  const joinchat = trimmed.match(/^(?:https?:\/\/)?t\.me\/joinchat\/([A-Za-z0-9_-]+)$/i);
  if (joinchat?.[1]) return joinchat[1];
  telegramFail(400, 400, "Bad Request: invite link is invalid");
}

export function parseInviteHash(hash: string): string {
  const trimmed = hash.trim();
  if (/^\+?[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed.replace(/^\+/, "");
  telegramFail(400, 400, "Bad Request: invite hash is invalid");
}

export function requireInviteName(name: string | undefined): string | null {
  if (name === undefined || name === "") return null;
  if (name.length > MAX_INVITE_NAME) {
    telegramFail(400, 400, `Bad Request: invite name must be at most ${MAX_INVITE_NAME} characters`);
  }
  return name;
}

export function requireTopicTitle(title: string): string {
  if (title.length === 0 || title.length > MAX_TOPIC_TITLE) {
    telegramFail(400, 400, `Bad Request: topic title must be 1-${MAX_TOPIC_TITLE} characters`);
  }
  return title;
}

export function requireCustomEmojiId(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (!/^[0-9]+$/.test(value)) telegramFail(400, 400, "Bad Request: icon_custom_emoji_id is invalid");
  return value;
}

export function requireExpireDate(value: number | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  if (value < 0 || (value > 0 && value <= now)) telegramFail(400, 400, "Bad Request: expire_date is invalid");
  return value;
}

export function mergeInviteOptions(row: InviteLinkRow, patch: InviteOptions): InviteOptions {
  return {
    name: patch.name !== undefined ? patch.name : row.name ?? undefined,
    expire_date: patch.expire_date !== undefined ? patch.expire_date : row.expire_date,
    member_limit: patch.member_limit !== undefined ? patch.member_limit : row.member_limit,
    creates_join_request: patch.creates_join_request !== undefined ? patch.creates_join_request : row.creates_join_request === 1,
  };
}

export function normalizeInviteOptions(input: InviteOptions): {
  name: string | null;
  expire_date: number;
  member_limit: number;
  creates_join_request: boolean;
} {
  const memberLimit = input.member_limit ?? 0;
  const createsJoinRequest = input.creates_join_request === true;
  if (memberLimit !== 0 && (memberLimit < MIN_MEMBER_LIMIT || memberLimit > MAX_MEMBER_LIMIT)) {
    telegramFail(400, 400, `Bad Request: member_limit must be ${MIN_MEMBER_LIMIT}-${MAX_MEMBER_LIMIT}`);
  }
  if (memberLimit > 0 && createsJoinRequest) {
    telegramFail(400, 400, "Bad Request: member_limit and creates_join_request can't both be set");
  }
  const expireDate = input.expire_date ?? 0;
  if (expireDate < 0) telegramFail(400, 400, "Bad Request: expire_date is invalid");
  return {
    name: requireInviteName(input.name),
    expire_date: expireDate,
    member_limit: memberLimit,
    creates_join_request: createsJoinRequest,
  };
}

export function inviteFailure(row: InviteLinkRow, now: number): string | null {
  if (row.is_revoked) return "Bad Request: invite link is revoked";
  if (row.expire_date > 0 && now >= row.expire_date) return "Bad Request: invite link has expired";
  if (row.member_limit > 0 && row.usage_count >= row.member_limit) return "Bad Request: invite link is no longer valid";
  return null;
}

export function presentInviteLink(
  row: InviteLinkRow,
  creator: UserRow,
  pendingJoinRequestCount: number,
): Record<string, unknown> {
  return {
    invite_link: formatInviteLink(row.token),
    creator: serializeUser(creator),
    creates_join_request: row.creates_join_request === 1,
    is_primary: row.is_primary === 1,
    is_revoked: row.is_revoked === 1,
    ...(row.name ? { name: row.name } : {}),
    ...(row.expire_date > 0 ? { expire_date: row.expire_date } : {}),
    ...(row.member_limit > 0 ? { member_limit: row.member_limit } : {}),
    ...(pendingJoinRequestCount > 0 ? { pending_join_request_count: pendingJoinRequestCount } : {}),
  };
}

export function presentForumTopic(row: ForumTopicRow): Record<string, unknown> {
  return {
    message_thread_id: row.topic_id,
    name: row.title,
    ...(row.icon_color !== null ? { icon_color: row.icon_color } : {}),
    ...(row.icon_emoji_id !== null ? { icon_custom_emoji_id: row.icon_emoji_id } : {}),
    is_closed: row.is_closed === 1,
  };
}

export function presentListedTopic(row: ForumTopicRow): Record<string, unknown> {
  return {
    topic_id: row.topic_id,
    title: row.title,
    is_closed: row.is_closed === 1,
    ...(row.icon_color !== null ? { icon_color: row.icon_color } : {}),
    ...(row.icon_emoji_id !== null ? { icon_emoji_id: row.icon_emoji_id } : {}),
  };
}
