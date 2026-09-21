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
  type: z.enum(["private", "group", "supergroup"]),
  title: z.string().optional(),
  members: z.array(z.number().int()).min(1),
});

const messageSchema = z.strictObject({
  chat_id: z.number().int(),
  message_id: z.number().int().positive(),
  from_id: z.number().int(),
  text: z.string(),
  reply_to_message_id: z.number().int().positive().optional(),
});

export const seedSchema = z.strictObject({
  bots: z.array(botSchema).min(1),
  users: z.array(userSchema).min(1),
  chats: z.array(chatSchema).min(1),
  messages: z.array(messageSchema).default([]),
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
