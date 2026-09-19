// SPDX-License-Identifier: Apache-2.0
//
// What an entry is, and how the verdict steps between failures.
//
// `kindOf` decides what turns red, so it is tested against the CLI's own notes
// — the page must never decide a write failed that `pome twin tape` did not.
import { describe, expect, it } from "vitest";
import type { TapeEntry } from "../src/api.js";
import {
  failureIndexes,
  kindOf,
  methodChip,
  nextFailure,
  quietFor,
  requestLabel,
  statusText,
} from "../src/model/row.js";

const entry = (over: Partial<TapeEntry>): TapeEntry => ({
  ts: "2026-09-19T00:22:43.635Z",
  method: "GET",
  path: "/repos/acme/api",
  tool: null,
  status: 200,
  fidelity: "semantic",
  state_mutation: false,
  error: null,
  kind: "read",
  note: null,
  delta: null,
  ...over,
});

const read = entry({});
const changed = entry({ method: "POST", kind: "write", status: 201, state_mutation: true });
const failed = entry({ method: "POST", kind: "write", status: 404, note: "write did not land (404)" });
const landedNothing = entry({ method: "POST", kind: "write", note: "write landed nothing" });
const unmodelled = entry({ status: 501, fidelity: "unsupported", note: "not modelled by this twin" });

describe("kindOf reads the CLI's note rather than re-deciding it", () => {
  it("names the four kinds", () => {
    expect([read, changed, failed, unmodelled].map(kindOf)).toEqual([
      "read",
      "changed",
      "fail",
      "unmodelled",
    ]);
  });

  it("counts a write that landed nothing as a failure, the same as a refused one", () => {
    expect(kindOf(landedNothing)).toBe("fail");
  });

  it("does not call a read a failure however it was sent", () => {
    // A Linear query is a POST; the CLI now leaves its note null, and the page
    // must follow the note, not the method.
    expect(kindOf(entry({ method: "POST", path: "/graphql", kind: "read" }))).toBe("read");
  });
});

describe("how an entry is labelled", () => {
  it("shows the tool for an MCP call and the route otherwise", () => {
    const mcp = entry({ method: "POST", path: "/mcp", tool: "create_issue" });
    expect([requestLabel(mcp), methodChip(mcp)]).toEqual(["create_issue", "MCP"]);
    expect([requestLabel(read), methodChip(read)]).toEqual(["/repos/acme/api", "GET"]);
  });

  it("spells out a status code for a reader who does not carry the table", () => {
    expect(statusText(404)).toBe("404 Not Found");
    expect(statusText(422)).toBe("422 Unprocessable Entity");
    expect(statusText(599)).toBe("599");
  });
});

describe("stepping through failures from the verdict", () => {
  const tape = [read, failed, changed, landedNothing, read, failed];

  it("finds every failure, oldest first", () => {
    expect(failureIndexes(tape)).toEqual([1, 3, 5]);
  });

  it("starts at the latest, because on a live tape that is the unseen one", () => {
    expect(nextFailure(tape, null)).toBe(5);
    expect(nextFailure(tape, 0)).toBe(5);
  });

  it("walks forward and wraps", () => {
    expect(nextFailure(tape, 1)).toBe(3);
    expect(nextFailure(tape, 3)).toBe(5);
    expect(nextFailure(tape, 5)).toBe(1);
  });

  it("has nowhere to go on a clean tape", () => {
    expect(nextFailure([read, changed], null)).toBeNull();
  });
});

describe("how long the agent has been quiet", () => {
  const at = Date.parse("2026-09-19T00:22:43.635Z");

  it("counts whole seconds since the last request", () => {
    expect(quietFor([read], at + 12_400)).toBe(12);
  });

  it("says nothing before the first request, and never goes negative", () => {
    expect(quietFor([], at)).toBeNull();
    expect(quietFor([read], at - 5_000)).toBe(0);
  });
});
