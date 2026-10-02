// SPDX-License-Identifier: Apache-2.0

export function telegramOk(result: unknown): { ok: true; result: unknown } {
  return { ok: true, result };
}

export function telegramError(errorCode: number, description: string): {
  ok: false;
  error_code: number;
  description: string;
} {
  return { ok: false, error_code: errorCode, description };
}

export type UserRow = {
  id: number;
  first_name: string;
  username: string | null;
  is_bot: boolean;
};

export type ChatRow = {
  id: number;
  type: string;
  title: string | null;
  description?: string | null;
  photo_file_id?: string | null;
  username?: string | null;
  is_forum?: number | null;
  is_public?: number | null;
  permissions_json?: string | null;
  permissions_until?: number | null;
  slow_mode_seconds?: number | null;
  creator_id?: number | null;
};

export type MessageRow = {
  chat_id: number;
  message_id: number;
  from_id: number;
  text: string;
  date: number;
  reply_to_message_id: number | null;
  edit_date?: number | null;
  forward_from_id?: number | null;
  forward_from_chat_id?: number | null;
  reply_markup_json?: string | null;
  media_json?: string | null;
  message_thread_id?: number | null;
};

export function serializeUser(row: UserRow): Record<string, unknown> {
  return {
    id: row.id,
    is_bot: row.is_bot,
    first_name: row.first_name,
    ...(row.username ? { username: row.username } : {}),
  };
}

export function serializeChat(row: ChatRow, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    ...(row.title ? { title: row.title } : {}),
    ...(row.username ? { username: row.username } : {}),
    ...(row.is_forum ? { is_forum: true } : {}),
    ...extras,
  };
}

function serializeReplyMarkup(raw: string): unknown {
  const markup = JSON.parse(raw) as Record<string, unknown>;
  // The domain distinguishes reply keyboards from inline keyboards so their
  // interactions remain different, while Bot API wire uses `keyboard`.
  if ("reply_keyboard" in markup) {
    const { reply_keyboard, ...rest } = markup;
    return { ...rest, keyboard: reply_keyboard };
  }
  return markup;
}

export function serializeMessage(
  row: MessageRow,
  from: UserRow,
  chat: ChatRow,
): Record<string, unknown> {
  return {
    message_id: row.message_id,
    from: serializeUser(from),
    chat: serializeChat(chat),
    date: row.date,
    ...(row.media_json
      ? { ...(JSON.parse(row.media_json) as Record<string, unknown>), ...(row.text ? { caption: row.text } : {}) }
      : row.text ? { text: row.text } : {}),
    ...(row.edit_date ? { edit_date: row.edit_date } : {}),
    ...(row.reply_to_message_id ? { reply_to_message: { message_id: row.reply_to_message_id } } : {}),
    ...(row.forward_from_id
      ? { forward_from: { id: row.forward_from_id }, forward_from_chat_id: row.forward_from_chat_id }
      : {}),
    ...(row.reply_markup_json ? { reply_markup: serializeReplyMarkup(row.reply_markup_json) } : {}),
    ...(row.message_thread_id ? { message_thread_id: row.message_thread_id } : {}),
  };
}
