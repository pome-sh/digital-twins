// SPDX-License-Identifier: Apache-2.0
// Moved verbatim in behaviour from `packages/adapter-claude-sdk/test/als.test.ts` —
// the store is now wire's, so its guard is too.

import { describe, expect, it } from "vitest";
import {
  correlationContext,
  currentToolCallId,
  withCorrelation,
} from "../src/correlation/context.js";

describe("correlationContext", () => {
  it("returns null outside any run() context", () => {
    expect(currentToolCallId()).toBeNull();
  });

  it("exposes tool_call_id inside run()", () => {
    let seen: string | null = null;
    correlationContext.run({ tool_call_id: "tlc_a" }, () => {
      seen = currentToolCallId();
    });
    expect(seen).toBe("tlc_a");
  });

  it("clears after run() exits", () => {
    correlationContext.run({ tool_call_id: "tlc_a" }, () => {
      // body runs
    });
    expect(currentToolCallId()).toBeNull();
  });

  it("isolates concurrent run() invocations", async () => {
    const results: Array<string | null> = [];
    await Promise.all([
      new Promise<void>((resolve) =>
        correlationContext.run({ tool_call_id: "tlc_one" }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          results.push(currentToolCallId());
          resolve();
        }),
      ),
      new Promise<void>((resolve) =>
        correlationContext.run({ tool_call_id: "tlc_two" }, async () => {
          await new Promise((r) => setTimeout(r, 1));
          results.push(currentToolCallId());
          resolve();
        }),
      ),
    ]);
    expect(results.sort()).toEqual(["tlc_one", "tlc_two"]);
  });
});

// `withCorrelation` is the documented entry point a framework adapter calls; the raw store above is the escape hatch. These cases pin the contract
// the adapters are told to rely on.
describe("withCorrelation", () => {
  it("sets the id for the duration of the callback", () => {
    const seen = withCorrelation("tlc_sync", () => currentToolCallId());
    expect(seen).toBe("tlc_sync");
    expect(currentToolCallId()).toBeNull();
  });

  it("passes a synchronous return value straight through (does not force a promise)", () => {
    const result = withCorrelation("tlc_sync", () => 42);
    expect(result).toBe(42);
  });

  it("survives awaits inside an async callback", async () => {
    const seen = await withCorrelation("tlc_async", async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      return currentToolCallId();
    });
    expect(seen).toBe("tlc_async");
  });

  it("propagates exceptions and still tears the scope down", () => {
    expect(() =>
      withCorrelation("tlc_boom", () => {
        throw new Error("inner exploded");
      }),
    ).toThrow("inner exploded");
    expect(currentToolCallId()).toBeNull();
  });

  it("propagates async rejections and still tears the scope down", async () => {
    await expect(
      withCorrelation("tlc_boom", async () => {
        await new Promise((r) => setTimeout(r, 0));
        throw new Error("async exploded");
      }),
    ).rejects.toThrow("async exploded");
    expect(currentToolCallId()).toBeNull();
  });

  it("nests: the inner id wins inside, the outer id is restored after", async () => {
    const seen: Array<string | null> = [];
    await withCorrelation("tlc_outer", async () => {
      seen.push(currentToolCallId());
      await withCorrelation("tlc_inner", async () => {
        await new Promise((r) => setTimeout(r, 0));
        seen.push(currentToolCallId());
      });
      seen.push(currentToolCallId());
    });
    expect(seen).toEqual(["tlc_outer", "tlc_inner", "tlc_outer"]);
  });

  it("isolates ids across concurrent scopes", async () => {
    const seen: Array<string | null> = [];
    await Promise.all(
      ["tlc_a", "tlc_b", "tlc_c", "tlc_d"].map((id) =>
        withCorrelation(id, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          seen.push(currentToolCallId());
        }),
      ),
    );
    expect(seen.sort()).toEqual(["tlc_a", "tlc_b", "tlc_c", "tlc_d"]);
  });
});
