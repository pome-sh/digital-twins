#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { ensureTwinAuthSecret, serve } from "@pome-sh/sdk/server";
import { openTelegramTwinDatabase } from "./db.js";
import { loadSeedFromEnv } from "./seed.js";
import { telegramTwinDefinition } from "./twin.js";

const port = Number(process.env.PORT ?? 3333);
const host = process.env.TELEGRAM_TWIN_HOST ?? "127.0.0.1";
const dbPath = process.env.TELEGRAM_TWIN_DB ?? ".telegram_twin/telegram.db";

ensureTwinAuthSecret("telegram", host);

const db = openTelegramTwinDatabase(dbPath);
const seed = process.env.TELEGRAM_TWIN_NO_SEED === "1" ? undefined : loadSeedFromEnv();

const { close } = await serve(telegramTwinDefinition(db), {
  port,
  hostname: host,
  db,
  seed,
  runId: process.env.POME_RUN_ID ?? "spawn",
});
void close;

console.log(`Telegram twin listening at http://${host}:${port}`);
console.log(`HTTP: http://${host}:${port}/bot<token>/getMe`);
console.log(`MCP:  http://${host}:${port}/s/<sid>/mcp`);
