// SPDX-License-Identifier: Apache-2.0
//
// Acceptance: `query()` seals the examinee by default.
//
// The measured defect this pins (2026-08-05, and still reproducible on a
// developer machine today): an examinee launched through this adapter with no
// isolation options inherits the HOST's filesystem settings — user
// (`~/.claude/settings.json`), project and local — including the Claude Code
// plugin MCP servers configured there. A `claude-haiku-4-5` trial of
// `support-triage` searched the developer's real Slack workspace, made zero twin
// calls, and would have scored as "the agent failed to triage": a verdict about
// the wrong workspace entirely. `tools: []` was already set and did not stop it,
// because `tools` and `settingSources` are different doors.
//
// The SDK's own resolver states the inheritance plainly. On this repo's
// developer machine, `resolveSettings({})` — the omitted case — returns
// `mcpServers` and `enabledPlugins` provenanced to `~/.claude/settings.json`,
// among them `slack@claude-plugins-official`, the very server family that
// trial called. `resolveSettings({ settingSources: [] })` returns nothing.
//
// These cases assert the params the adapter hands the SDK.
// `isolation-argv.test.ts` asserts the flag that reaches the CLI — the seal has
// to survive the trip, not just be present on an object.

import { describe, expect, it, vi } from "vitest";

type CapturedParams = { prompt: unknown; options?: Record<string, unknown> };

let capturedQueryParams: CapturedParams | null = null;
// Read and reset through functions: the mock assigns from outside any caller's
// control flow, so a direct read after `capturedQueryParams = null` narrows to
// `never` and stops typechecking.
const readCapture = (): CapturedParams | null => capturedQueryParams;
const resetCapture = (): void => {
  capturedQueryParams = null;
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: CapturedParams) => {
    capturedQueryParams = params;
    return (async function* () {})();
  },
  HOOK_EVENTS: ["PreToolUse", "PostToolUse", "SessionStart", "Stop"],
}));

const { query } = await import("../src/query.js");

/** Drives the wrapper to completion and returns the options the SDK saw. */
async function optionsSeenBySdk(
  options?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  resetCapture();
  for await (const _ of query({ prompt: "triage the queue", ...(options ? { options } : {}) } as never)) {
    // drained: the wrapper calls the SDK eagerly, but pull anyway
  }
  const captured = readCapture();
  if (!captured) throw new Error("the SDK was never called");
  return captured.options ?? {};
}

describe("query(): sealed by default", () => {
  it("defaults settingSources to [] when the caller passes no options at all", async () => {
    expect((await optionsSeenBySdk()).settingSources).toEqual([]);
  });

  it("defaults settingSources to [] when the caller passes options without it", async () => {
    const seen = await optionsSeenBySdk({ model: "haiku", maxTurns: 30 });
    expect(seen.settingSources).toEqual([]);
    // The seal is additive: everything else the caller asked for still arrives.
    expect(seen.model).toBe("haiku");
    expect(seen.maxTurns).toBe(30);
  });

  it("treats an explicit `undefined` as unset, exactly as the SDK does", async () => {
    // The SDK's own branch is `if (settingSources !== undefined)`, so
    // `{ settingSources: undefined }` and an omitted key are the same request.
    // Sealing only one of the two would make the seal depend on how a caller
    // spelled "I didn't choose".
    const seen = await optionsSeenBySdk({ settingSources: undefined });
    expect(seen.settingSources).toEqual([]);
  });
});

describe("query(): an explicit choice wins", () => {
  it("does not clobber a caller's narrowed settingSources", async () => {
    const seen = await optionsSeenBySdk({ settingSources: ["project"] });
    expect(seen.settingSources).toEqual(["project"]);
  });

  it("lets a caller opt back into the host's settings by naming all three", async () => {
    // The documented restore path for the pre-seal behaviour. Naming the three
    // sources is the opt-out; there is deliberately no way to spell it by
    // omission, because omission is what shipped the defect.
    const seen = await optionsSeenBySdk({ settingSources: ["user", "project", "local"] });
    expect(seen.settingSources).toEqual(["user", "project", "local"]);
  });

  it("forwards an explicit empty array unchanged", async () => {
    expect((await optionsSeenBySdk({ settingSources: [] })).settingSources).toEqual([]);
  });
});

describe("query(): `tools` stays the caller's call", () => {
  it("does not inject `tools` — the adapter seals ambient config, not capability", async () => {
    // `settingSources: []` removes configuration the HOST supplied and the
    // caller never asked for. `tools: []` would remove Bash/Read/Grep — the
    // agent's own hands — from every consumer of a drop-in wrapper. Different
    // doors, and only one of them is the adapter's to shut. An exam that wants
    // the closed sandbox sets `tools: []` itself, as the bundled examples do.
    expect(await optionsSeenBySdk()).not.toHaveProperty("tools");
  });

  it("forwards an explicit `tools: []` verbatim", async () => {
    expect((await optionsSeenBySdk({ tools: [] })).tools).toEqual([]);
  });

  it("forwards an explicit tool allowlist verbatim", async () => {
    const seen = await optionsSeenBySdk({ tools: ["Read", "Grep"] });
    expect(seen.tools).toEqual(["Read", "Grep"]);
  });
});

describe("query(): the seal composes with the wrapper's other work", () => {
  it("still attaches pome's hooks", async () => {
    const seen = await optionsSeenBySdk();
    expect(seen.settingSources).toEqual([]);
    expect(Object.keys((seen.hooks ?? {}) as Record<string, unknown>).length).toBeGreaterThan(0);
  });

  it("preserves a caller's own hook callbacks alongside the seal", async () => {
    const userHook = vi.fn();
    const seen = await optionsSeenBySdk({
      hooks: { PreToolUse: [{ hooks: [userHook] }] },
    });
    expect(seen.settingSources).toEqual([]);
    const pre = (seen.hooks as Record<string, unknown[]>).PreToolUse;
    expect(pre.length).toBeGreaterThan(1);
    expect(JSON.stringify(pre)).toBeTruthy();
  });
});
