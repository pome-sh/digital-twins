// SPDX-License-Identifier: Apache-2.0
//
// What one tape entry IS, in the four words the page speaks — and the handful
// of facts about it the rows, the verdict and the tabs all need.
//
// Lived inside `App.tsx` until the page grew past one component; it is here so
// it has a test, because `kindOf` is the function that decides what turns red.
import type { TapeEntry, TwinSnapshot } from "../api.js";

/** Loudest last, in the order the eye should find them. */
export type Kind = "read" | "changed" | "unmodelled" | "fail";

/**
 * Read the kind off the CLI's own `note`, rather than re-deriving it here.
 *
 * `cli/src/twin/twinTape.ts` already decided whether this was a write that did
 * not land — including the GraphQL and Slack Web API cases a POST alone cannot
 * answer — and `pome twin tape` prints the same decision. Deciding it a second
 * time in the browser is how the terminal and the page would come to disagree.
 */
export function kindOf(entry: TapeEntry): Kind {
  if (entry.note?.startsWith("not modelled")) return "unmodelled";
  if (entry.note?.startsWith("write ")) return "fail";
  return entry.state_mutation ? "changed" : "read";
}

export const OUTCOME: Record<Kind, string> = {
  read: "read",
  changed: "changed state",
  unmodelled: "not modelled by this twin",
  fail: "write did not land",
};

function isMcp(entry: TapeEntry): boolean {
  return Boolean(entry.tool) && (entry.path === "/mcp" || entry.path.startsWith("/mcp/"));
}

/** The tool for an MCP call, else the route — what `pome twin tape` prints. */
export function requestLabel(entry: TapeEntry): string {
  return isMcp(entry) && entry.tool ? entry.tool : entry.path;
}

/** `MCP` for a tool call, else the HTTP method. */
export function methodChip(entry: TapeEntry): string {
  return isMcp(entry) ? "MCP" : entry.method;
}

/** `2026-09-19T00:22:43.635Z` → `00:22:43`. */
export function clockOf(ts: string): string {
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

/**
 * The phrase behind a status code, for a reader who does not carry the table
 * in their head. The page's audience is someone who has never used Pome; `422`
 * alone asks them to already know HTTP.
 */
const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export function statusText(code: number): string {
  const phrase = STATUS_TEXT[code];
  return phrase === undefined ? String(code) : `${code} ${phrase}`;
}

/** A stable key for an entry. Timestamps collide — several requests land in one millisecond. */
export function entryKey(entry: TapeEntry, index: number): string {
  return `${index}:${entry.ts}`;
}

/** Indexes of every entry that is a write the twin did not land, oldest first. */
export function failureIndexes(entries: readonly TapeEntry[]): number[] {
  const out: number[] = [];
  entries.forEach((entry, index) => {
    if (kindOf(entry) === "fail") out.push(index);
  });
  return out;
}

/**
 * The failure after `current`, wrapping — what clicking "N writes did not land"
 * steps to. Starts at the latest one when nothing is selected, because on a live
 * tape the latest is the one the reader has not seen yet.
 */
export function nextFailure(entries: readonly TapeEntry[], current: number | null): number | null {
  const failures = failureIndexes(entries);
  if (failures.length === 0) return null;
  if (current === null || !failures.includes(current)) return failures.at(-1) ?? null;
  const at = failures.indexOf(current);
  return failures[(at + 1) % failures.length] ?? null;
}

/** Has this twin got anything the reader must not miss? Drives the tab's colour. */
export function hasFailures(twin: TwinSnapshot): boolean {
  return twin.summary.writes_not_landed > 0;
}

/** Seconds since the last request, or null when there has been none. */
export function quietFor(entries: readonly TapeEntry[], now: number): number | null {
  const last = entries.at(-1);
  if (last === undefined) return null;
  const at = Date.parse(last.ts);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / 1000));
}
