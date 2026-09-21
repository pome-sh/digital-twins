// SPDX-License-Identifier: Apache-2.0
import type { ToolCallContext } from "@pome-sh/sdk";
import { telegramFail } from "./errors.js";

export function accountFrom(args: { account?: string }, ctx: ToolCallContext): string {
  if (args.account) return args.account;
  const login = ctx.session?.login;
  if (typeof login === "string" && login.length > 0) return login;
  telegramFail(400, 400, "Bad Request: account required");
}
