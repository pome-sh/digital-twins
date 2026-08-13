// SPDX-License-Identifier: Apache-2.0
//
// F-1519. `scripts/smoke-examples.mjs` classifies REACHED-OUTBOUND on the
// literal `POME_SMOKE_REACHED_OUTBOUND`, and three bundled examples
// (`pr-summary-agent`, `pr-summary-review`, `triage-agent`) never print it
// themselves — they get it from this package's `query()`, which is also the
// only reason the smoke gate's marker-coverage guard passes them. Nothing on
// this side of the boundary pinned that, so a refactor of the wrapper chain
// would convert those three to permanent FAIL with the red landing in a
// different repo directory from the change that caused it. This is that pin.
//
// It also fixes the literal and the env-var name here, in the package that
// prints them: the smoke script owns its own copies (it cannot import from a
// built workspace package), so a rename on either side has to red somewhere.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SDK_MESSAGES = [{ type: "system", subtype: "init" }];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: () => ({}),
  query: () =>
    (async function* () {
      pulls.push("sdkQuery yielded");
      for (const m of SDK_MESSAGES) yield m;
    })(),
  HOOK_EVENTS: [],
}));

let pulls: string[] = [];
const MARK_ENV = "POME_SMOKE_MARK_OUTBOUND";
let saved: string | undefined;

beforeEach(() => {
  pulls = [];
  saved = process.env[MARK_ENV];
  delete process.env[MARK_ENV];
});

afterEach(() => {
  if (saved === undefined) delete process.env[MARK_ENV];
  else process.env[MARK_ENV] = saved;
  vi.restoreAllMocks();
});

async function drain(): Promise<string[]> {
  const { query } = await import("../src/query.js");
  const printed: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    printed.push(String(args[0]));
    pulls.push(`printed ${String(args[0])}`);
  });
  for await (const _ of query({ prompt: "hi" } as never)) void _;
  return printed;
}

describe("query() emits the smoke gate's outbound marker", () => {
  it("prints the exact literal the smoke gate matches, gated on the env var", async () => {
    process.env[MARK_ENV] = "1";
    expect(await drain()).toContain("POME_SMOKE_REACHED_OUTBOUND");
  });

  it("prints it BEFORE the SDK stream produces anything", async () => {
    process.env[MARK_ENV] = "1";
    await drain();
    expect(pulls[0]).toBe("printed POME_SMOKE_REACHED_OUTBOUND");
  });

  it("prints nothing in a real user's run (env unset)", async () => {
    expect(await drain()).not.toContain("POME_SMOKE_REACHED_OUTBOUND");
  });

  it("treats any value other than \"1\" as off", async () => {
    process.env[MARK_ENV] = "true";
    expect(await drain()).not.toContain("POME_SMOKE_REACHED_OUTBOUND");
  });
});
