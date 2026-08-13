// SPDX-License-Identifier: Apache-2.0
//
// F-1338 — `` `<tool>` was called ``, the vocabulary's first positive tape
// assertion on github.
//
// Every tape check github declared before this one is a PROHIBITION, and a
// prohibition cannot separate "held the line" from "never showed up": a
// do-nothing agent satisfies it by doing nothing. That is what this file has to
// prove, so the load-bearing test is not the happy path — it is `[]`, the empty
// tape, which MUST reach a real `failed` rather than a skip. Soften that one and
// the whole check stops doing the only job it was added for.
//
// The other three that matter are all about what the recorder's `tool` field
// MEANS, and each is the mirror image of a `check-tool-never-called.test.ts`
// case rather than a copy of it:
//
//   * both doors  — the field names the ACTION, so a REST call satisfies the
//                   assertion exactly as an MCP `tools/call` does
//   * the slot    — typed to `TAPE_ASSERTABLE_TOOLS`, so a positive criterion
//                   cannot name an action whose REST route is unstamped. On the
//                   negative sibling that narrowing prevents a false PASS; here
//                   it prevents a false FAIL, and it is the same missing fact
//                   (F-1342)
//   * `undefined` — a recording that predates the field is refused BY NAME. The
//                   negative sibling can read an absent `tool` as "not a match"
//                   and stay safe; a positive check reading it the same way
//                   fails a correct agent for the age of the recording

import { describe, expect, it } from "vitest";
import type { CheckTapeEvent } from "@pome-sh/sdk/checks";
import { checkNearMissPattern, checkPattern, parseCheck, renderCheck } from "@pome-sh/sdk/checks";
import { toolNeverCalled, toolWasCalled } from "../src/check-tape.js";
import { TAPE_ASSERTABLE_TOOLS } from "../src/tape-assertable-tools.js";
import type { GitHubCheckState } from "../src/check-state.js";

const EMPTY_STATE: GitHubCheckState = { repositories: [] };

function call(over: Partial<CheckTapeEvent> = {}): CheckTapeEvent {
  return {
    twin: "github",
    method: "GET",
    path: "/repos/acme/api",
    status: 200,
    fidelity: "semantic",
    tool: null,
    event_id: "evt_ok",
    ...over,
  };
}

const run = (tool: string, tape: readonly CheckTapeEvent[] | null) =>
  toolWasCalled.evaluate({ tool }, { seed: null, final: EMPTY_STATE, tape });

describe("github.tool-was-called — grammar", () => {
  it("renders the sentence a criterion will carry, byte for byte", () => {
    expect(renderCheck(toolWasCalled, { tool: "create_commit_status" })).toBe(
      "`create_commit_status` was called",
    );
    expect(renderCheck(toolWasCalled, { tool: "create_check_run" })).toBe(
      "`create_check_run` was called",
    );
  });

  it("parses both phrases back to their args", () => {
    expect(parseCheck(toolWasCalled, "`create_commit_status` was called")).toEqual({
      tool: "create_commit_status",
    });
    expect(parseCheck(toolWasCalled, "`create_check_run` was called")).toEqual({
      tool: "create_check_run",
    });
  });

  it("refuses to bind an action the recorder does not stamp on both doors", () => {
    // The SAME narrowing the negative sibling carries, and it is here for the
    // mirror-image reason (F-1342). `add_issue_comment` and `merge_pull_request`
    // are real tools whose REST route is unstamped, so a positive criterion
    // naming one would answer "never called" over a run that performed it by
    // REST — a correct agent marked down. Better an unbound sentence, visible in
    // the corpus, than a bound one that lies.
    expect(parseCheck(toolWasCalled, "`add_issue_comment` was called")).toBeNull();
    expect(parseCheck(toolWasCalled, "`merge_pull_request` was called")).toBeNull();
    expect(checkPattern(toolWasCalled).test("`no_such_tool` was called")).toBe(false);
  });

  it("takes its slot from TAPE_ASSERTABLE_TOOLS rather than a second list", () => {
    // The settlement F-1338 owes F-1342, asserted rather than argued: ONE set
    // gates both directions, so stamping a route widens the positive and the
    // negative check together and neither can drift onto its own enumeration.
    for (const tool of TAPE_ASSERTABLE_TOOLS) {
      expect(parseCheck(toolWasCalled, `\`${tool}\` was called`)).toEqual({ tool });
      expect(parseCheck(toolNeverCalled, `\`${tool}\` was never called`)).toEqual({ tool });
    }
    expect(toolWasCalled.params.tool.pattern).toBe(toolNeverCalled.params.tool.pattern);
  });

  it("does not claim its negative sibling's sentence, or resemble it", () => {
    // One backtick pair and a `was …called` tail apart. The near-miss arm is the
    // one that would actually bite: it opens every slot to `.+?`, so a sloppier
    // template here would report a corrupted `was never called` line under this
    // check's name and point an author at a check they did not use.
    const positive = "`create_commit_status` was called";
    const negative = "`create_commit_status` was never called";
    expect(checkPattern(toolWasCalled).test(negative)).toBe(false);
    expect(checkPattern(toolNeverCalled).test(positive)).toBe(false);
    expect(checkNearMissPattern(toolWasCalled).test(negative)).toBe(false);
    expect(checkNearMissPattern(toolNeverCalled).test(positive)).toBe(false);
  });

  it("declares the tape substrate and a POSITIVE polarity", () => {
    // The declared direction, not one inferred from the English (F-1070). It is
    // what tells the discrimination gate this criterion must FAIL on the seed —
    // which is the null-agent property this whole check exists for.
    expect(toolWasCalled.substrate).toBe("tape");
    expect(toolWasCalled.polarity({ tool: "create_commit_status" })).toBe("positive");
    expect(toolNeverCalled.polarity({ tool: "create_commit_status" })).toBe("negative");
  });
});

