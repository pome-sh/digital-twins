// SPDX-License-Identifier: Apache-2.0
//
// The lead/fold rule, checked against the deltas the GitHub twin really emits
// and against the design it has to reproduce.
//
// The fixture is `cli/test/fixtures/twin-tape/github-events.json` — the same
// recorded session `pome twin tape`'s own unit test runs on. Reading the real
// bytes rather than a hand-written sample is the point: F-1850's review caught
// two invented field shapes in a comp, both from generalising off one example.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IDENTITY_KEYS,
  bracketIdentities,
  detailNote,
  foldLabel,
  formatValue,
  isEmptyValue,
  isTimestampKey,
  splitFields,
} from "../src/model/fields.js";

type Event = {
  tool: string | null;
  path: string;
  state_delta: { before: Record<string, unknown> | null; after: Record<string, unknown> | null } | null;
};

const FIXTURE = new URL(
  "../../../cli/test/fixtures/twin-tape/github-events.json",
  import.meta.url,
);
const EVENTS = JSON.parse(readFileSync(FIXTURE, "utf8")) as Event[];

/** The world paths that panel shows for this session, as `censusState` keys them. */
const WORLD_PATHS = [
  "repositories",
  "repositories[acme/api].issues",
  "repositories[acme/api].labels",
  "repositories[acme/api].files",
];

function deltaOf(predicate: (event: Event) => boolean) {
  const event = EVENTS.find(predicate);
  if (!event?.state_delta?.after) throw new Error("fixture no longer carries that delta");
  return event.state_delta;
}

function afterOf(predicate: (event: Event) => boolean): Record<string, unknown> {
  return deltaOf(predicate).after as Record<string, unknown>;
}

describe("splitFields on the recorded GitHub deltas", () => {
  it("leads a created issue with the four fields that name it", () => {
    const after = afterOf((event) => event.tool === "create_issue");
    expect(Object.keys(after)).toHaveLength(12);

    const { lead, rest } = splitFields({ before: null, after }, WORLD_PATHS);

    // Identity, then what a person asked about, then who did it.
    expect(lead.map((row) => row.field)).toEqual(["number", "title", "state", "user_login"]);
    expect(rest).toHaveLength(8);
    // The parent echo folds because the world panel already says `acme/api`.
    expect(rest.map((row) => row.field)).toContain("repo");
    expect(rest.filter((row) => row.empty).map((row) => row.field)).toEqual([
      "body",
      "assignee_login",
      "labels",
      "assignees",
      "closed_at",
    ]);
  });

  it("leads a created label with its name and colour, folding the echo and the empty", () => {
    const after = afterOf((event) => event.path.endsWith("/labels"));
    expect(Object.keys(after)).toEqual(["repo", "name", "color", "description"]);

    const { lead, rest } = splitFields({ before: null, after }, WORLD_PATHS);

    expect(lead.map((row) => row.field)).toEqual(["name", "color"]);
    expect(rest.map((row) => row.field)).toEqual(["repo", "description"]);
  });

  it("says nothing at all when the twin reported no after", () => {
    // A write that did not land and a plain read both reach the panel this way.
    expect(splitFields(null, WORLD_PATHS)).toMatchObject({ lead: [], rest: [], kind: "none" });
  });

  it("folds nothing as an echo when no world paths are supplied", () => {
    const after = afterOf((event) => event.path.endsWith("/labels"));
    const { lead } = splitFields({ before: null, after }, []);
    // Safe direction: a field shown twice beats a field hidden for a bad reason.
    expect(lead.map((row) => row.field)).toEqual(["name", "repo", "color"]);
  });
});

