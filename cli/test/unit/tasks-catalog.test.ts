// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TASK_TWINS,
  findTwin,
  runnableTasks,
} from "../../src/cli/tasks-catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..");
const bundledTasksDir = join(packageRoot, "tasks");

describe("tasks catalog", () => {
  it("exposes every first-party twin", () => {
    for (const id of ["github", "stripe", "slack", "gmail"]) {
      const twin = findTwin(id);
      expect(twin, `twin ${id} should be registered`).not.toBeNull();
      expect(twin?.id).toBe(id);
      expect(
        runnableTasks(twin!).length,
        `twin ${id} should list at least one runnable task`,
      ).toBeGreaterThan(0);
    }
  });

  it("returns null for unknown twin", () => {
    expect(findTwin("not-a-twin")).toBeNull();
  });

  it("the only non-runnable entry is the github default seed", () => {
    const nonRunnable = TASK_TWINS.flatMap((twin) =>
      twin.tasks
        .filter((t) => !t.runnable)
        .map((t) => ({ twin: twin.id, filename: t.filename })),
    );
    expect(nonRunnable).toEqual([
      { twin: "github", filename: "00-default-seed.md" },
    ]);
  });

  it("every catalog filename resolves to a bundled task file", () => {
    for (const twin of TASK_TWINS) {
      for (const task of twin.tasks) {
        const filePath = join(bundledTasksDir, task.filename);
        expect(
          existsSync(filePath),
          `missing bundled task for ${twin.id}: ${task.filename}`,
        ).toBe(true);
      }
    }
  });

  // Drift gate: a task file added to disk but not registered here is
  // invisible to `pome tasks`. Fail loudly so the catalog stays the single
  // source of truth for the bundled task library (FDRS-624).
  it("every bundled task .md file is registered in the catalog", () => {
    const onDisk = readdirSync(bundledTasksDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    const registered = TASK_TWINS.flatMap((twin) =>
      twin.tasks.map((t) => t.filename),
    ).sort();
    const unregistered = onDisk.filter((f) => !registered.includes(f));
    expect(
      unregistered,
      `bundled task file(s) missing from tasks-catalog.ts: ${unregistered.join(", ")}`,
    ).toEqual([]);
  });

  it("registers each task filename exactly once across all twins", () => {
    const registered = TASK_TWINS.flatMap((twin) =>
      twin.tasks.map((t) => t.filename),
    );
    const dupes = registered.filter((f, i) => registered.indexOf(f) !== i);
    expect(dupes, `duplicate catalog entries: ${dupes.join(", ")}`).toEqual([]);
  });

  it("each task has a non-empty title and summary", () => {
    for (const twin of TASK_TWINS) {
      for (const task of twin.tasks) {
        expect(task.title.trim().length).toBeGreaterThan(0);
        expect(task.summary.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
