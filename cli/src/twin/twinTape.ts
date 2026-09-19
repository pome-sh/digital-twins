// SPDX-License-Identifier: Apache-2.0
//
// `pome twin tape [name]` — what the agent did on a local twin (F-1837).
//
// The tape is the twin's own record of every request it served
// (`GET /_pome/events`), and until now the only way to read it on a
// standalone twin was `curl … | jq`. This command prints it as one line per
// request — time, tool or method + path, status, fidelity, and whether state
// changed — and marks the two things a reader must not miss: a call the twin
// does not model (`501 unsupported`) and a write that landed nothing, which is
// how "the agent said it did X" and "X happened" come apart. `--diff` adds
// what the run left behind, per collection, against the snapshot `twin start`
// took at boot. `--json` is the same as one envelope (F-1722's convention).
//
// Read-only: no new twin routes, no account, no hosted call. The rendering is
// pure, so the unit test runs it on a recorded fixture.

import { recorderEventSchema } from "../types/shared.js";
import { TWIN_NAMES } from "./registry.js";
import { diffState, renderStateDiff, type CollectionDiff } from "./stateDiff.js";
import {
  readStandaloneInitialState,
  readStandaloneStatusFile,
  STANDALONE_STATUS_PATH,
  standaloneInitialStatePath,
  standaloneStatusEntries,
  type StandaloneStatus,
} from "./twinStatusFile.js";

export type TapeRow = {
  ts: string;
  method: string;
  /** Path relative to the session (`/repos/acme/api`, `/mcp`). */
  path: string;
  tool: string | null;
  status: number;
  fidelity: string;
  state_mutation: boolean;
  error: string | null;
  /** `read` for GET/HEAD/OPTIONS, `write` for everything else. */
  kind: "read" | "write";
  /** The mark a reader must not miss, or null. */
  note: string | null;
};

export type TapeSummary = {
  requests: number;
  changed_state: number;
  writes_not_landed: number;
  unsupported: number;
  reads: number;
};

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// An MCP tool call is always an HTTP POST, so its method says nothing about
// whether it meant to change anything. The tool's name does: `create_issue`,
// `add_issue_comment`, `slack_post_message` intend a change; `list_issues`,
// `get_file_contents`, `search_channels` do not. A tool with no such verb is
// read as a read — a wrong guess there costs one missing mark, never a false
// "did not land".
const WRITE_VERBS = new Set([
  "create", "update", "delete", "remove", "add", "set", "post", "send", "merge", "close",
  "reopen", "assign", "unassign", "apply", "archive", "unarchive", "cancel", "push", "fork",
  "star", "unstar", "label", "unlabel", "comment", "reply", "edit", "move", "rename", "invite",
  "kick", "join", "leave", "pin", "unpin", "react", "upload", "trash", "untrash", "modify",
  "insert", "import", "batch", "submit", "request", "dismiss", "approve", "reject", "resolve",
  "transfer", "attach", "detach", "refund", "capture", "confirm", "void", "finalize", "pay",
  // Slack's `conversations.open` (opens a DM) and `chat.scheduleMessage`. Checked
  // against all 115 MCP tool names across the five twins: neither word turns a
  // read into a write, and `schedule` fixes `slack_schedule_message`, a write
  // this list used to read as a read.
  "open", "schedule",
  // GitHub's consolidated `issue_write` and Linear's `save_issue`,
  // `save_project`, `save_document` — found by a real Claude Code session, whose
  // failed `issue_write` would otherwise never have been marked. Every tool that
  // declares `readOnlyHint` is now checked against this list
  // (`requestKind.test.ts`).
  "write", "save",
]);

/**
 * Nouns whose words would otherwise read as verbs. `pull_request_read` is a
 * read; split naively, its `request` is on the list above and it came out as a
 * write that "did not land" on every call.
 */
const COMPOUND_NOUNS: ReadonlyArray<[RegExp, string]> = [[/pull_request/gi, "pullrequest"]];

/**
 * The words of a tool or method name: `create_issue` → create, issue;
 * `chat.postMessage` → chat, post, message. camelCase splits too, because Slack
 * names its methods that way and the verb is the second word, not the first.
 */
