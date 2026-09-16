// SPDX-License-Identifier: Apache-2.0
// `pome twin tape` renders a twin's `/_pome/events` as one line per request
// with the two marks a reader must not miss (F-1837). The fixture is a real
// github twin tape: an MCP write, a REST read, a REST write, a write that
// 404'd, a call the twin does not model, and an MCP read.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  pickRecordedTwin,
  renderTape,
  requestLabel,
  tapeRows,
  tapeSummary,
  type TapeRow,
} from "../../src/twin/twinTape.js";
import type { StandaloneStatus } from "../../src/twin/twinStatusFile.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/twin-tape/github-events.json", import.meta.url));

async function fixtureRows(): Promise<TapeRow[]> {
  return tapeRows(JSON.parse(await readFile(FIXTURE, "utf8")), "/s/standalone");
}

describe("tapeRows", () => {
  it("reads every recorded request, path relative to the session", async () => {
    const rows = await fixtureRows();
    expect(rows.map(requestLabel)).toEqual([
      "create_issue",
      "GET /repos/acme/api",
      "POST /repos/acme/api/labels",
      "POST /repos/acme/api/issues/999/comments (add_issue_comment)",
      "GET /nope/unmodelled",
      "list_issues",
    ]);
    expect(rows.map((row) => row.status)).toEqual([200, 200, 201, 404, 501, 200]);
  });

  it("marks the write that did not land and the call the twin does not model", async () => {
    const rows = await fixtureRows();
    expect(rows.map((row) => row.note)).toEqual([
      null,
      null,
      null,
      "write did not land (404); error: Issue not found",
      "not modelled by this twin; error: This endpoint is not supported by this GitHub twin.",
      null,
    ]);
    // `list_issues` is an MCP POST that reads: the verb decides, not the method.
    expect(rows.map((row) => row.kind)).toEqual(["write", "read", "write", "write", "read", "read"]);
    expect(rows.map((row) => row.state_mutation)).toEqual([true, false, true, false, false, false]);
  });

  it("refuses a tape that is not a list, or a row that is not a recorded event", () => {
    expect(() => tapeRows({ events: [] }, "/s/standalone")).toThrow("something other than a list");
    expect(() => tapeRows([{ hello: "world" }], "/s/standalone")).toThrow("event 1 on the tape is not a recorded event");
  });
});

describe("tapeSummary + renderTape", () => {
  it("counts what changed, what did not land, what is unsupported and what only read", async () => {
    expect(tapeSummary(await fixtureRows())).toEqual({
      requests: 6,
      changed_state: 2,
      writes_not_landed: 1,
      unsupported: 1,
      reads: 2,
    });
  });

  it("prints a header, aligned columns, the marks, and a summary line", async () => {
    const lines = renderTape(await fixtureRows(), {
      twin: "github",
      url: "http://127.0.0.1:3441/s/standalone",
    });
    expect(lines[0]).toBe("github twin at http://127.0.0.1:3441/s/standalone — 6 requests");
    expect(lines[2]).toMatch(/^TIME +REQUEST +STATUS +FIDELITY +STATE$/);
    const rows = lines.slice(3, 9);
    expect(rows[0]).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d  create_issue +200 +semantic +changed$/);
    expect(rows[1]).toMatch(/GET \/repos\/acme\/api +200 +semantic +read$/);
    expect(rows[3]).toMatch(/404 +semantic +no change +← write did not land \(404\); error: Issue not found$/);
    expect(rows[4]).toMatch(/501 +unsupported +read +← not modelled by this twin; error: /);
    // Same column edge on every row: the STATUS column starts at one offset.
    const statusOffsets = new Set(rows.map((line) => line.search(/ {2}\d{3} /)));
    expect(statusOffsets.size).toBe(1);
    expect(lines.at(-1)).toBe("6 requests: 2 changed state · 1 write did not land · 1 unsupported · 2 reads");
  });

  it("says what to do with an empty tape", () => {
    const lines = renderTape([], { twin: "slack", url: "http://127.0.0.1:3334/s/standalone" });
    expect(lines).toEqual([
      "slack twin at http://127.0.0.1:3334/s/standalone — 0 requests",
      "(nothing recorded yet — connect an agent and ask it for something)",
    ]);
  });
});

describe("pickRecordedTwin", () => {
  const entry = (name: StandaloneStatus["name"]): StandaloneStatus => ({
    name,
    url: `http://127.0.0.1:3333/s/standalone`,
    rest_url: `http://127.0.0.1:3333/s/standalone`,
    mcp_url: `http://127.0.0.1:3333/s/standalone/mcp`,
    auth_token: "t",
  });

  it("takes the only recorded twin without a name, and names the choice when there are several", () => {
    expect(pickRecordedTwin([entry("github")], undefined).name).toBe("github");
    expect(() => pickRecordedTwin([entry("github"), entry("slack")], undefined)).toThrow(
      "2 twins are recorded in .pome/twin-status.json (github, slack) — name one: pome twin tape github",
    );
    expect(pickRecordedTwin([entry("github"), entry("slack")], "slack").name).toBe("slack");
  });

  it("says how to start a twin when none is recorded, or the named one is not", () => {
    expect(() => pickRecordedTwin([], undefined)).toThrow("No standalone twin status found");
    expect(() => pickRecordedTwin([entry("github")], "linear")).toThrow(
      "no linear twin is recorded in .pome/twin-status.json (recorded: github). Start it with `pome twin start linear`.",
    );
  });
});
