// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const SYNTHETIC_BOT_TOKEN = "1100001:AAHAAAAAAAAAAAAAAAAAAAAA";

const userSchema = z.strictObject({
  id: z.number().int(),
  account: z.string().min(1),
  first_name: z.string().min(1),
  username: z.string().min(1).optional(),
});

const botSchema = z.strictObject({
  id: z.number().int(),
  token: z.string().regex(/^\d{6,}:[A-Za-z0-9_-]{20,}$/),
  first_name: z.string().min(1),
  username: z.string().min(1),
});

const chatSchema = z.strictObject({
  id: z.number().int(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().optional(),
  username: z.string().min(1).optional(),
  is_forum: z.boolean().optional(),
  members: z.array(z.number().int()).min(1),
});

const messageSchema = z.strictObject({
  chat_id: z.number().int(),
  message_id: z.number().int().positive(),
  from_id: z.number().int(),
  text: z.string(),
  reply_to_message_id: z.number().int().positive().optional(),
  date: z.number().int().optional(),
});

export const seedSchema = z
  .strictObject({
    bots: z.array(botSchema).min(1),
    users: z.array(userSchema).min(1),
    chats: z.array(chatSchema).min(1),
    messages: z.array(messageSchema).default([]),
  })
  .superRefine((state, ctx) => {
    const ids = new Set<number>();
    for (const bot of state.bots) {
      if (ids.has(bot.id)) ctx.addIssue({ code: "custom", message: `duplicate id ${bot.id}` });
      ids.add(bot.id);
    }
    const accounts = new Set(state.users.map((user) => user.account));
    for (const user of state.users) {
      if (ids.has(user.id)) ctx.addIssue({ code: "custom", message: `duplicate id ${user.id}` });
      ids.add(user.id);
    }
    for (const bot of state.bots) {
      if (accounts.has(bot.username)) {
        ctx.addIssue({ code: "custom", message: `bot username ${bot.username} collides with a user account` });
      }
    }
    const chatIds = new Set(state.chats.map((chat) => chat.id));
    const usernames = new Set<string>();
    for (const chat of state.chats) {
      for (const member of chat.members) {
        if (!ids.has(member)) ctx.addIssue({ code: "custom", message: `unknown member ${member}` });
      }
      if (chat.username) {
        const key = chat.username.toLowerCase();
        if (usernames.has(key)) ctx.addIssue({ code: "custom", message: `duplicate username ${chat.username}` });
        usernames.add(key);
      }
      if (chat.is_forum && chat.type !== "supergroup") {
        ctx.addIssue({ code: "custom", message: `forum chat ${chat.id} must be a supergroup` });
      }
    }
    const messageKeys = new Set<string>();
    for (const message of state.messages) {
      if (!chatIds.has(message.chat_id)) ctx.addIssue({ code: "custom", message: `unknown chat ${message.chat_id}` });
      if (!ids.has(message.from_id)) ctx.addIssue({ code: "custom", message: `unknown from_id ${message.from_id}` });
      const key = `${message.chat_id}:${message.message_id}`;
      if (messageKeys.has(key)) ctx.addIssue({ code: "custom", message: `duplicate message ${key}` });
      messageKeys.add(key);
    }
  });

export type TelegramSeed = z.infer<typeof seedSchema>;

function withoutSidecarMeta(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  if (!("_meta" in (input as Record<string, unknown>))) return input;
  const { _meta, ...rest } = input as Record<string, unknown>;
  void _meta;
  return rest;
}

export function parseSeed(input: unknown): TelegramSeed {
  return seedSchema.parse(withoutSidecarMeta(input));
}

export function defaultSeedState(): TelegramSeed {
  return {
    bots: [
      {
        id: 1100001,
        token: SYNTHETIC_BOT_TOKEN,
        first_name: "X",
        username: "x_bot",
      },
    ],
    users: [
      { id: 2001, account: "alice", first_name: "Alice", username: "alice" },
      { id: 2002, account: "bob", first_name: "Bob", username: "bob" },
    ],
    chats: [
      { id: 2001, type: "private", members: [2001, 1100001] },
      { id: 2002, type: "private", members: [2002, 1100001] },
      { id: -1001234567890, type: "supergroup", title: "Lab", members: [2001, 2002, 1100001] },
    ],
    messages: [],
  };
}

export function loadSeedFromEnv(env: Record<string, string | undefined> = process.env): TelegramSeed {
  const raw = env.POME_SEED_JSON;
  if (raw === undefined || raw === "") return defaultSeedState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`POME_SEED_JSON is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.telegram && typeof obj.telegram === "object" && obj.telegram !== null) {
      const telegram = obj.telegram as Record<string, unknown>;
      if ("seed" in telegram) return parseSeed(telegram.seed);
    }
  }
  return parseSeed(parsed);
}
