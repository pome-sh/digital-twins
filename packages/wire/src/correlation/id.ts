// SPDX-License-Identifier: Apache-2.0
//
// correlation/id — the fallback correlation id minter.

import { randomBytes } from "node:crypto";

/**
 * Mint a synthetic correlation id: `tlc_<8 lowercase hex chars>`.
 *
 * THIS IS A FALLBACK, NOT THE DEFAULT. Prefer the framework's own tool-call id
 * whenever the runtime exposes one, because that is the id the rest of the trace
 * already uses: `ToolUseEvent.tool_use_id` is the model's `toolu_…`, so a
 * `TwinHttpEvent` stamped with a minted `tlc_…` joins to nothing and stays an
 * orphan with a null parent — the bug that made this a fallback rather
 * than the default). Mint only when the id is genuinely unavailable: a runtime
 * that does not surface one, or a framework whose tool boundary has no id of its
 * own. A correlated-but-unjoinable row still beats an uncorrelated one, which is
 * why this exists at all instead of passing `null`.
 *
 * 4 random bytes is 2^32; ids only need to be distinct among the tool calls of a
 * single run (tens to low thousands), and they are never a security boundary.
 */
export function generateToolCallId(): string {
  return `tlc_${randomBytes(4).toString("hex")}`;
}
