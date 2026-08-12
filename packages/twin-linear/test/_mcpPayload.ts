// SPDX-License-Identifier: Apache-2.0
//
// Read a `tools/call` payload off the TEXT content block (F-1480).
//
// Linear declares no `outputSchema` on any of its 58 tools, so since the fixture
// became a projection of Linear's own table (`substrate:
// upstream-capture-projection`) neither does this twin — and MCP only permits
// `result.structuredContent` for a tool that declares one. The payload therefore
// arrives as JSON text in `content[0]`, which is how twin-github and twin-slack
// have always read it (`mcp-jsonrpc.test.ts` in both).
//
// This is the response-axis half of F-1480. It was cleared to land by a heat read
// that came back zero on every customer surface: the 3 linear corpus tasks assert
// twin STATE and never a response shape, no bundled example reads a linear
// result, the repo's 3 `structuredContent` readers are github/slack and all fall
// back defensively when it is absent, and 0 of 17 hosted saved tasks and 0 of the
// 50 most recent hosted runs touch a linear tool. The only hard readers were the
// tests this helper replaces.

import { expect } from "vitest";

/** A `tools/call` response, as much of it as a payload read needs. */
export interface ToolCallResponse {
  result: {
    isError?: boolean;
    content: Array<{ type?: string; text: string }>;
    /** Must stay absent — see {@link payload}. */
    structuredContent?: Record<string, unknown>;
  };
}

/**
 * The tool's payload, and an assertion that it came the way Linear's declaration
 * says it does.
 *
 * `structuredContent` being absent is checked HERE rather than in one dedicated
 * test, so every migrated call site re-asserts it. A twin that started declaring
 * an `outputSchema` again would otherwise keep every one of these tests green
 * while serving a field Linear does not.
 */
export function payload<T = Record<string, unknown>>(res: ToolCallResponse): T {
  expect(res.result.structuredContent, "Linear declares no outputSchema, so no tool may serve structuredContent").toBeUndefined();
  const first = res.result.content[0];
  expect(first, "a tools/call result must carry at least one content block").toBeDefined();
  expect(first!.type ?? "text").toBe("text");
  return JSON.parse(first!.text) as T;
}
