// SPDX-License-Identifier: Apache-2.0
//
// One anonymous usage event per day, at most (F-1832).
//
// What leaves the machine: the event name, a random id minted once and kept
// in ~/.pome/telemetry.json, the CLI version, the OS, the Node major, and the
// command's name ("twin start", "init"). Never an argument, a path, a repo
// name, a seed, a token or anything from a tape. What it answers is one
// question: on a launch day, how many machines ran `pome twin start`.
//
// What stops it, in this order: `POME_TELEMETRY=0` (also `false`/`off`/`no`),
// `DO_NOT_TRACK` set to anything but `0`, `CI` set, or no ingest key baked
// into this build. The first send prints a one-line notice on stderr, once.
// The state file is written BEFORE the request goes out, so a request that
// fails (offline, blocked) is not retried until tomorrow; the request has a
// short timeout and can never fail a command.
//
// The ingest key and host are compile-time constants (tsup `define`, from
// `POME_TELEMETRY_KEY` / `POME_TELEMETRY_HOST` at build time) so a checkout
// built without them sends nothing; the same names in the environment at
// runtime override them, which is how the end-to-end test points the CLI at a
// local server. The key is a PostHog project key: write-only by design, safe
// to ship in a public binary.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

declare const POME_TELEMETRY_KEY: string | undefined;
declare const POME_TELEMETRY_HOST: string | undefined;

export const USAGE_EVENT = "cli_usage";
export const USAGE_DOCS_URL = "https://github.com/pome-sh/digital-twins#telemetry";
const DEFAULT_HOST = "https://us.i.posthog.com";
const REQUEST_TIMEOUT_MS = 1_500;

export type UsageState = {
  /** Random, minted once; not derived from anything about the machine. */
  id: string;
  /** `YYYY-MM-DD` (UTC) of the last event sent. */
  last_sent?: string;
  notice_shown?: boolean;
};

export type UsageDestination = { key: string; host: string };

// `typeof` on an undeclared identifier is safe; reading it is not. Under
// vitest (no tsup `define`) the identifiers do not exist at all.
function bakedIn(name: "key" | "host"): string | undefined {
  const value =
    name === "key"
      ? typeof POME_TELEMETRY_KEY === "string" ? POME_TELEMETRY_KEY : undefined
      : typeof POME_TELEMETRY_HOST === "string" ? POME_TELEMETRY_HOST : undefined;
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Where the event goes, or `undefined` when this build carries no key. */
export function telemetryDestination(env: NodeJS.ProcessEnv = process.env): UsageDestination | undefined {
  const key = env.POME_TELEMETRY_KEY || bakedIn("key");
  if (!key) return undefined;
  const host = (env.POME_TELEMETRY_HOST || bakedIn("host") || DEFAULT_HOST).replace(/\/+$/, "");
  return { key, host };
}

/**
 * The variable that turned telemetry off, or `undefined` when it is on.
 * `POME_TELEMETRY` is off for `0`/`false`/`off`/`no`. `DO_NOT_TRACK` and `CI`
 * count as set for any value but empty or `0` — `DO_NOT_TRACK=false` is a
 * person who typed the variable, and a CI that exports `CI=false` is still a
 * CI; the conservative reading sends less, never more.
 */
export function telemetryOptOut(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const off = (value: string | undefined) => value !== undefined && /^(0|false|off|no)$/i.test(value.trim());
  const set = (value: string | undefined) => value !== undefined && value.trim() !== "" && value.trim() !== "0";
  if (off(env.POME_TELEMETRY)) return "POME_TELEMETRY";
  if (set(env.DO_NOT_TRACK)) return "DO_NOT_TRACK";
  if (set(env.CI)) return "CI";
  return undefined;
}

export function usageStatePath(): string {
  return join(homedir(), ".pome", "telemetry.json");
}

/** The properties sent: names, versions, nothing from the invocation. */
export function usageProperties(input: {
  command: string;
  version: string;
  platform?: string;
  nodeVersion?: string;
}): Record<string, unknown> {
  const nodeVersion = input.nodeVersion ?? process.version;
  return {
    command: input.command,
    cli_version: input.version,
    os: input.platform ?? process.platform,
    node_major: Number(nodeVersion.replace(/^v/, "").split(".")[0]),
    // Anonymous events: no person profile is created or updated in PostHog.
    $process_person_profile: false,
  };
}

/** `"twin start"` for `pome twin start …`, `"init"` for `pome init …`. */
export function commandName(command: { name(): string; parent?: { name(): string; parent?: unknown } | null }): string {
  const names: string[] = [];
  let current: { name(): string; parent?: { name(): string; parent?: unknown } | null } | null | undefined = command;
  while (current && current.parent) {
    names.unshift(current.name());
    current = current.parent as typeof current;
  }
  return names.join(" ");
}

export const FIRST_RUN_NOTICE =
  `pome sends one anonymous usage event per day (CLI version, OS, Node major, command name; ` +
  `no arguments, paths or repo names). Turn it off with POME_TELEMETRY=0. ${USAGE_DOCS_URL}`;

async function readState(path: string): Promise<UsageState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<UsageState>;
    if (typeof parsed.id === "string" && parsed.id.length > 0) {
      return {
        id: parsed.id,
        ...(typeof parsed.last_sent === "string" ? { last_sent: parsed.last_sent } : {}),
        ...(parsed.notice_shown === true ? { notice_shown: true } : {}),
      };
    }
  } catch {
    // absent or unreadable: start fresh
  }
  return { id: randomUUID() };
}

