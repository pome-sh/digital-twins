// The curriculum lesson this example teaches, pinned as a property.
//
// Class 7 is cross-twin consistency: every outcome in GitHub must have its
// mirror in Slack. `shouldMirror` is the branch that decides, and the committed
// baseline defect is that it ships answering `false` for BLOCK and FLAG — so a
// pull request is correctly refused in GitHub and #eng-alerts is never told.
//
// WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT: which way `MIRROR_EVERY_OUTCOME`
// currently ships. A test that pinned the shipped value would go red the moment
// a reader applies the one-line fix the README teaches — it would be a guard you
// have to edit to make green, which is not a guard. Both branches are exercised
// by passing the flag explicitly, so the lesson survives a refactor while the
// fix stays a one-line flip.
//
// It is worth having because the defect LOOKS like dead code. `continue` on a
// non-MERGE outcome reads as an optimisation to anyone who has not read the
// README, and deleting it silently deletes the lesson.

import { describe, expect, it } from "vitest";
import { shouldMirror, type Decision } from "../src/graph.js";

const OUTCOMES: Decision["outcome"][] = ["MERGE", "BLOCK", "FLAG"];

describe("shouldMirror — the cross-twin mirror branch", () => {
  it("mirrors every outcome when MIRROR_EVERY_OUTCOME is on (the fixed variant)", () => {
    for (const outcome of OUTCOMES) {
      expect(shouldMirror(outcome, true), `${outcome} was not mirrored`).toBe(true);
    }
  });

  it("mirrors ONLY merges when it is off (the failing baseline)", () => {
    expect(shouldMirror("MERGE", false)).toBe(true);
    expect(shouldMirror("BLOCK", false)).toBe(false);
    expect(shouldMirror("FLAG", false)).toBe(false);
  });

  // The two halves of the exam, stated as one property. Tasks 01 and 02 are
  // MERGE-only and stay green under the defect; 03–06 are the non-MERGE ones
  // and flip. An example suite where every task fails cannot tell a reader WHICH
  // thing broke, so the invariance of the merge path is part of the lesson
  // rather than an accident of it.
  it("leaves the merge path identical either way — the defect is not 'Slack is broken'", () => {
    expect(shouldMirror("MERGE", false)).toBe(shouldMirror("MERGE", true));
  });

  it("differs on exactly the non-merge outcomes", () => {
    const divergent = OUTCOMES.filter(
      (outcome) => shouldMirror(outcome, false) !== shouldMirror(outcome, true),
    );
    expect(divergent).toEqual(["BLOCK", "FLAG"]);
  });
});
