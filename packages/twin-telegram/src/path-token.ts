// SPDX-License-Identifier: Apache-2.0
import type { Context } from "hono";

const BOT_PATH = /^(?:\/s\/[^/]+)?\/(?:file\/)?bot(\d+:[^/]+)(?:\/([^/]+))?$/;
const NOT_VENDOR = new Set(["mcp", "admin", "healthz"]);

export function extractTelegramPathToken(c: Context): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(c.req.url).pathname;
  } catch {
    return undefined;
  }
  const match = pathname.match(BOT_PATH);
  if (!match) return undefined;
  if (match[2] && NOT_VENDOR.has(match[2])) return undefined;
  return match[1];
}
