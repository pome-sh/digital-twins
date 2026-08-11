// SPDX-License-Identifier: Apache-2.0
// F-1411 — moved out of evalResultCache.test.ts alongside the source split
// (trialEvents.ts): loadTrialEvents shares no shape or helper with the
// verdict.json artifact tests in that file.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTrialEvents } from "../../../src/hosted/trialEvents.js";

describe("loadTrialEvents", () => {
  it("skips corrupt rows and tolerates a missing file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-events-"));
    await writeFile(
      join(tmp, "events.jsonl"),
      '{"kind":"twin_http","path":"/a"}\nnot json\n\n{"kind":"twin_http","path":"/b"}\n',
      "utf8",
    );
    const events = await loadTrialEvents(tmp);
    expect(events).toHaveLength(2);
    expect(await loadTrialEvents(join(tmp, "missing"))).toEqual([]);
  });

  it("drops valid-JSON non-object rows (null, numbers, strings)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-events2-"));
    await writeFile(
      join(tmp, "events.jsonl"),
      'null\n3\n"x"\n{"kind":"twin_http","path":"/a"}\n',
      "utf8",
    );
    const events = await loadTrialEvents(tmp);
    expect(events).toHaveLength(1);
  });
});
