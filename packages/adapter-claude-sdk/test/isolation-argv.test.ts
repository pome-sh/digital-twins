// SPDX-License-Identifier: Apache-2.0
//
// Acceptance: the seal survives the trip to the CLI.
//
// `isolation.test.ts` asserts the options object the adapter hands the SDK.
// That is necessary and not sufficient — a property nobody reads passes forever,
// which is the failure shape this family keeps hitting. So this file drives the
// REAL `@anthropic-ai/claude-agent-sdk` against a stand-in `claude` executable
// and asserts on argv, where the seal is either applied or it is not:
//
//   settingSources omitted   → no `--setting-sources` flag → CLI loads
//                              user + project + local, plugin MCP servers
//                              included. This is the defect.
//   settingSources: []       → `--setting-sources=`        → isolation.
//   settingSources: ['project'] → `--setting-sources=project`
//
// It is also the case that catches a future SDK renaming or reinterpreting the
// option: the unit tier would stay green while the sandbox reopened.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { query } from "../src/query.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLI = join(PACKAGE_ROOT, "fixtures", "fake-claude-cli.mjs");

let tmp: string;
let argvPath: string;
const ORIGINAL_ARGV_PATH = process.env.POME_FAKE_CLI_ARGV_PATH;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pome-isolation-"));
  argvPath = join(tmp, "argv.json");
  process.env.POME_FAKE_CLI_ARGV_PATH = argvPath;
});

afterEach(() => {
  if (ORIGINAL_ARGV_PATH === undefined) delete process.env.POME_FAKE_CLI_ARGV_PATH;
  else process.env.POME_FAKE_CLI_ARGV_PATH = ORIGINAL_ARGV_PATH;
});

/** Runs the adapter's `query()` against the stand-in CLI, returns its argv. */
async function argvReachingTheCli(options?: Record<string, unknown>): Promise<string[]> {
  const merged = { pathToClaudeCodeExecutable: FAKE_CLI, ...(options ?? {}) };
  for await (const _ of query({ prompt: "triage the queue", options: merged } as never)) {
    // drained
  }
  return JSON.parse(readFileSync(argvPath, "utf8")) as string[];
}

const settingSourcesFlag = (argv: string[]): string | undefined =>
  argv.find((arg) => arg.startsWith("--setting-sources"));

describe("the seal reaches the CLI", () => {
  it("passes --setting-sources= when the caller asked for no isolation", async () => {
    // Red before the fix: the flag is absent entirely, and an absent flag is
    // the CLI default — user + project + local settings, plugin MCP servers
    // included.
    expect(settingSourcesFlag(await argvReachingTheCli())).toBe("--setting-sources=");
  }, 30_000);

  it("passes the caller's narrowed sources when they chose", async () => {
    const argv = await argvReachingTheCli({ settingSources: ["project"] });
    expect(settingSourcesFlag(argv)).toBe("--setting-sources=project");
  }, 30_000);

  it("passes all three when the caller opts back into the host's settings", async () => {
    const argv = await argvReachingTheCli({ settingSources: ["user", "project", "local"] });
    expect(settingSourcesFlag(argv)).toBe("--setting-sources=user,project,local");
  }, 30_000);

  it("leaves --tools to the caller and forwards an explicit empty allowlist", async () => {
    const sealedOnly = await argvReachingTheCli();
    expect(sealedOnly).not.toContain("--tools");

    const closed = await argvReachingTheCli({ tools: [] });
    expect(closed[closed.indexOf("--tools") + 1]).toBe("");
  }, 30_000);
});

describe("the stand-in CLI fixture", () => {
  it("is committed executable, since the SDK spawns it without a shell", () => {
    // `spawn(executable, args)` with no shell: a fixture that lost its
    // executable bit in git would red every case above with EACCES, which reads
    // as "the seal broke" rather than "the fixture did".
    const mode = execFileSync("git", ["ls-files", "-s", "--", relative(PACKAGE_ROOT, FAKE_CLI)], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    }).trim();
    expect(mode.startsWith("100755")).toBe(true);
    expect(statSync(FAKE_CLI).mode & 0o111).toBeGreaterThan(0);
  });
});
