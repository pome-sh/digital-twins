// SPDX-License-Identifier: Apache-2.0
// Split out of evalResultCache.ts to keep that module under the
// file-size tripwire: this loads a trial's raw HTTP trace (events.jsonl),
// which shares no shape or helper with the verdict.json artifact that file
// reads/writes. Same behavior, just filed under its own concern.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Load a trial's captured events.jsonl (raw trace) for prompt assembly.
 *  Missing/corrupt lines are skipped — the prompt degrades, never throws. */
export async function loadTrialEvents(runDir: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  } catch {
    return [];
  }
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // Valid JSON but not an event object (`null`, `3`, `"x"`) is corrupt
      // for our purposes — renderEvent dereferences fields on it.
      if (typeof parsed === "object" && parsed !== null) events.push(parsed);
    } catch {
      // skip corrupt row
    }
  }
  return events;
}
