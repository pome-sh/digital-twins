// SPDX-License-Identifier: Apache-2.0
//
// Assembles what the dashboard page renders, for every twin `pome twin start`
// booted (F-1850).
//
// Reads the twin over loopback HTTP rather than through the in-process
// `TwinHarness`, even though `twinStart` is holding the harness. Two reasons,
// and the first is not optional: `GET /_pome/state` runs `redactSecrets()` on
// the way out (`sdk/src/server.ts`, "a twin must not be able to leak secrets by
// omission") while `harness.exportState()` does not, so the in-process read
// would hand a browser the one export the engine deliberately scrubs. The
// second is that reading the contract-frozen surface keeps this renderer
// portable to a twin this process does not own.
//
// Neither endpoint is recorder-wrapped (`sdk/src/server.ts` mounts them bare)
// and CONTRACT.md pins `/_pome/state` fetches to "Never" on the tape for every
// contract twin, so polling twice a second never shows up in the tape it is
// polling.
import {
  claudeCodeCommand,
  codexConfigBlock,
  exportLine,
  mcpJsonStanza,
  type ConnectSnippetInput,
} from "../twin/connectSnippets.js";
import { censusState } from "../twin/stateDiff.js";
import { tapeRows, tapeSummary, type TapeRow } from "../twin/twinTape.js";
import type {
  ConnectSnippet,
  SnapshotResponse,
  StateDelta,
  TapeEntry,
  TwinSnapshot,
} from "@pome-sh/dashboard/api";

/**
 * How many tape entries one poll carries.
 *
 * `pome twin start` boots its recorder with no `maxEvents`, so the in-memory
 * tape grows for as long as the twin runs — re-shipping every event twice a
 * second is unbounded work for an unbounded tape. The cap is on the WIRE only:
 * `summary` is computed over every event the twin holds, so the verdict line
 * never disagrees with the twin about how many requests there were, and
 * `dropped` says out loud how many rows are behind the ones shown.
 */
export const TAPE_WINDOW = 200;

/** One booted twin, as `twinStart` knows it. */
export type DashboardTwin = {
  name: string;
  /** Session URL: `http://127.0.0.1:3441/s/standalone`. */
  restUrl: string;
  mcpUrl: string;
  token: string;
  envName: string;
  tokenEnvName?: string;
  /** The boot snapshot the world panel measures against (`twinStart.ts`). */
  initialState: unknown;
};

/** What a poll got out of one twin, or nothing if it has stopped answering. */
type TwinRead = { events: unknown; state: unknown } | null;

export type TwinReader = (twin: DashboardTwin) => Promise<TwinRead>;

/**
 * Read one twin's tape and state over loopback.
 *
 * Returns null rather than throwing on ANY failure: the twin going away is the
 * normal end of a session (the operator pressed Ctrl-C), not an error the page
 * should render as a stack trace. The caller turns null into `reachable: false`
 * and the page keeps showing the tape it already has.
 */
