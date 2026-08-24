// SPDX-License-Identifier: Apache-2.0
// The tape substrate's first declaration, and the world in which it fails.

import { describe, expect, it } from "vitest";
import type { CheckTapeEvent } from "@pome-sh/sdk/checks";
import { parseCheck, renderCheck } from "@pome-sh/sdk/checks";
import { noUnsupportedEndpoint } from "../src/check-tape.js";
import type { GitHubCheckState } from "../src/check-state.js";

const EMPTY_STATE: GitHubCheckState = { repositories: [] };

function call(over: Partial<CheckTapeEvent> = {}): CheckTapeEvent {
  return {
    twin: "github",
    method: "GET",
    path: "/repos/acme/api",
    status: 200,
    fidelity: "semantic",
    event_id: "evt_ok",
    ...over,
  };
}

const run = (tape: readonly CheckTapeEvent[] | null) =>
  noUnsupportedEndpoint.evaluate({}, { seed: null, final: EMPTY_STATE, tape });

describe("github.no-unsupported-endpoint", () => {
  it("renders and binds its sentence", () => {
    const sentence = "No unsupported endpoint was called";
    expect(renderCheck(noUnsupportedEndpoint, {})).toBe(sentence);
    expect(parseCheck(noUnsupportedEndpoint, sentence)).toEqual({});
  });

  it("declares the tape substrate and a negative polarity", () => {
    expect(noUnsupportedEndpoint.substrate).toBe("tape");
    // It should PASS on an untouched world and can only be broken by the
    // examinee reaching for a route the twin does not implement.
    expect(noUnsupportedEndpoint.polarity({})).toBe("negative");
  });

  it("passes on a clean tape, and cites nothing", () => {
    const outcome = run([call(), call({ event_id: "evt_ok2" })]);
    expect(outcome.passed).toBe(true);
    expect(outcome.reason).toContain("2 call(s) inspected");
    // A negative over an empty set has no single call to point at; citing all N
    // inspected calls would be a copy of the trace, not evidence.
    expect(outcome.evidenceEventIds).toBeUndefined();
  });

  it("THE FAILING WORLD — one unsupported call fails it, and is cited", () => {
    const outcome = run([
      call(),
      call({
        fidelity: "unsupported",
        path: "/repos/acme/api/hooks",
        status: 501,
        event_id: "evt_bad",
      }),
    ]);
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("/repos/acme/api/hooks");
    expect(outcome.evidenceEventIds).toEqual(["evt_bad"]);
  });

  it("proves the FINAL STATE cannot reach either verdict", () => {
    // The two tapes differ only in a `fidelity` stamp and produce opposite
    // verdicts against a byte-identical state. That is what makes this a tape
    // assertion rather than a state assertion in disguise — and it is why the
    // criterion was unmeasurable before this substrate existed.
    const clean = run([call()]);
    const dirty = run([call({ fidelity: "unsupported" })]);
    expect(clean.passed).toBe(true);
    expect(dirty.passed).toBe(false);
  });

  it("refuses BY NAME rather than passing when handed no tape", () => {
    // The failure this guards: a negative criterion silently passing over a
    // tape nobody read (D4 — never false-pass).
    expect(run(null)).toEqual({ passed: false, reason: "tape_missing", status: "skipped" });
  });

  it("treats an EMPTY tape as a real world, not a missing one", () => {
    // An agent that called nothing called nothing unsupported. This must be a
    // real pass, distinct from the refusal above — collapsing the two would make
    // a null agent indistinguishable from an unobserved one.
    const outcome = run([]);
    expect(outcome.passed).toBe(true);
    expect(outcome.status).toBeUndefined();
    expect(outcome.reason).toContain("0 call(s) inspected");
  });

  it("keeps the finding when an offending row carries no event_id", () => {
    const outcome = run([call({ fidelity: "unsupported", event_id: null })]);
    expect(outcome.passed).toBe(false);
    // Losing an id must never lose a finding: the count and the prose survive,
    // only the citation drops.
    expect(outcome.reason).toContain("1 unsupported");
    expect(outcome.evidenceEventIds).toBeUndefined();
  });

  it("does not treat a merely REJECTED call as unsupported", () => {
    // A 404 or 422 from a route the twin DOES implement is a semantic answer.
    // Reading any non-2xx as unsupported would fail every task whose examinee
    // legitimately probed for something absent.
    const outcome = run([call({ status: 404, fidelity: "semantic" })]);
    expect(outcome.passed).toBe(true);
  });
});
