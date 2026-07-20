// SPDX-License-Identifier: Apache-2.0
//
// Per-call ToolCallContext factory shared by every MCP dispatch surface
// (server.ts legacy routes + mcp-jsonrpc.ts tools/call). Exposes the
// authenticated session and captures a handler-reported state delta for the
// recorded event (F-683).

import type { Context } from "hono";
import type { RecorderEvent, ToolCallContext } from "./index.js";
import type { SessionValue } from "./auth.js";

export function makeToolCallContext(c: Context): {
  ctx: ToolCallContext;
  delta: () => RecorderEvent["state_delta"];
  /** True once the handler invoked `reportDelta` (including with `null`). */
  reportedDelta: () => boolean;
} {
  let reported: RecorderEvent["state_delta"] = null;
  let didReport = false;
  return {
    ctx: {
      session: c.get("session") as SessionValue | undefined,
      reportDelta: (delta) => {
        reported = delta;
        didReport = true;
      },
    },
    delta: () => reported,
    reportedDelta: () => didReport,
  };
}
