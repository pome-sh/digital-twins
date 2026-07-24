import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";
import {
  findTwin,
  runnableTasks,
} from "../../src/cli/tasks-catalog.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pome init", () => {
  it("scaffolds starter tasks and agents without overwriting config", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pome-init-"));
    tempDirs.push(projectDir);
    process.chdir(projectDir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync(["node", "pome", "init"]);

    const githubTwin = findTwin("github");
    expect(githubTwin).not.toBeNull();
    expect(existsSync("pome.json")).toBe(true);
    // The manifest is valid: it carries a slug derived from the project dir.
    const freshManifest = JSON.parse(readFileSync("pome.json", "utf8"));
    expect(freshManifest.agent.slug).toMatch(/^[a-z0-9-]+$/);
    // The starter path always creates tasks/, so the manifest points at it
    // (F-904 — forward-compatible with F-865's bare `pome run` resolution).
    expect(freshManifest.tasks).toBe("tasks");
    for (const task of runnableTasks(githubTwin!)) {
      expect(existsSync(join("tasks", task.filename))).toBe(true);
    }
    expect(existsSync("tasks/14-stripe-refund-retry.md")).toBe(false);
    expect(existsSync("tasks/20-slack-exfiltration.md")).toBe(false);
    expect(existsSync("examples/agents/scripted-triage-agent.ts")).toBe(true);

    // Bundled .seed.json sidecars must land alongside their .md so that
    // `pome run tasks/01-...` doesn't fall into the prose-seed parse path.
    expect(existsSync("tasks/01-bug-happy-path.seed.json")).toBe(true);
    // 04-judge-context now ships a sidecar that pre-labels issue #1 `bug`
    // (the default seed leaves it unlabeled). Init must copy it alongside the .md.
    expect(existsSync("tasks/04-judge-context.md")).toBe(true);
    expect(existsSync("tasks/04-judge-context.seed.json")).toBe(true);

    await createProgram().parseAsync(["node", "pome", "init"]);

    expect(readFileSync("pome.json", "utf8")).toContain("scripted-triage-agent.ts");
    const messages = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).toContain("pome register agent <name>");

    // Bundled example agents must not use top-level await. `npx tsx <file>` in
    // a project without `"type": "module"` falls back to CJS, and top-level
    // await fails the CJS transform — every scripted run would die before its
    // first tool call.
    const agentFiles = readdirSync("examples/agents").filter((f) =>
      f.endsWith(".ts"),
    );
    expect(agentFiles.length).toBeGreaterThan(0);
    for (const f of agentFiles) {
      const src = readFileSync(join("examples/agents", f), "utf8");
      // Match `await` at column 0 (a likely top-level await) outside of a
      // function body. Anything inside `async function main()` will be
      // indented.
      const offending = src
        .split("\n")
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => /^await\b/.test(line));
      expect(
        offending,
        `${f} contains top-level await on lines: ${offending
          .map((o) => o.idx + 1)
          .join(", ")}`,
      ).toEqual([]);
    }
  });

  async function initIn(
    setup: (dir: string) => void,
    args: string[],
  ): Promise<{ dir: string; exitCode: number | string | undefined; messages: string }> {
    const dir = await mkdtemp(join(tmpdir(), "pome-init-"));
    tempDirs.push(dir);
    process.chdir(dir);
    setup(dir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const priorExit = process.exitCode;
    process.exitCode = undefined;
    await createProgram().parseAsync(["node", "pome", ...args]);
    const exitCode = process.exitCode;
    process.exitCode = priorExit;
    return {
      dir,
      exitCode,
      messages: errSpy.mock.calls.map((c) => String(c[0])).join("\n"),
    };
  }

  it("skips the starter library in an existing project (package.json present)", async () => {
    await initIn(
      (dir) => writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-agent" })),
      ["init"],
    );

    // No 28-file dump: neither the task library nor the sample agents land.
    expect(existsSync("tasks")).toBe(false);
    expect(existsSync("examples")).toBe(false);
    // The manifest is still written...
    expect(existsSync("pome.json")).toBe(true);
    const manifest = JSON.parse(readFileSync("pome.json", "utf8"));
    expect(manifest.agent.slug).toMatch(/^[a-z0-9-]+$/);
    // ...but `command` is omitted — the BYO user supplies their own launcher.
    expect(manifest.command).toBeUndefined();
    // No task directory exists, so no `tasks` key is claimed.
    expect(manifest.tasks).toBeUndefined();
  });

  it("writes the tasks key when an existing project already has a tasks dir", async () => {
    await initIn((dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-agent" }));
      mkdirSync(join(dir, "tasks"));
      writeFileSync(join(dir, "tasks", "my-real-task.md"), "# a task\n");
    }, ["init"]);

    const manifest = JSON.parse(readFileSync("pome.json", "utf8"));
    expect(manifest.tasks).toBe("tasks");
    // The user's own task file is untouched; no starter library dumped over it.
    expect(existsSync("tasks/my-real-task.md")).toBe(true);
    expect(existsSync("tasks/01-bug-happy-path.md")).toBe(false);
  });

  it("--starter forces the full library even in an existing project", async () => {
    await initIn(
      (dir) => writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-agent" })),
      ["init", "--starter"],
    );

    const githubTwin = findTwin("github");
    for (const task of runnableTasks(githubTwin!)) {
      expect(existsSync(join("tasks", task.filename))).toBe(true);
    }
    expect(existsSync("examples/agents/scripted-triage-agent.ts")).toBe(true);
    expect(JSON.parse(readFileSync("pome.json", "utf8")).command).toContain(
      "scripted-triage-agent.ts",
    );
  });

  it("--bare skips the library in an otherwise-fresh dir", async () => {
    await initIn(() => undefined, ["init", "--bare"]);

    expect(existsSync("tasks")).toBe(false);
    expect(existsSync("examples")).toBe(false);
    expect(existsSync("pome.json")).toBe(true);
    expect(JSON.parse(readFileSync("pome.json", "utf8")).command).toBeUndefined();
  });

  it("rejects --bare and --starter together", async () => {
    const { exitCode } = await initIn(() => undefined, ["init", "--bare", "--starter"]);
    expect(exitCode).toBe(2);
    expect(existsSync("pome.json")).toBe(false);
  });
});
