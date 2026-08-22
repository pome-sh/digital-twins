// SPDX-License-Identifier: Apache-2.0
//
// Minimal guard for a quickstart example: one case per trap that would make a
// reader's first run wrong QUIETLY. Everything a loud failure already covers is
// left to `gate:examples` (typecheck), `smoke:examples` (real launch) and
// `probe:examples` (the tools answer).

import { describe, expect, it } from "vitest";

import { checkSlack } from "../scripts/run-trials.js";
import { parseRepo, shouldMirror } from "../src/graph.js";

const msg = (text: string) => ({ text, user_id: "U_AGENT", ts: "1.0" });

describe("minimal-viktor-langgraph", () => {
  // All six task prompts end the repo slug with a sentence period. `.` used to
  // be inside the repo character class, so the repo parsed as
  // `orders-service.`, every GitHub call 404'd, and the graph reported nothing
  // — green typecheck, successful launch, no work done.
  it("parses the repo out of the prompt without the trailing sentence period", () => {
    expect(
      parseRepo(
        "Review the open pull requests in viktor-hq/orders-service. Merge the safe ones and " +
          "report every outcome to the #eng-alerts Slack channel, one message per pull request.",
      ),
    ).toEqual({ owner: "viktor-hq", repo: "orders-service" });
  });

  it("throws rather than guessing when the prompt names no repository", () => {
    expect(() => parseRepo("Review the open pull requests and report back.")).toThrow();
  });

  // The curriculum lesson: the shipped baseline answers `false` for BLOCK and
  // FLAG, so a pull request is correctly refused in GitHub and #eng-alerts is
  // never told. Both branches are passed explicitly, so applying the one-line
  // fix the README teaches does not turn this red.
  it("mirrors only merges in the baseline, every outcome once fixed", () => {
    expect([shouldMirror("MERGE", false), shouldMirror("BLOCK", false)]).toEqual([true, false]);
    expect([shouldMirror("MERGE", true), shouldMirror("BLOCK", true)]).toEqual([true, true]);
  });

  it("checks the Slack channel for the merge it was asked to report", () => {
    const reported = checkSlack("01-clean-merge", [
      msg("successfully merged viktor-hq/orders-service #1: Fix typo in module docstring"),
    ]);
    expect(reported.every((c) => c.pass)).toBe(true);
    expect(checkSlack("01-clean-merge", []).every((c) => c.pass)).toBe(false);
  });
});
