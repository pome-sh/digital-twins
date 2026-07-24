// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";
import {
  findTwin,
  runnableTasks,
} from "../../src/cli/tasks-catalog.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

interface CapturedConsole {
  log: string[];
  error: string[];
}

function captureConsole(): CapturedConsole {
  const captured: CapturedConsole = { log: [], error: [] };
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.log.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    captured.error.push(args.map(String).join(" "));
  });
  return captured;
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function inTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-tasks-"));
  tempDirs.push(dir);
  process.chdir(dir);
  return dir;
}

describe("pome tasks", () => {
  it("lists available twins when no twin is given", async () => {
    await inTempDir();
    const captured = captureConsole();

    await createProgram().parseAsync(["node", "pome", "tasks"]);

    const out = captured.log.concat(captured.error).join("\n");
    expect(out.toLowerCase()).toContain("github");
    expect(out.toLowerCase()).toContain("stripe");
    expect(out.toLowerCase()).toContain("slack");
    expect(out.toLowerCase()).toContain("gmail");
  });

  it("lists runnable github tasks and omits the seed", async () => {
    await inTempDir();
    const captured = captureConsole();

    await createProgram().parseAsync(["node", "pome", "tasks", "github"]);

    const out = captured.log.concat(captured.error).join("\n");
    expect(out).toContain("01-bug-happy-path.md");
    expect(out).toContain("03-already-triaged.md");
    expect(out).toContain("04-judge-context.md");
    expect(out).toContain("05-github-identity-spoof.md");
    expect(out).not.toContain("00-default-seed.md");
  });

  it("lists runnable stripe, slack, and gmail tasks", async () => {
    await inTempDir();
    const captured = captureConsole();

    await createProgram().parseAsync(["node", "pome", "tasks", "stripe"]);
    await createProgram().parseAsync(["node", "pome", "tasks", "slack"]);
    await createProgram().parseAsync(["node", "pome", "tasks", "gmail"]);

    const out = captured.log.concat(captured.error).join("\n");
    expect(out).toContain("14-stripe-refund-retry.md");
    expect(out).toContain("19-stripe-rerefund-persuasion.md");
    expect(out).toContain("20-slack-exfiltration.md");
    expect(out).toContain("21-slack-injection.md");
    expect(out).toContain("22-gmail-inbox-triage.md");
    expect(out).toContain("23-gmail-first-party-parity.md");
  });

  it("errors with a helpful hint on unknown twin", async () => {
    await inTempDir();
    const captured = captureConsole();

    await createProgram().parseAsync([
      "node",
      "pome",
      "tasks",
      "nope-twin",
    ]);

    expect(process.exitCode).toBe(2);
    const out = captured.error.join("\n");
    expect(out.toLowerCase()).toContain("github");
  });

  it("--copy copies the runnable github tasks into ./tasks/", async () => {
    const dir = await inTempDir();
    captureConsole();

    await createProgram().parseAsync([
      "node",
      "pome",
      "tasks",
      "github",
      "--copy",
    ]);

    const tasksDir = join(dir, "tasks");
    const githubTwin = findTwin("github");
    expect(githubTwin).not.toBeNull();
    const githubTasks = runnableTasks(githubTwin!);
    for (const task of githubTasks) {
      expect(existsSync(join(tasksDir, task.filename))).toBe(true);
    }
    expect(readdirSync(tasksDir).filter((f) => f.endsWith(".md"))).toHaveLength(
      githubTasks.length,
    );
    expect(existsSync(join(tasksDir, "00-default-seed.md"))).toBe(false);

    // Sidecar .seed.json files must be copied alongside the .md so `pome run`
    // doesn't fall back to parsing the prose ## Seed State section.
    expect(existsSync(join(tasksDir, "01-bug-happy-path.seed.json"))).toBe(
      true,
    );
    expect(existsSync(join(tasksDir, "05-github-identity-spoof.seed.json"))).toBe(
      true,
    );
    // 04-judge-context now ships a sidecar that pre-labels issue #1 `bug`
    // (the default seed leaves it unlabeled, which broke the task). --copy
    // must bring the sidecar alongside the .md.
    expect(existsSync(join(tasksDir, "04-judge-context.seed.json"))).toBe(
      true,
    );
  });

  it("--copy copies non-github twin tasks on demand", async () => {
    const dir = await inTempDir();
    captureConsole();

    await createProgram().parseAsync([
      "node",
      "pome",
      "tasks",
      "stripe",
      "--copy",
    ]);

    const tasksDir = join(dir, "tasks");
    expect(existsSync(join(tasksDir, "14-stripe-refund-retry.md"))).toBe(true);
    expect(existsSync(join(tasksDir, "19-stripe-rerefund-persuasion.md"))).toBe(
      true,
    );
    expect(existsSync(join(tasksDir, "01-bug-happy-path.md"))).toBe(false);
  });

  it("--copy preserves existing files (no overwrite without --force)", async () => {
    const dir = await inTempDir();
    captureConsole();

    const tasksDir = join(dir, "tasks");
    await mkdir(tasksDir, { recursive: true });
    const stamped = "# Local edit — do not overwrite\n";
    await writeFile(join(tasksDir, "01-bug-happy-path.md"), stamped);

    await createProgram().parseAsync([
      "node",
      "pome",
      "tasks",
      "github",
      "--copy",
    ]);

    expect(readFileSync(join(tasksDir, "01-bug-happy-path.md"), "utf8")).toBe(
      stamped,
    );
    expect(existsSync(join(tasksDir, "03-already-triaged.md"))).toBe(true);
  });

  it("--copy --force overwrites existing files", async () => {
    const dir = await inTempDir();
    captureConsole();

    const tasksDir = join(dir, "tasks");
    await mkdir(tasksDir, { recursive: true });
    await writeFile(
      join(tasksDir, "01-bug-happy-path.md"),
      "# stale local copy\n",
    );

    await createProgram().parseAsync([
      "node",
      "pome",
      "tasks",
      "github",
      "--copy",
      "--force",
    ]);

    const written = readFileSync(
      join(tasksDir, "01-bug-happy-path.md"),
      "utf8",
    );
    expect(written).not.toBe("# stale local copy\n");
    expect(written).toContain("Task 01");
  });

  it("--copy --dest writes into a custom directory", async () => {
    const dir = await inTempDir();
    captureConsole();

    await createProgram().parseAsync([
      "node",
      "pome",
      "tasks",
      "github",
      "--copy",
      "--dest",
      "custom-tasks",
    ]);

    const customDir = join(dir, "custom-tasks");
    expect(existsSync(join(customDir, "01-bug-happy-path.md"))).toBe(true);
    expect(existsSync(join(dir, "tasks"))).toBe(false);
  });

  // F-892 — `pome scenarios` is a hidden deprecated alias: it still runs the
  // command but prints a one-line pointer to `pome tasks`.
  describe("deprecated `pome scenarios` alias", () => {
    it("still lists twins and prints the rename pointer", async () => {
      await inTempDir();
      const captured = captureConsole();

      await createProgram().parseAsync(["node", "pome", "scenarios"]);

      const out = captured.log.concat(captured.error).join("\n");
      expect(out.toLowerCase()).toContain("github");
      const err = captured.error.join("\n");
      expect(err).toContain("`pome scenarios` was renamed to `pome tasks`");
    });

    it("still copies into ./tasks/ (same behavior as `pome tasks`)", async () => {
      const dir = await inTempDir();
      captureConsole();

      await createProgram().parseAsync([
        "node",
        "pome",
        "scenarios",
        "github",
        "--copy",
      ]);

      expect(existsSync(join(dir, "tasks", "01-bug-happy-path.md"))).toBe(true);
    });

    it("is hidden from the help output", async () => {
      const help = createProgram().helpInformation();
      expect(help).toContain("tasks ");
      expect(help).not.toContain("scenarios ");
    });
  });
});
