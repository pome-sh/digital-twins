// SPDX-License-Identifier: Apache-2.0
//
// `.pome/twin-status.json` — where `pome twin start` records what it booted,
// and what `pome twin status`, the docs' get-started prompts and the showcase
// scripts read back. One entry per twin under `twins` (F-1836); the top-level
// fields mirror the twin the writing command started first, so a reader of
// the older single-twin shape keeps seeing what it saw. Written owner-only,
// because it carries the bearer JWT (F-1800).

import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TwinName } from "./registry.js";

/** Where `pome twin start` records the running twin, relative to the cwd. */
export const STANDALONE_STATUS_PATH = ".pome/twin-status.json";

export type StandaloneStatus = {
  name: TwinName;
  url: string;
  rest_url: string;
  mcp_url: string;
  auth_token: string;
};

/**
 * `.pome/twin-status.json` carries the bearer JWT for every `/s/standalone/*`
 * endpoint, so it is written the way the CLI writes every other secret
 * (`writeCredentialsFile`, `writeSecretsFile`): owner-only directory and
 * file (F-1800). The `chmod` is not redundant — `mode` on `writeFile` applies
 * only when the file is created, and a status file left by an older CLI is
 * 0644 until something chmods it.
 */
export async function writeStandaloneStatusFile(
  status: StandaloneStatus | StandaloneStatusFile,
  path: string = STANDALONE_STATUS_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Written beside and renamed over: a reader never sees a half-written file,
  // and two writers cannot interleave bytes (the lock in
  // `updateStandaloneStatusFile` is what keeps them from losing each other's
  // entries). The rename keeps the temp file's 0600; the chmod after it is for
  // the one case rename cannot cover, a pre-existing 0644 file on a filesystem
  // that refuses the rename.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(status, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

/**
 * `.pome/` git-ignores itself. The status file carries a bearer, and the one
 * time it was committed (F-1806) it was because nothing stopped `git add .`
 * in a fresh checkout. A `.gitignore` inside the directory with `*` is the
 * convention `.vercel/` and `.terraform/` use: no edit to the user's own
 * `.gitignore`, and it travels with the directory. Written once; a user who
 * deletes it has decided.
 */
export async function ensureSelfIgnoring(dir: string): Promise<void> {
  const path = join(dir, ".gitignore");
  try {
    await writeFile(path, "*\n", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/** A lock that a crashed writer left behind is broken after this long. */
const STALE_LOCK_MS = 10_000;

/**
 * Exclusive lock around the status file, held for one read-merge-write.
 * `open(…, "wx")` is atomic on every filesystem the CLI runs on, so two
 * `pome twin start` processes launched together in one folder serialise
 * here instead of each reading the old file and the last one erasing the
 * other's entry. The lock carries the holder's pid, and one older than
 * `STALE_LOCK_MS` is treated as a crash and taken over.
 */
async function withStatusLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > STALE_LOCK_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `pome twin start: ${lockPath} is held by another pome process — if none is running, delete it.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

/**
 * Read, merge this command's twins in, write — under the lock, so concurrent
 * starts in one folder all land in the file.
 */
export async function updateStandaloneStatusFile(
  entries: readonly StandaloneStatus[],
  path: string = STANDALONE_STATUS_PATH,
): Promise<StandaloneStatusFile> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await ensureSelfIgnoring(dirname(path));
  return await withStatusLock(path, async () => {
    const merged = mergeStandaloneStatus(await readStandaloneStatusFile(path), entries);
    await writeStandaloneStatusFile(merged, path);
    return merged;
  });
}

/**
 * The whole status file. `twins` holds one entry per running twin name; the
 * top-level fields mirror the first twin the WRITING command started, so a
 * reader of the older single-twin shape (`jq -r .rest_url`) keeps seeing what
 * it saw before: the twin that was just started.
 */
export type StandaloneStatusFile = StandaloneStatus & {
  twins: Record<string, StandaloneStatus>;
};

function isStatusEntry(value: unknown): value is StandaloneStatus {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    typeof entry.url === "string" &&
    typeof entry.rest_url === "string" &&
    typeof entry.mcp_url === "string" &&
    typeof entry.auth_token === "string"
  );
}

/** Every entry a status file holds, whichever shape wrote it. */
export function standaloneStatusEntries(contents: unknown): StandaloneStatus[] {
  if (contents === null || typeof contents !== "object") return [];
  const file = contents as Partial<StandaloneStatusFile>;
  if (file.twins !== null && typeof file.twins === "object") {
    return Object.values(file.twins).filter(isStatusEntry);
  }
  return isStatusEntry(file) ? [pick(file)] : [];
}

function pick(entry: StandaloneStatus): StandaloneStatus {
  return {
    name: entry.name,
    url: entry.url,
    rest_url: entry.rest_url,
    mcp_url: entry.mcp_url,
    auth_token: entry.auth_token,
  };
}

/**
 * Merge this command's twins into whatever the file already holds: a second
 * `twin start` in the same folder adds its entries beside the first's instead
 * of replacing the file (F-1836). Same name overwrites — a restarted twin is
 * the same twin. Nothing here removes an entry: a twin that died leaves its
 * entry, and `pome twin status` is what says it is stale.
 */
export function mergeStandaloneStatus(
  existing: unknown,
  entries: readonly StandaloneStatus[],
): StandaloneStatusFile {
  const twins: Record<string, StandaloneStatus> = {};
  for (const entry of standaloneStatusEntries(existing)) twins[entry.name] = pick(entry);
  for (const entry of entries) twins[entry.name] = pick(entry);
  const first = entries[0];
  if (first === undefined) throw new Error("mergeStandaloneStatus: no entries to write");
  return { ...pick(first), twins };
}

/** The status file as parsed, or `undefined` when absent or unreadable — an
 *  unreadable file is replaced, not merged into. */
export async function readStandaloneStatusFile(
  path: string = STANDALONE_STATUS_PATH,
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Where `twin start` snapshots each twin's state at boot, for
 * `pome twin tape --diff` (F-1837): the diff is "now against this file", which
 * is exactly "now against the seed the twin booted with", taken in the same
 * process so generated ids match. Owner-only like the status file — a state
 * export can carry seeded secrets even after redaction.
 */
export const STANDALONE_STATE_DIR = ".pome/twin-state";

export function standaloneInitialStatePath(
  name: string,
  dir: string = STANDALONE_STATE_DIR,
): string {
  return join(dir, `${name}.initial.json`);
}

export async function writeStandaloneInitialState(
  name: string,
  state: unknown,
  dir: string = STANDALONE_STATE_DIR,
): Promise<void> {
  const path = standaloneInitialStatePath(name, dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

/** The boot snapshot, or `undefined` when there is none; a corrupt one is named. */
export async function readStandaloneInitialState(
  name: string,
  dir: string = STANDALONE_STATE_DIR,
): Promise<unknown> {
  const path = standaloneInitialStatePath(name, dir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`pome twin tape: ${path} is not valid JSON — restart the twin to rewrite it.`);
  }
}

/**
 * `twin start`'s side of the snapshot. A failure here must not stop a boot —
 * the snapshot only feeds `twin tape --diff` — so it is said on stderr and
 * the twin serves anyway; `--diff` then says the file is missing.
 */
export async function snapshotStandaloneInitialState(
  name: string,
  exportState: () => unknown | Promise<unknown>,
  dir: string = STANDALONE_STATE_DIR,
): Promise<void> {
  // An earlier boot's snapshot goes first: if the export or the write fails
  // below, `--diff` must find nothing rather than silently diff this boot
  // against the previous one.
  await unlink(standaloneInitialStatePath(name, dir)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
  try {
    await writeStandaloneInitialState(name, await exportState(), dir);
  } catch (err) {
    console.error(
      `pome twin start: could not snapshot the ${name} twin's state for \`pome twin tape --diff\`: ${(err as Error).message}`,
    );
  }
}
