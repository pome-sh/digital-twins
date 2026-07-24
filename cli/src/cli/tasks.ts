// SPDX-License-Identifier: Apache-2.0
/**
 * `pome tasks` — browse the bundled task library and optionally
 * copy a twin's runnable tasks into the current project.
 *
 * Discovery only — no network. Source files live under `tasks/` in
 * the published tarball; `resolvePackageRoot` locates them whether the
 * CLI was started from `dist/` (published) or `src/` (dev).
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolvePackageRoot } from "./resolve-package-root.js";
import {
  TASK_TWINS,
  findTwin,
  runnableTasks,
  type CatalogTask,
  type TaskTwin,
} from "./tasks-catalog.js";

export interface TasksCommandOptions {
  copy?: boolean;
  force?: boolean;
  dest?: string;
}

const DEFAULT_DEST_DIR = "tasks";

function useColor(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

function dim(s: string): string {
  return useColor() ? `\x1b[2m${s}\x1b[0m` : s;
}

function bold(s: string): string {
  return useColor() ? `\x1b[1m${s}\x1b[0m` : s;
}

export async function runTasksCommand(
  twinArg: string | undefined,
  opts: TasksCommandOptions,
): Promise<void> {
  if (!twinArg) {
    if (opts.copy || opts.force || opts.dest) {
      console.error("Specify a twin to copy from, e.g. `pome tasks github --copy`.");
      process.exitCode = 2;
      return;
    }
    printTwinIndex();
    return;
  }

  const twin = findTwin(twinArg);
  if (!twin) {
    const available = TASK_TWINS.map((t) => t.id).join(", ");
    console.error(
      `Unknown twin "${twinArg}". Available: ${available}. Run \`pome tasks\` for the index.`,
    );
    process.exitCode = 2;
    return;
  }

  if (opts.copy) {
    await copyTwinTasks(twin, {
      destDir: opts.dest ?? DEFAULT_DEST_DIR,
      force: Boolean(opts.force),
    });
    return;
  }

  printTwinTasks(twin);
}

function printTwinIndex(): void {
  console.log(bold("Pome tasks"));
  console.log(dim("Bundled task library, grouped by twin."));
  console.log("");
  for (const twin of TASK_TWINS) {
    const count = runnableTasks(twin).length;
    console.log(`  ${bold(twin.id)} ${dim(`(${count} tasks)`)} — ${twin.label}`);
    console.log(`    ${dim(twin.description)}`);
  }
  console.log("");
  console.log(
    dim("Run `pome tasks <twin>` to list tasks, or add `--copy` to drop them into ./tasks/."),
  );
}

function printTwinTasks(twin: TaskTwin): void {
  const runnable = runnableTasks(twin);
  console.log(bold(`Pome tasks — ${twin.label}`));
  console.log(dim(`${runnable.length} tasks bundled with this CLI.`));
  console.log("");
  for (const task of runnable) {
    console.log(`  ${bold(task.filename)}`);
    console.log(`    ${dim(task.title)} — ${task.summary}`);
  }
  console.log("");
  console.log(
    dim(
      `Copy locally: \`pome tasks ${twin.id} --copy\` (or \`--copy --dest <dir>\`).`,
    ),
  );
  console.log(
    dim(
      `Run one: \`pome run tasks/${runnable[0]?.filename ?? "01-bug-happy-path.md"}\`.`,
    ),
  );
}

interface CopyOptions {
  destDir: string;
  force: boolean;
}

interface CopyOutcome {
  copied: string[];
  skipped: string[];
  missingSources: string[];
}

export async function copyTwinTasks(
  twin: TaskTwin,
  opts: CopyOptions,
): Promise<void> {
  const root = resolvePackageRoot(import.meta.url);
  if (!root) {
    console.error(
      "Could not locate the installed pome package (package.json not found).",
    );
    process.exitCode = 2;
    return;
  }

  const sourceDir = join(root, "tasks");
  const destDir = resolve(process.cwd(), opts.destDir);
  await mkdir(destDir, { recursive: true });

  const outcome = await copyTaskFiles({
    tasks: runnableTasks(twin),
    sourceDir,
    destDir,
    force: opts.force,
  });

  console.log(
    bold(
      `Copied ${outcome.copied.length} ${twin.label} task${outcome.copied.length === 1 ? "" : "s"} into ${opts.destDir}/.`,
    ),
  );
  for (const file of outcome.copied) {
    console.log(`  ${dim("+")} ${file}`);
  }
  for (const file of outcome.skipped) {
    console.log(
      `  ${dim("-")} ${file} ${dim("(exists — pass --force to overwrite)")}`,
    );
  }
  for (const file of outcome.missingSources) {
    console.error(
      `  ${dim("!")} ${file} ${dim("(missing from this package install)")}`,
    );
  }
  if (outcome.missingSources.length > 0) {
    process.exitCode = 2;
    return;
  }
  console.log("");
  const first = outcome.copied[0] ?? outcome.skipped[0];
  if (first) {
    console.log(
      dim(`Next: \`pome run ${opts.destDir}/${first}\`.`),
    );
  }
}

async function copyTaskFiles(input: {
  tasks: CatalogTask[];
  sourceDir: string;
  destDir: string;
  force: boolean;
}): Promise<CopyOutcome> {
  const outcome: CopyOutcome = { copied: [], skipped: [], missingSources: [] };
  for (const task of input.tasks) {
    const src = join(input.sourceDir, task.filename);
    const dest = join(input.destDir, task.filename);
    if (!existsSync(src)) {
      outcome.missingSources.push(task.filename);
      continue;
    }
    if (existsSync(dest) && !input.force) {
      outcome.skipped.push(task.filename);
    } else {
      await copyFile(src, dest);
      outcome.copied.push(task.filename);
    }

    // Sidecar seeds (`<name>.seed.json`) are optional — tasks that use
    // default seed state don't have one. Missing source is silent; missing
    // dest is copied; existing dest follows the same --force rule as the .md.
    const sidecar = task.filename.replace(/\.md$/i, ".seed.json");
    const sidecarSrc = join(input.sourceDir, sidecar);
    const sidecarDest = join(input.destDir, sidecar);
    if (!existsSync(sidecarSrc)) continue;
    if (existsSync(sidecarDest) && !input.force) {
      outcome.skipped.push(sidecar);
      continue;
    }
    await copyFile(sidecarSrc, sidecarDest);
    outcome.copied.push(sidecar);
  }
  return outcome;
}