function nameWords(name: string): string[] {
  let joined = name;
  for (const [compound, noun] of COMPOUND_NOUNS) joined = joined.replace(compound, noun);
  return joined
    .split(/[_\-.]|(?=[A-Z])/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

function namesAWrite(name: string): boolean {
  return nameWords(name).some((word) => WRITE_VERBS.has(word));
}

/** `/mcp` (streamable HTTP) and the legacy `/mcp/call`, `/mcp/tools/:name` doors. */
function isMcpTransport(path: string): boolean {
  return path === "/mcp" || path.startsWith("/mcp/");
}

/**
 * A Slack-style Web API method: one path segment, dotted, `noun.verbPhrase` —
 * `/conversations.list`, `/chat.postMessage`, `/users.profile.get`.
 *
 * ONE segment is the discriminator. GitHub's `/repos/acme/api/contents/src/index.ts`
 * also ends in a dotted name, and reading its `PUT` by the "verb" in `index.ts`
 * would call a file write a read.
 */
function isRpcMethod(path: string): boolean {
  return /^\/[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/.test(path);
}

/**
 * What a GraphQL request body asks for: `mutation` is a write; `query`,
 * `subscription` and the `{ … }` shorthand are reads.
 *
 * Reads the operation the request names (`operationName`), else the first one,
 * skipping `fragment` definitions and ignoring comments and string literals —
 * a query whose argument happens to contain the word "mutation" is still a
 * query. A batch (an array of bodies) is a write if any member is. Anything it
 * cannot read comes back undefined, and the caller treats that as a read: the
 * safe direction, because a write read as a read loses a mark while a read
 * read as a write prints a false "did not land".
 */
export function graphqlOperationKind(body: unknown): "read" | "write" | undefined {
  if (Array.isArray(body)) {
    const kinds = body.map(graphqlOperationKind);
    if (kinds.includes("write")) return "write";
    return kinds.some((kind) => kind === "read") ? "read" : undefined;
  }
  if (body === null || typeof body !== "object") return undefined;
  const { query, operationName } = body as { query?: unknown; operationName?: unknown };
  if (typeof query !== "string") return undefined;

  const source = query
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/#[^\n]*/g, "");

  // Top-level definitions only. Braces set the depth; parentheses are skipped
  // whole, because a variable default (`$f: Filter = {a: 1}`) puts a brace at
  // depth zero that is not a selection set. A top-level `{` opens the selection
  // set of whatever keyword came before it — an operation, a fragment — or, with
  // nothing before it, is the `{ … }` query shorthand.
  type Operation = { type: "query" | "mutation" | "subscription"; name?: string };
  const operations: Operation[] = [];
  let depth = 0;
  let parens = 0;
  let pending: "operation" | "fragment" | null = null;
  const tokens = /[{}()]|\b(query|mutation|subscription|fragment)\b\s*([A-Za-z_]\w*)?/g;
  for (const [token, keyword, name] of source.matchAll(tokens)) {
    if (token === "(") parens += 1;
    else if (token === ")") parens = Math.max(0, parens - 1);
    else if (parens > 0) continue;
    else if (token === "{") {
      if (depth === 0) {
        if (pending === null) operations.push({ type: "query" });
        pending = null;
      }
      depth += 1;
    } else if (token === "}") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && keyword !== undefined) {
      if (keyword === "fragment") {
        pending = "fragment";
      } else {
        operations.push({ type: keyword as Operation["type"], ...(name ? { name } : {}) });
        pending = "operation";
      }
    }
  }
  const chosen =
    typeof operationName === "string"
      ? operations.find((operation) => operation.name === operationName)
      : operations[0];
  if (chosen === undefined) return undefined;
  return chosen.type === "mutation" ? "write" : "read";
}

/**
 * Read or write.
 *
 * The HTTP method answers it for a REST route, and says nothing at all for the
 * three transports that send every call as a POST: MCP (the tool name decides),
 * GraphQL (the operation type decides — Linear), and Slack's Web API (the
 * method name decides — `@slack/web-api` POSTs `conversations.list`). Reading
 * those three by method made every Linear query and every Slack SDK read print
 * "write did not land", which is the one sentence the dashboard exists to say
 * truthfully.
 */
export function requestKind(
  method: string,
  path: string,
  tool: string | null,
  body?: unknown,
): "read" | "write" {
  if (tool && isMcpTransport(path)) return namesAWrite(tool) ? "write" : "read";
  if (path === "/graphql" || path.endsWith("/graphql")) {
    // GraphQL over GET cannot carry a mutation, per the spec.
    if (READ_METHODS.has(method)) return "read";
    return graphqlOperationKind(body) ?? "read";
  }
  if (isRpcMethod(path)) return namesAWrite(path.slice(1)) ? "write" : "read";
  return READ_METHODS.has(method) ? "read" : "write";
}

/** The tape as rows, with the session prefix stripped from every path. */
export function tapeRows(events: unknown, sessionPath: string): TapeRow[] {
  if (!Array.isArray(events)) {
    throw new Error("pome twin tape: the twin answered /_pome/events with something other than a list.");
  }
  return events.map((raw, index) => {
    const parsed = recorderEventSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `pome twin tape: event ${index + 1} on the tape is not a recorded event — ${parsed.error.issues[0]?.message ?? "unrecognized shape"}.`,
      );
    }
    const event = parsed.data;
    const method = event.method.toUpperCase();
    const path = event.path.startsWith(sessionPath) ? event.path.slice(sessionPath.length) || "/" : event.path;
    const kind = requestKind(method, path, event.tool ?? null, event.request_body);
    let note: string | null = null;
    if (event.fidelity === "unsupported" || event.status === 501) {
      note = "not modelled by this twin";
    } else if (event.idempotency_dedupe) {
      note = "replayed from the idempotency cache";
    } else if (kind === "write" && !event.state_mutation) {
      note = event.status >= 400 ? `write did not land (${event.status})` : "write landed nothing";
    }
    if (event.error) note = note ? `${note}; error: ${event.error}` : `error: ${event.error}`;
    return {
      ts: event.ts,
      method,
      path,
      tool: event.tool ?? null,
      status: event.status,
      fidelity: event.fidelity,
      state_mutation: event.state_mutation,
      error: event.error,
      kind,
      note,
    };
  });
}

