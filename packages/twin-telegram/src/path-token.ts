// SPDX-License-Identifier: Apache-2.0
import type { Context } from "hono";

const BOT_PATH = /^(?:\/s\/([^/]+))?\/(?:file\/)?bot(\d+:[^/]+)(?:\/.*)?$/;
const NOT_VENDOR = new Set(["mcp", "admin", "healthz"]);

export function telegramPathIdentity(c: Context): { token?: string; sid?: string } {
  const pathname = c.req.path;
  const match = pathname.match(BOT_PATH);
  if (!match) return {};
  if (match[3] && NOT_VENDOR.has(match[3])) return {};
  return { sid: match[1], token: match[2] };
}

export function extractTelegramPathToken(c: Context): string | undefined {
  return telegramPathIdentity(c).token;
}