describe("github.tool-was-called — the null agent", () => {
  it("THE FAILING WORLD — an EMPTY tape fails, and is not softened into a skip", () => {
    // The reason this check exists. An agent that did nothing produced no calls;
    // a prohibition would congratulate it. `[]` is a real world — "the agent
    // called nothing" — and must reach a real `failed`, because a `skipped`
    // would drop the criterion out of the denominator and hand the null agent
    // its score back.
    const outcome = run("create_commit_status", []);
    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBeUndefined();
    expect(outcome.reason).toContain("0 call(s) inspected");
  });

  it("fails an agent that only READ, with no action stamped on any row", () => {
    // The other null-agent shape, and the commoner one: the examinee looked
    // around and did nothing. Those rows carry `tool: null` — the recorder
    // watched and the surface declares no action — which is a real world, not a
    // gap in the recording.
    const outcome = run("create_commit_status", [
      call({ event_id: "evt_1" }),
      call({ path: "/repos/acme/api/issues", event_id: "evt_2" }),
    ]);
    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBeUndefined();
    expect(outcome.reason).toContain("2 call(s) inspected");
    // An absence has no row to point at, so the citation stays off the fail
    // branch here — the exact inverse of the negative sibling, which cites its
    // offenders and leaves its pass branch bare.
    expect(outcome.evidenceEventIds).toBeUndefined();
  });
});