export function tapeSummary(rows: readonly TapeRow[]): TapeSummary {
  return {
    requests: rows.length,
    changed_state: rows.filter((row) => row.state_mutation).length,
    writes_not_landed: rows.filter((row) => row.note?.startsWith("write ")).length,
    unsupported: rows.filter((row) => row.note?.startsWith("not modelled")).length,
    // A row that changed state is counted there and nowhere else, whatever its
    // name suggests: before, a `changed` row whose tool the verb list misread
    // was counted twice, and "4 requests: 2 changed · 1 did not land · 2 reads"
    // summed to five.
    reads: rows.filter((row) => row.kind === "read" && !row.note && !row.state_mutation).length,
  };
}

/** What the REQUEST column says: the tool for an MCP call, else the route. */
export function requestLabel(row: TapeRow): string {
  if (row.tool && isMcpTransport(row.path)) return row.tool;
  if (row.tool) return `${row.method} ${row.path} (${row.tool})`;
  return `${row.method} ${row.path}`;
}

function stateLabel(row: TapeRow): string {
  if (row.state_mutation) return "changed";
  return row.kind === "read" ? "read" : "no change";
}

/** The human tape: a header, one aligned line per request, one summary line. */
export function renderTape(
  rows: readonly TapeRow[],
  where: { twin: string; url: string },
): string[] {
  const lines = [`${where.twin} twin at ${where.url} — ${rows.length} request${rows.length === 1 ? "" : "s"}`];
  if (rows.length === 0) {
    lines.push("(nothing recorded yet — connect an agent and ask it for something)");
    return lines;
  }
  const cells = rows.map((row) => ({
    time: row.ts.length >= 23 ? row.ts.slice(11, 23) : row.ts,
    request: requestLabel(row),
    status: String(row.status),
    fidelity: row.fidelity,
    state: stateLabel(row),
    note: row.note,
  }));
  const width = (pick: (cell: (typeof cells)[number]) => string, min: number) =>
    Math.max(min, ...cells.map((cell) => pick(cell).length));
  const w = {
    time: width((c) => c.time, 4),
    request: width((c) => c.request, 7),
    status: width((c) => c.status, 6),
    fidelity: width((c) => c.fidelity, 8),
    state: width((c) => c.state, 5),
  };
  lines.push("");
  lines.push(
    [
      "TIME".padEnd(w.time),
      "REQUEST".padEnd(w.request),
      "STATUS".padEnd(w.status),
      "FIDELITY".padEnd(w.fidelity),
      "STATE".padEnd(w.state),
    ]
      .join("  ")
      .trimEnd(),
  );
  for (const cell of cells) {
    const line = [
      cell.time.padEnd(w.time),
      cell.request.padEnd(w.request),
      cell.status.padEnd(w.status),
      cell.fidelity.padEnd(w.fidelity),
      cell.state.padEnd(w.state),
    ].join("  ");
    lines.push(cell.note ? `${line}  ← ${cell.note}` : line.trimEnd());
  }
  const summary = tapeSummary(rows);
  const parts = [`${summary.changed_state} changed state`];
  if (summary.writes_not_landed) {
    parts.push(`${summary.writes_not_landed} write${summary.writes_not_landed === 1 ? "" : "s"} did not land`);
  }
  if (summary.unsupported) parts.push(`${summary.unsupported} unsupported`);
  parts.push(`${summary.reads} read${summary.reads === 1 ? "" : "s"}`);
  lines.push("");
  lines.push(`${summary.requests} request${summary.requests === 1 ? "" : "s"}: ${parts.join(" · ")}`);
  return lines;
}

