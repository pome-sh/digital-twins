// SPDX-License-Identifier: Apache-2.0
//
// Minimal guard for a quickstart example. See the sibling comment in
// minimal-viktor-langgraph for what is deliberately left to the other gates.

import { afterEach, describe, expect, it } from "vitest";

import { resolveAuthToken } from "../src/index.ts";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("triage-agent", () => {
  it("passes a pre-minted POME_AUTH_TOKEN through untouched", async () => {
    process.env.POME_AUTH_TOKEN = "pre-minted-token";
    process.env.TWIN_AUTH_SECRET = "x".repeat(64);
    await expect(resolveAuthToken()).resolves.toBe("pre-minted-token");
  });

  // Auth is env-only. The agent must never probe the twin's on-disk secret --
  // that server-to-CLI path coupling is what broke the old quickstart -- so with
  // neither var set it has to fail naming both, not fall back to a file.
  it("fails loudly, naming both env options, when no auth is set", async () => {
    delete process.env.POME_AUTH_TOKEN;
    delete process.env.TWIN_AUTH_SECRET;
    await expect(resolveAuthToken()).rejects.toThrow(/POME_AUTH_TOKEN/);
    await expect(resolveAuthToken()).rejects.toThrow(/TWIN_AUTH_SECRET/);
  });
});
