// SPDX-License-Identifier: Apache-2.0
import type { ToolCallContext } from "@pome-sh/sdk";
import { telegramFail } from "./errors.js";

export function accountFrom(args: { account?: string }, ctx: ToolCallContext): string {
  const login = ctx.session?.login;
  if (typeof login !== "string" || login.length === 0) {
    telegramFail(400, 400, "Bad Request: account required");
  }
  if (args.account !== undefined && args.account !== login) {
    telegramFail(400, 400, "Bad Request: unauthorized account");
  }
  return login;
}
