// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { eventSchema, type Event } from "../types/shared.js";
import { redactEvent } from "../recorder/redaction.js";

// Post-run merge of the adapter signals JSONL into the canonical
// events.jsonl. This is a pure ts-sort/interleave step implemented
// inline so the OSS capture path has no dependency on any correlator package.
//
// Three sources write events.jsonl during a self-host run:
//   1. The capture-server child appends `LlmCallEvent` rows as each CONNECT
//      tunnel closes — capture-close order, not ts-order.
//   2. The trace writer then appends `TwinHttpEvent` rows from the in-process
//      twin recorder.
//   3. This helper reads `signals.jsonl` (HookEvent / ToolUseEvent /
//      ToolResultEvent / SubagentSpawnEvent / LlmTurnEvent rows written by the
//      agent subprocess via `POME_ADAPTER_SIGNALS_PATH`), validates each line
//      against the M0 unified `eventSchema`, then **interleaves** the signal
//      rows with the existing events.jsonl rows by ts ascending and rewrites
//      the file. The merged file is the canonical view for `pome inspect`
//      + dashboard upload.
//
// Robustness: a missing signals file, an empty file, malformed JSONL lines,
// and signals that fail schema validation never crash the run. Invalid signal
// lines are dropped and counted; the caller can log the drop count. Existing
// events.jsonl rows that fail to parse are passed through unsorted at the
// head of the file so a corrupted in-flight write is never silently dropped.
/**
 * Give every twin HTTP row the tool call that caused it.
 *
 * The twin writes `parent_event_id: null` because it runs in its own process
 * and cannot know the agent-side `event_id`; the adapter knows the `event_id`
 * but never sees the twin's tape. This merge is the one place both halves are
 * in hand, so the join belongs here — and it is a pure data operation over two
 * finished files, with no dependency on the order the two writers ran in.
 *
 * The join key is the SDK's `tool_use_id`, which is what the
 * adapter stamps on `x-pome-correlation-id`. The twin persists that header as
 * `correlation_id` ALWAYS and as `tool_call_id` only when it pins
 * `stampToolCallId` (github's frozen tape shape) — so `correlation_id` is the
 * key that works for every twin, with `tool_call_id` preferred when present
 * because it is unambiguously the header rather than the request-id fallback.
 *
 * A row keeps its null parent when the id names no tool call: an older
 * `tlc_…`, a `req_…` from the no-header fallback, or a direct REST call made
 * outside any tool handler. An unresolvable parent is the honest answer there —
 * inventing one would put twin calls under tools that did not make them.
 */
export function resolveTwinHttpParents(rows: Event[]): Event[] {
  const eventIdByToolUseId = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "ToolUseEvent") eventIdByToolUseId.set(row.tool_use_id, row.event_id);
  }
  if (eventIdByToolUseId.size === 0) return rows;

  return rows.map((row) => {
    if (row.kind !== "TwinHttpEvent") return row;
    // Never overwrite a parent the writer already established.
    if (row.parent_event_id != null) return row;
    const causingToolUseId = row.tool_call_id ?? row.correlation_id ?? null;
    if (causingToolUseId === null) return row;
    const parentEventId = eventIdByToolUseId.get(causingToolUseId);
    return parentEventId === undefined ? row : { ...row, parent_event_id: parentEventId };
  });
}

export async function mergeAdapterSignalsIntoEvents(
  signalsPath: string,
  eventsJsonlPath: string,
): Promise<{ appended: number; dropped: number }> {
  let rawSignals: string;
  try {
    rawSignals = await readFile(signalsPath, "utf8");
  } catch {
    return { appended: 0, dropped: 0 };
  }

  let dropped = 0;
  const signalRows: Event[] = [];
  for (const line of rawSignals.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      dropped += 1;
      continue;
    }
    const result = eventSchema.safeParse(parsed);
    if (!result.success) {
      dropped += 1;
      continue;
    }
    signalRows.push(redactEvent(result.data));
  }

  if (signalRows.length === 0) return { appended: 0, dropped };

  let rawEvents: string;
  try {
    rawEvents = await readFile(eventsJsonlPath, "utf8");
  } catch {
    rawEvents = "";
  }

  const eventRows: Event[] = [];
  const unparseablePassthrough: string[] = [];
  for (const line of rawEvents.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unparseablePassthrough.push(line);
      continue;
    }
    const result = eventSchema.safeParse(parsed);
    if (result.success) {
      eventRows.push(redactEvent(result.data));
    } else {
      // A schema-invalid row on disk means the writer drifted from the M0
      // schema; preserving the raw line is safer than dropping it silently.
      unparseablePassthrough.push(line);
    }
  }

  // Concat, resolve twin-HTTP parentage, then stable sort by ts. ISO-8601 with
  // `Z` sorts chronologically under lexicographic compare.
  const merged = resolveTwinHttpParents(eventRows.concat(signalRows));
  merged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const sortedJsonl = merged.map((r) => JSON.stringify(r)).join("\n");
  const head = unparseablePassthrough.length > 0 ? unparseablePassthrough.join("\n") + "\n" : "";
  await writeFile(eventsJsonlPath, head + sortedJsonl + "\n");
  return { appended: signalRows.length, dropped };
}