export const readTwinOverHttp: TwinReader = async (twin) => {
  const get = async (leaf: string): Promise<unknown> => {
    const res = await fetch(`${twin.restUrl}/_pome/${leaf}`, {
      headers: { Authorization: `Bearer ${twin.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(`${leaf} answered ${res.status}`);
    return (await res.json()) as unknown;
  };
  try {
    const [events, state] = await Promise.all([get("events"), get("state")]);
    return { events, state };
  } catch {
    return null;
  }
};

/**
 * The ways to point an agent at this twin — the same three the `twin start`
 * banner prints, built by the same functions, so the page and the terminal
 * never disagree about a flag.
 *
 * Two of them carry the token and two do not, and the page has to know which:
 * `claude mcp add` inlines the bearer (so it needs no export first, and needs
 * masking), while `.mcp.json` and Codex's `config.toml` name the
 * `POME_AUTH_TOKEN` variable (so they are inert until the export line runs).
 */
export function connectSnippetFor(twin: DashboardTwin): ConnectSnippet {
  const input: ConnectSnippetInput = {
    name: twin.name as ConnectSnippetInput["name"],
    envName: twin.envName,
    port: Number(new URL(twin.restUrl).port),
    restUrl: twin.restUrl,
    mcpUrl: twin.mcpUrl,
    token: twin.token,
    ...(twin.tokenEnvName ? { tokenEnvName: twin.tokenEnvName } : {}),
  };
  const line = exportLine(input);
  const claude = claudeCodeCommand(input);
  return {
    exportLine: line,
    exportLineMasked: maskTokens(line, twin.token),
    mcpJson: mcpJsonStanza(input),
    claudeCode: claude,
    claudeCodeMasked: maskTokens(claude, twin.token),
    codexToml: codexConfigBlock(input),
  };
}

/**
 * Replace every occurrence of the live JWT with bullets.
 *
 * NOT a security control, and the page must not claim it is: the same token is
 * printed in clear by the `twin start` banner two inches away in the terminal,
 * and the unmasked line is one click behind "Show token". It exists so that a
 * screenshot or a README GIF of this page does not carry a credential across
 * it — which is the only way this page's token ever leaves the machine.
 */
export function maskTokens(line: string, ...tokens: readonly string[]): string {
  let out = line;
  for (const token of tokens) {
    if (token.length === 0) continue;
    out = out.split(token).join("•".repeat(28));
  }
  return out;
}

/** The tape's last `TAPE_WINDOW` rows, each carrying the twin's own delta. */
function entriesFor(rows: readonly TapeRow[], events: readonly unknown[]): TapeEntry[] {
  const start = Math.max(0, rows.length - TAPE_WINDOW);
  return rows.slice(start).map((row, offset) => ({
    ...row,
    // `tapeRows` maps the event list one-to-one and in order, so index i on
    // both sides is the same request. Read defensively anyway: a row without
    // its event is a row whose detail panel says the twin reported nothing,
    // which is a state the page already has to render honestly.
    delta: deltaOf(events[start + offset]),
  }));
}

function deltaOf(event: unknown): StateDelta {
  if (event === null || typeof event !== "object") return null;
  const delta = (event as { state_delta?: unknown }).state_delta;
  if (delta === null || typeof delta !== "object") return null;
  const { before, after } = delta as { before?: unknown; after?: unknown };
  return {
    before: isRecord(before) ? before : null,
    after: isRecord(after) ? after : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One twin's panel: its tape, its verdict, and how far its world has moved. */
export async function snapshotTwin(twin: DashboardTwin, read: TwinReader): Promise<TwinSnapshot> {
  const connect = connectSnippetFor(twin);
  const base: Omit<TwinSnapshot, "entries" | "summary" | "world" | "reachable" | "dropped"> = {
    name: twin.name,
    url: twin.restUrl,
    connect,
  };
  const got = await read(twin);
  if (got === null) {
    return {
      ...base,
      reachable: false,
      entries: [],
      dropped: 0,
      summary: { requests: 0, changed_state: 0, writes_not_landed: 0, unsupported: 0, reads: 0 },
      world: [],
    };
  }
  const sessionPath = new URL(twin.restUrl).pathname;
  const rows = tapeRows(got.events, sessionPath);
  const events = Array.isArray(got.events) ? got.events : [];
  return {
    ...base,
    reachable: true,
    entries: entriesFor(rows, events),
    dropped: Math.max(0, rows.length - TAPE_WINDOW),
    // Over every row, not the windowed slice: the verdict line is a claim
    // about the session, and a capped count would quietly under-report the
    // one number this page exists to show.
    summary: tapeSummary(rows),
    world: censusState(twin.initialState, got.state),
  };
}

/** Every twin this process booted, in the order `twin start` named them. */
export async function buildSnapshot(
  twins: readonly DashboardTwin[],
  read: TwinReader = readTwinOverHttp,
): Promise<SnapshotResponse> {
  return {
    ts: new Date().toISOString(),
    twins: await Promise.all(twins.map((twin) => snapshotTwin(twin, read))),
  };
}
