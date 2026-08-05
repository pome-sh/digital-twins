// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { currentToolCallId } from "@pome-sh/wire/correlation";
import { wrapHandler } from "../src/wrapHandler.js";

describe("wrapHandler", () => {
  it("calls the underlying handler with the same args and returns its value", async () => {
    const inner = async (args: { x: number }) => ({ doubled: args.x * 2 });
    const wrapped = wrapHandler(inner);
    const result = await wrapped({ x: 21 });
    expect(result).toEqual({ doubled: 42 });
  });

  it("sets tool_call_id in the correlation scope during handler execution", async () => {
    let seenId: string | null = null;
    const wrapped = wrapHandler(async () => {
      seenId = currentToolCallId();
      return null;
    });
    await wrapped({});
    expect(seenId).toMatch(/^tlc_/);
  });

  it("clears the correlation scope after handler exits", async () => {
    const wrapped = wrapHandler(async () => null);
    await wrapped({});
    expect(currentToolCallId()).toBeNull();
  });

  it("uses a distinct tool_call_id on each invocation", async () => {
    const seen: Array<string | null> = [];
    const wrapped = wrapHandler(async () => {
      seen.push(currentToolCallId());
      return null;
    });
    await wrapped({});
    await wrapped({});
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("isolates tool_call_id across concurrent invocations", async () => {
    const seen: string[] = [];
    const wrapped = wrapHandler(async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      const id = currentToolCallId();
      if (id) seen.push(id);
      return null;
    });
    await Promise.all([wrapped({}), wrapped({}), wrapped({}), wrapped({})]);
    expect(new Set(seen).size).toBe(4);
  });

  it("propagates exceptions from the inner handler", async () => {
    const wrapped = wrapHandler(async () => {
      throw new Error("inner exploded");
    });
    await expect(wrapped({})).rejects.toThrow("inner exploded");
  });

  it("clears the correlation scope even when handler throws", async () => {
    const wrapped = wrapHandler(async () => {
      throw new Error("x");
    });
    try {
      await wrapped({});
    } catch {
      /* swallow */
    }
    expect(currentToolCallId()).toBeNull();
  });
});

// F-1200. The minted `tlc_<random>` named nothing: `ToolUseEvent.tool_use_id`
// is the SDK's `toolu_…`, so the twin row's `tool_call_id` could never be
// joined back to the tool call that caused it, and every twin HTTP row stayed
// an orphan.
//
// The real id is already on the handler's `extra` argument. Measured against
// @anthropic-ai/claude-agent-sdk 0.3.218 + Claude Code CLI 2.1.220: the CLI
// stamps `_meta["claudecode/toolUseId"]` on every `tools/call`
// (`let Y=dw_(V), re = Y ? {"claudecode/toolUseId":Y} : {}`), and it equals the
// assistant stream's `tool_use.id`.
//
// It is a CLI-side convention, NOT a typed SDK contract — `tool()`'s `extra` is
// `unknown` in sdk.d.ts, and the CLI emits the key conditionally. So every read
// below is tolerant and every miss falls back to a minted id. A thrown error
// here would take down a tool call over a trace-linkage detail.
describe("wrapHandler — real tool_use_id from extra (F-1200)", () => {
  const withToolUseId = (id: unknown) => ({ _meta: { "claudecode/toolUseId": id } });

  it("uses the SDK tool_use_id the CLI stamped on extra._meta", async () => {
    let seen: string | null = null;
    const wrapped = wrapHandler(async () => {
      seen = currentToolCallId();
      return null;
    });
    await wrapped({}, withToolUseId("toolu_01WxYzAbCdEf"));
    expect(seen).toBe("toolu_01WxYzAbCdEf");
  });

  it("passes extra through to the inner handler", async () => {
    // Regression: the wrapper used to call `handler(args)` and drop the second
    // argument outright, so any handler reading `extra.signal` saw undefined.
    let seen: unknown;
    const wrapped = wrapHandler(async (_args: unknown, extra: unknown) => {
      seen = extra;
      return null;
    });
    const extra = withToolUseId("toolu_1");
    await wrapped({}, extra);
    expect(seen).toBe(extra);
  });

  it.each([
    ["extra absent", undefined],
    ["extra not an object", "nope"],
    ["no _meta", {}],
    ["_meta without the key", { _meta: {} }],
    ["key present but empty", { _meta: { "claudecode/toolUseId": "" } }],
    ["key present but not a string", { _meta: { "claudecode/toolUseId": 7 } }],
    ["_meta is null", { _meta: null }],
  ])("falls back to a minted tlc_ id when %s", async (_label, extra) => {
    let seen: string | null = null;
    const wrapped = wrapHandler(async () => {
      seen = currentToolCallId();
      return null;
    });
    await wrapped({}, extra);
    expect(seen).toMatch(/^tlc_/);
  });

  it("still isolates ids across concurrent invocations", async () => {
    const seen: string[] = [];
    const wrapped = wrapHandler(async () => {
      await new Promise((r) => setTimeout(r, 1));
      const id = currentToolCallId();
      if (id) seen.push(id);
      return null;
    });
    await Promise.all([
      wrapped({}, withToolUseId("toolu_a")),
      wrapped({}, withToolUseId("toolu_b")),
      wrapped({}, undefined),
    ]);
    expect(new Set(seen).size).toBe(3);
    expect(seen.filter((s) => s.startsWith("toolu_")).sort()).toEqual(["toolu_a", "toolu_b"]);
  });
});
