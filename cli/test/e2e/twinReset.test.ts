// SPDX-License-Identifier: Apache-2.0
// F-948 DX audit regression — `pome twin reset` hardcoded its own supported-
// twin set (`new Set(["github", "slack", "stripe", "gmail"])`) instead of
// deriving it from `TWIN_NAME_LIST`, the single source of truth the registry
// refactor introduced specifically so a new twin can't silently fall out of
// sync (see registry.ts's own header comment). Linear shipped as a full
// first-party twin but `pome twin reset linear` rejected it as "Unknown
// twin", even though `pome twin start linear` worked fine. This test locks
// `twin reset` to accept every twin in TWIN_NAME_LIST, and locks the
// unknown-twin error text (for both `twin start` and `twin reset`) to list
// all five names.

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TWIN_NAME_LIST } from "../../src/twin/registry.js";
import { resolveTsxBin } from "../../scripts/lib/resolve-tsx.js";

const CLI_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_BIN = resolveTsxBin(import.meta.url);
const MAIN_TS = join(CLI_ROOT, "src", "cli", "main.ts");

async function runCli(args: string[]): Promise<{ code: number | null; output: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pome-twin-reset-e2e-"));
  return await new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [MAIN_TS, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

describe("pome twin reset (e2e)", () => {
  it.each(TWIN_NAME_LIST)("accepts every first-party twin: %s", async (name) => {
    const { code, output } = await runCli(["twin", "reset", name]);
    expect(output).not.toContain("Unknown twin");
    expect(output).toContain(`Standalone ${name} twin state reset.`);
    expect(code).toBe(0);
  });

  it("rejects an unrecognized twin and lists all five supported names", async () => {
    const { code, output } = await runCli(["twin", "reset", "nonexistent-twin-name"]);
    expect(code).not.toBe(0);
    for (const name of TWIN_NAME_LIST) {
      expect(output).toContain(name);
    }
  });
});

describe("pome twin start — unknown-twin error (e2e)", () => {
  it("lists all five supported names, not just a subset", async () => {
    const { code, output } = await runCli(["twin", "start", "nonexistent-twin-name"]);
    expect(code).not.toBe(0);
    for (const name of TWIN_NAME_LIST) {
      expect(output).toContain(name);
    }
  });

  it("--help documents every first-party twin in the <name> argument", async () => {
    const { output } = await runCli(["twin", "start", "--help"]);
    for (const name of TWIN_NAME_LIST) {
      expect(output).toContain(name);
    }
  });
});
