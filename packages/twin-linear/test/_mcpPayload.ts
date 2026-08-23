// SPDX-License-Identifier: Apache-2.0
// Read a `tools/call` payload off the TEXT content block.

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