async function writeState(path: string, state: UsageState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** A lock a crashed process left behind is taken over after this long. */
const STALE_LOCK_MS = 30_000;

/**
 * Exclusive lock around the read-check-write, so two `pome` processes that
 * start in the same second do not both read "nothing sent today" and both
 * send (or mint two ids). `open(…, "wx")` is atomic; a holder that is not
 * released yields "skip", never a wait — the tick is not worth blocking a
 * command for.
 */
async function withStateLock<T>(path: string, fn: () => Promise<T>): Promise<T | "locked"> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
    if (age <= STALE_LOCK_MS) return "locked";
    await unlink(lockPath).catch(() => undefined);
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
    } catch {
      return "locked";
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

export type UsageTickOutcome =
  | { sent: true }
  | { sent: false; reason: "opt-out" | "no-key" | "already-today" | "request-failed"; detail?: string };

/**
 * Send today's event if none went out yet. Never throws, never blocks for
 * more than the request timeout, and writes the state file before sending
 * so a failed request is not retried until tomorrow.
 */
export async function maybeSendUsageTick(input: {
  command: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  statePath?: string;
  fetchImpl?: typeof fetch;
  notify?: (line: string) => void;
}): Promise<UsageTickOutcome> {
  const env = input.env ?? process.env;
  const optOut = telemetryOptOut(env);
  if (optOut) return { sent: false, reason: "opt-out", detail: optOut };
  const destination = telemetryDestination(env);
  if (!destination) return { sent: false, reason: "no-key" };

  const statePath = input.statePath ?? usageStatePath();
  const today = (input.now ?? new Date()).toISOString().slice(0, 10);
  let state: UsageState;
  try {
    const claimed = await withStateLock(statePath, async () => {
      const current = await readState(statePath);
      if (current.last_sent === today) return undefined;
      if (!current.notice_shown) {
        (input.notify ?? ((line: string) => console.error(line)))(FIRST_RUN_NOTICE);
        current.notice_shown = true;
      }
      current.last_sent = today;
      await writeState(statePath, current);
      return current;
    });
    if (claimed === "locked" || claimed === undefined) return { sent: false, reason: "already-today" };
    state = claimed;
  } catch (err) {
    // A home directory that cannot be written is not a reason to fail a
    // command, and without the state file there is no once-a-day guarantee,
    // so send nothing.
    return { sent: false, reason: "request-failed", detail: `state: ${(err as Error).message}` };
  }

  const body = {
    api_key: destination.key,
    event: USAGE_EVENT,
    distinct_id: state.id,
    properties: usageProperties({ command: input.command, version: input.version }),
    timestamp: (input.now ?? new Date()).toISOString(),
  };
  try {
    const res = await (input.fetchImpl ?? fetch)(`${destination.host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { sent: false, reason: "request-failed", detail: `HTTP ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: "request-failed", detail: (err as Error).message };
  }
}