export type TapeEnvelope = {
  twin: string;
  url: string;
  requests: TapeRow[];
  summary: TapeSummary;
  diff?: CollectionDiff[];
};

/** Which recorded twin the command means. */
export function pickRecordedTwin(
  entries: readonly StandaloneStatus[],
  name: string | undefined,
): StandaloneStatus {
  if (entries.length === 0) {
    throw new Error(
      `No standalone twin status found. Start one with \`pome twin start <${TWIN_NAMES.join("|")}>\`.`,
    );
  }
  if (name === undefined) {
    if (entries.length === 1) return entries[0]!;
    throw new Error(
      `pome twin tape: ${entries.length} twins are recorded in ${STANDALONE_STATUS_PATH} (${entries
        .map((entry) => entry.name)
        .join(", ")}) — name one: pome twin tape ${entries[0]!.name}`,
    );
  }
  const found = entries.find((entry) => entry.name === name);
  if (found) return found;
  throw new Error(
    `pome twin tape: no ${name} twin is recorded in ${STANDALONE_STATUS_PATH} (recorded: ${entries
      .map((entry) => entry.name)
      .join(", ")}). Start it with \`pome twin start ${name}\`.`,
  );
}

async function fetchTwin(entry: StandaloneStatus, leaf: string): Promise<unknown> {
  const url = `${entry.rest_url}/_pome/${leaf}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${entry.auth_token}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error(
      `pome twin tape: the ${entry.name} twin is not answering at ${entry.rest_url} — start it with \`pome twin start ${entry.name}\`.`,
    );
  }
  if (res.status === 401) {
    throw new Error(
      `pome twin tape: the ${entry.name} twin refused the token in ${STANDALONE_STATUS_PATH} (it may be from an earlier start) — restart it with \`pome twin start ${entry.name}\`.`,
    );
  }
  if (!res.ok) {
    throw new Error(`pome twin tape: ${url} answered ${res.status}.`);
  }
  return (await res.json()) as unknown;
}

export async function runTwinTapeCommand(
  nameArg: string | undefined,
  options: { diff?: boolean; json?: boolean },
): Promise<void> {
  const entry = pickRecordedTwin(standaloneStatusEntries(await readStandaloneStatusFile()), nameArg);
  const rows = tapeRows(await fetchTwin(entry, "events"), new URL(entry.rest_url).pathname);

  let diff: CollectionDiff[] | undefined;
  if (options.diff) {
    const initial = await readStandaloneInitialState(entry.name);
    if (initial === undefined) {
      throw new Error(
        `pome twin tape --diff: no boot snapshot at ${standaloneInitialStatePath(entry.name)} — the ${entry.name} twin was started by an older pome. Restart it with \`pome twin start ${entry.name}\`.`,
      );
    }
    diff = diffState(initial, await fetchTwin(entry, "state"));
  }

  if (options.json) {
    const envelope: TapeEnvelope = {
      twin: entry.name,
      url: entry.rest_url,
      requests: rows,
      summary: tapeSummary(rows),
      ...(diff !== undefined ? { diff } : {}),
    };
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  for (const line of renderTape(rows, { twin: entry.name, url: entry.rest_url })) console.log(line);
  if (diff !== undefined) {
    console.log("");
    for (const line of renderStateDiff(diff)) console.log(line);
  }
}
