// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChecksLintCommand } from "../../src/cli/checks-lint.js";

const tempDirs: string[] = [];
const captured = { log: [] as string[], error: [] as string[] };

const task = (criteria: string, twins = "[github]") => `# Audit

## Prompt

Do the thing.

## Success Criteria

${criteria}

## Config

\`\`\`yaml
twins: ${twins}
\`\`\`
`;

async function taskFile(body: string, name = "t.md"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-lint-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, body, "utf8");
  return path;
}

beforeEach(() => {
  process.exitCode = undefined;
  captured.log.length = 0;
  captured.error.length = 0;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    captured.log.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    captured.error.push(a.map(String).join(" "));
  });
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("pome checks lint", () => {
  it("fails, naming the sentence, when a [code] criterion binds nothing", async () => {
    const path = await taskFile(task("- [code] No new labels were ever created in `acme/api`"));
    await runChecksLintCommand([path]);
    expect(process.exitCode).toBe(1);
    expect(captured.error.join("\n")).toContain("No new labels were ever created in `acme/api`");
  });

  it("passes, and says so, when every [code] criterion binds", async () => {
    const path = await taskFile(task("- [code] Issue #1 exists in `acme/api`"));
    await runChecksLintCommand([path]);
    expect(process.exitCode).toBeUndefined();
    expect(captured.log.join("\n")).toMatch(/1 .*bind/i);
  });

  // A criterion whose twin has not migrated its vocabulary is not a pass and not
  // a failure — this CLI holds no declaration to judge it by. Counting it as
  // either would be the false clean bill the whole vocabulary exists to remove.
  it("reports a twin with no declared vocabulary as unanswerable, not as a pass", async () => {
    const path = await taskFile(task("- [code] A message was posted", "[slack]"));
    await runChecksLintCommand([path]);
    expect(process.exitCode).toBeUndefined();
    expect(captured.log.join("\n")).toMatch(/slack/);
  });

  it("names the file each finding came from when given several", async () => {
    const clean = await taskFile(task("- [code] Issue #1 exists in `acme/api`"), "clean.md");
    const broken = await taskFile(task("- [code] Issue #1 does not exist"), "broken.md");
    await runChecksLintCommand([clean, broken]);
    expect(process.exitCode).toBe(1);
    expect(captured.error.join("\n")).toContain("broken.md");
    expect(captured.error.join("\n")).not.toContain("clean.md");
  });

  it("keeps checking the remaining files after one fails", async () => {
    const a = await taskFile(task("- [code] Issue #1 does not exist"), "a.md");
    const b = await taskFile(task("- [code] Issue #2 does not exist either"), "b.md");
    await runChecksLintCommand([a, b]);
    const err = captured.error.join("\n");
    expect(err).toContain("a.md");
    expect(err).toContain("b.md");
  });

  it("refuses a file it cannot read, naming it, rather than reporting a pass", async () => {
    await runChecksLintCommand([join(tmpdir(), "pome-lint-does-not-exist.md")]);
    expect(process.exitCode).toBe(2);
    expect(captured.error.join("\n")).toContain("pome-lint-does-not-exist.md");
  });

  // The user-visible consequence of the reader missing a heading alias: a clean
  // bill on a file whose criteria were never looked at.
  it("does not report a pass on a task that spells the section `## Checks`", async () => {
    const path = await taskFile("# Audit\n\n## Checks\n\n- [code] Issue #1 does not exist\n");
    await runChecksLintCommand([path]);
    expect(process.exitCode).toBe(1);
    expect(captured.error.join("\n")).toContain("Issue #1 does not exist");
  });

  it("never consults the network — the whole point is that offline is answerable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const path = await taskFile(task("- [code] No new labels were ever created in `acme/api`"));
    await runChecksLintCommand([path]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