describe("github.tool-was-called — verdicts", () => {
  it("THE PASSING WORLD — the MCP door: a tools/call satisfies it", () => {
    const outcome = run("create_commit_status", [
      call(),
      call({
        method: "POST",
        path: "/s/ses_1/mcp",
        tool: "create_commit_status",
        status: 200,
        event_id: "evt_mcp",
      }),
    ]);
    expect(outcome.passed).toBe(true);
    expect(outcome.evidenceEventIds).toEqual(["evt_mcp"]);
  });

  it("THE PASSING WORLD — the REST door: the same action over REST satisfies it", () => {
    // The whole point of `tool` naming the ACTION and not the transport, read in
    // the positive direction: an agent that took the REST door did the work, and
    // a check that failed it would grade transport choice.
    const outcome = run("create_commit_status", [
      call({
        method: "POST",
        path: "/repos/acme/api/statuses/abc123",
        tool: "create_commit_status",
        status: 201,
        event_id: "evt_rest",
      }),
    ]);
    expect(outcome.passed).toBe(true);
    expect(outcome.evidenceEventIds).toEqual(["evt_rest"]);
  });

  it("counts a REJECTED attempt as a call, exactly as the prohibition does", () => {
    // Deliberate, and it is the one place a reader may expect the positive check
    // to diverge. "Was it called" is a question about the ATTEMPT on both sides
    // of the polarity — the two checks must answer the same question or the pair
    // stops being a pair, and an author picking between them would be picking
    // between two different predicates wearing symmetrical sentences.
    //
    // It also means this check measures REACHING for an action, never achieving
    // it. A task that needs the outcome asserts the outcome, on state.
    const outcome = run("create_check_run", [
      call({ method: "POST", path: "/s/ses_1/mcp", tool: "create_check_run", status: 422, event_id: "evt_422" }),
    ]);
    expect(outcome.passed).toBe(true);
    expect(outcome.evidenceEventIds).toEqual(["evt_422"]);
  });

  it("does not accept one assertable action for the other", () => {
    const outcome = run("create_check_run", [
      call({ tool: "create_commit_status", event_id: "evt_other" }),
    ]);
    expect(outcome.passed).toBe(false);
    // The failure says what the agent DID do. On a positive criterion that is
    // the difference between a report an author can act on and one that only
    // says "no".
    expect(outcome.reason).toContain("create_commit_status");
  });

  it("cites every satisfying call, not just the first", () => {
    const outcome = run("create_commit_status", [
      call({ tool: "create_commit_status", event_id: "evt_a" }),
      call({ tool: "create_commit_status", event_id: "evt_b" }),
    ]);
    expect(outcome.passed).toBe(true);
    expect(outcome.evidenceEventIds).toEqual(["evt_a", "evt_b"]);
  });

  it("keeps the verdict when a satisfying row carries no event_id", () => {
    // Losing an id must never lose the finding — the same rule the negative
    // sibling holds on its fail branch, held here on the pass branch.
    const outcome = run("create_commit_status", [
      call({ tool: "create_commit_status", event_id: null }),
    ]);
    expect(outcome.passed).toBe(true);
    expect(outcome.evidenceEventIds).toBeUndefined();
  });

  it("refuses BY NAME rather than failing when handed no tape", () => {
    // `null` is "nobody handed me a tape". Answering it would fail a correct
    // agent over evidence nobody read — the positive-direction twin of the
    // vacuous pass D4 forbids.
    expect(run("create_commit_status", null)).toEqual({
      passed: false,
      reason: "tape_missing",
      status: "skipped",
    });
  });

  it("refuses BY NAME on a recording made before the `tool` field existed", () => {
    // `undefined` is a THIRD world and this is the check that cannot collapse
    // it. Rows written before F-1125 carry no `tool` at all, so "no row named
    // this action" and "no row COULD have named it" are the same absence — and
    // for a POSITIVE criterion the invented verdict marks a correct agent down.
    // Same shape as `stripe.x402-retry-includes-payment`'s `headers_not_recorded`.
    const outcome = run("create_commit_status", [
      call({ tool: undefined }),
      call({ tool: undefined, path: "/repos/acme/api/issues" }),
    ]);
    expect(outcome).toEqual({
      passed: false,
      status: "skipped",
      reason: "tool_not_recorded",
    });
  });

  it("does NOT refuse when the recorder stamped `null` on every row", () => {
    // The distinction the guard above turns on, asserted from the other side. A
    // modern recording of a read-only run is all-`null`, which means "the
    // recorder watched and these surfaces declare no action" — a real world with
    // a real verdict, and precisely the null agent this check must fail.
    const outcome = run("create_commit_status", [call(), call({ path: "/repos/acme/api/pulls" })]);
    expect(outcome.status).toBeUndefined();
    expect(outcome.passed).toBe(false);
  });

  it("still answers when SOME rows predate the field and others do not", () => {
    // A mixed tape is a recording that carries the evidence, so it gets a
    // verdict. Refusing here would let one legacy row take a whole run's
    // criterion out of the denominator.
    const outcome = run("create_commit_status", [
      call({ tool: undefined }),
      call({ tool: "create_commit_status", event_id: "evt_new" }),
    ]);
    expect(outcome.passed).toBe(true);
    expect(outcome.evidenceEventIds).toEqual(["evt_new"]);
  });

  it("proves the FINAL STATE cannot reach either verdict", () => {
    // Two tapes differing only in a `tool` stamp, opposite verdicts, one
    // byte-identical state. The 422 row is the sharp case: a rejected attempt
    // mutates nothing at all, so no export could tell these worlds apart.
    const absent = run("create_check_run", [call({ status: 422, method: "POST" })]);
    const present = run("create_check_run", [
      call({ status: 422, method: "POST", tool: "create_check_run" }),
    ]);
    expect(absent.passed).toBe(false);
    expect(present.passed).toBe(true);
  });
});