describe("an update reports what moved, not what it holds", () => {
  // Captured from `PATCH /repos/acme/api/issues/2` on a running twin: twelve
  // fields on both sides, three of them different. Rendering all twelve with a
  // `+` would claim the twin just added a title it never touched.
  const ISSUE = {
    repo: "acme/api",
    number: 2,
    title: "Login page returns 500 after the deploy",
    body: "Started right after the 14:00 deploy.",
    state: "open",
    user_login: "pome-agent",
    assignee_login: null,
    labels: [],
    assignees: [],
    created_at: "2026-09-18T19:56:00.661Z",
    updated_at: "2026-09-18T19:56:00.661Z",
    closed_at: null,
  };
  const CLOSED = {
    ...ISSUE,
    state: "closed",
    updated_at: "2026-09-18T19:56:39.074Z",
    closed_at: "2026-09-18T19:56:39.074Z",
  };

  it("leads with the one field a person asked about, and folds the eleven that sat still", () => {
    const split = splitFields({ before: ISSUE, after: CLOSED }, WORLD_PATHS);

    expect(split.kind).toBe("update");
    expect(split.total).toBe(12);
    expect(split.moved).toBe(3);
    // `updated_at` and `closed_at` moved too, but a timestamp is never the point.
    expect(split.lead).toEqual([
      { field: "state", value: "open → closed", empty: false, mark: "~" },
    ]);
    expect(split.rest).toHaveLength(11);
    expect(detailNote(split)).toBe("3 fields of 12 moved. The rest sat still through this call.");
  });

  it("never marks an untouched field as added", () => {
    const { rest } = splitFields({ before: ISSUE, after: CLOSED }, WORLD_PATHS);
    const title = rest.find((row) => row.field === "title");
    expect(title?.value).toBe("Login page returns 500 after the deploy");
    // Not an arrival, and not drawn as one even though it is folded away.
    expect(title?.mark).toBe("·");
    expect(rest.filter((row) => row.mark === "+")).toEqual([]);
    // It is folded, and it is not claimed as an arrival.
    expect(rest.filter((row) => row.mark === "~").map((row) => row.field)).toEqual([
      "updated_at",
      "closed_at",
    ]);
  });

  it("reads a delete as fields leaving, not arriving", () => {
    const split = splitFields({ before: { number: 1, title: "gone" }, after: null });
    expect(split.kind).toBe("delete");
    expect(split.lead.map((row) => `${row.mark}${row.field}`)).toEqual(["−number", "−title"]);
    expect(detailNote(split)).toBe("The row left. The twin reported 2 fields of what it held.");
  });

  it("says a created row arrived, with the count it arrived with", () => {
    const after = afterOf((event) => event.tool === "create_issue");
    expect(detailNote(splitFields({ before: null, after }, WORLD_PATHS))).toBe(
      "The row arrived with 12 fields. That is all the twin reported.",
    );
  });
});

describe("timestamps fold in either spelling", () => {
  it("knows GitHub's snake_case and Linear's camelCase, and nothing that merely ends in 'at'", () => {
    expect(["created_at", "updated_at", "createdAt", "lastUsedAt", "archivedAt"].map(isTimestampKey)).toEqual([
      true, true, true, true, true,
    ]);
    // `format` and `chat` end in "at"; `At` alone is not a field anyone names.
    expect(["format", "chat", "flat", "At", "status"].map(isTimestampKey)).toEqual([
      false, false, false, false, false,
    ]);
  });

  it("folds a Linear issue's timestamps out of the lead", () => {
    const { lead } = splitFields({
      before: null,
      after: { identifier: "ENG-5", title: "Fix login", createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z" },
    });
    expect(lead.map((row) => row.field)).toEqual(["identifier", "title"]);
  });
});

describe("the pieces the rule is built from", () => {
  it("treats every shape of nothing as empty, and keeps the shape visible", () => {
    expect([null, undefined, "", [], {}].map(isEmptyValue)).toEqual([true, true, true, true, true]);
    expect([0, false, "a", [1]].map(isEmptyValue)).toEqual([false, false, false, false]);
    expect([null, "", [], 0, false].map(formatValue)).toEqual(["null", '""', "[]", "0", "false"]);
  });

  it("reads every bracket identity out of the world's paths", () => {
    expect(bracketIdentities(["repositories[acme/api].issues[#2].labels"])).toEqual(
      new Set(["acme/api", "#2"]),
    );
    expect(bracketIdentities(["repositories"])).toEqual(new Set());
  });

  it("keeps the count in the disclosure label whether it is open or shut", () => {
    expect(foldLabel(8, false)).toBe("the twin recorded 8 more fields — show them");
    expect(foldLabel(8, true)).toBe("hide the other 8 fields");
    expect(foldLabel(1, false)).toBe("the twin recorded 1 more field — show them");
    expect(foldLabel(0, false)).toBe("");
  });
});

describe("identity parity with the CLI", () => {
  // The detail panel names a row and the world panel names the same row. If
  // these two lists drift, one says `#2` while the other says `1438608116`.
  it("uses the same IDENTITY_KEYS, in the same order, as cli/src/twin/stateDiff.ts", () => {
    const source = readFileSync(
      new URL("../../../cli/src/twin/stateDiff.ts", import.meta.url),
      "utf8",
    );
    const declaration = source.match(/const IDENTITY_KEYS = \[([^\]]*)\]/);
    expect(declaration, "stateDiff.ts no longer declares IDENTITY_KEYS as a literal").toBeTruthy();
    const cliKeys = [...(declaration?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(cliKeys).toEqual([...IDENTITY_KEYS]);
  });
});
