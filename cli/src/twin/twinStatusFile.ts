// SPDX-License-Identifier: Apache-2.0
//
// `.pome/twin-status.json` — where `pome twin start` records what it booted,
// and what `pome twin status`, the docs' get-started prompts and the showcase
// scripts read back. One entry per twin under `twins` (F-1836); the top-level
// fields mirror the twin the writing command started first, so a reader of
// the older single-twin shape keeps seeing what it saw. Written owner-only,
// because it carries the bearer JWT (F-1800).

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  await writeFile(path, JSON.stringify(status, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
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
