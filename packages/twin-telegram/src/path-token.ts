// SPDX-License-Identifier: Apache-2.0
import type { Context } from "hono";

const BOT_PATH = /(?:^|\/)(?:file\/)?bot([^/]+)/;

export function extractTelegramPathToken(c: Context): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(c.req.url).pathname;
  } catch {
    return undefined;
  }
  return pathname.match(BOT_PATH)?.[1];
}
