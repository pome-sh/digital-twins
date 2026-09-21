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
};

export type MessageRow = {
  chat_id: number;
  message_id: number;
  from_id: number;
  text: string;
  date: number;
  reply_to_message_id: number | null;
};

export function serializeUser(row: UserRow): Record<string, unknown> {
  return {
    id: row.id,
    is_bot: row.is_bot,
    first_name: row.first_name,
    ...(row.username ? { username: row.username } : {}),
  };
}

export function serializeChat(row: ChatRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    ...(row.title ? { title: row.title } : {}),
  };
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
    text: row.text,
    ...(row.reply_to_message_id ? { reply_to_message: { message_id: row.reply_to_message_id } } : {}),
  };
}
