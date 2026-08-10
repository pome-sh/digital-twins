// SPDX-License-Identifier: Apache-2.0
//
// F-932 + F-925's CLI half — the CLI names the third state `incomplete` and
// stops contradicting the cloud.
//
// The symptom, from the F-920 cold walk:
//
//   UNEVAL Task 01 — Bug, happy path
//     score: un-evaluated (cannot pass) — 2 passed, 0 failed, 2 skipped, 0 errored; cloud score: 100/100
//
// Two of four criteria never ran. The CLI was RIGHT about that — 100/100 over
// the other two is not a verified pass. It expressed a correct observation in
// two broken ways: `cannot pass` reads as the agent's failure, and the state had
// no name the cloud shared.
//
// What must NOT change, and why these tests guard it: `scoreStatus` and
// `can_pass` are the A5 inflation guard. They are the one place the CLI refuses
// to inflate a partial run into a pass, which is exactly what F-925 added
// server-side. Renaming the state must not loosen it.

import { describe, expect, it } from "vitest";
import type { CriterionResult } from "../../../src/contract/index.js";
import {
  isPreSatisfied,
  PRE_SATISFIED_REASON,
  runScoreLine,
  scoreStatus,
  taskPassed,
  type Score,
} from "../../../src/hosted/evalResultView.js";

const ok = (text: string): CriterionResult => ({
  criterion: { type: "code", text },
  passed: true,
  skipped: false,
  reason: "matched",
});
const abstained = (text: string): CriterionResult => ({
  criterion: { type: "code", text },
  passed: false,
  skipped: true,
  reason: "tool_not_recorded",
});
// F-1392 — the one exemption: excluded because the seed already satisfied it,
// not because the grader couldn't reach a verdict.
const preSatisfied = (text: string): CriterionResult => ({
  criterion: { type: "code", text },
  passed: false,
  skipped: true,
  reason: PRE_SATISFIED_REASON,
});

function score(results: CriterionResult[], satisfaction: number): Score {
  const passed = results.filter((r) => !r.skipped && r.passed).length;
  const failed = results.filter((r) => !r.skipped && !r.passed).length;
  const skipped = results.filter((r) => r.skipped).length;
  const preSatisfiedCount = results.filter((r) => isPreSatisfied(r)).length;
  const totalRequired = passed + failed;
  return {
    satisfaction,
    passed,
    failed,
    skipped,
    errored: 0,
    preSatisfied: preSatisfiedCount,
    total_required: totalRequired,
    evaluated: totalRequired > 0,
    can_pass: totalRequired > 0 && skipped - preSatisfiedCount === 0,
    results,
    judge_model: null,
    judge_tokens_in: null,
    judge_tokens_out: null,
  };
}

describe("scoreStatus — the third state is named `incomplete`", () => {
  it("returns incomplete for a 100/100 run with ONE abstention", () => {
    const s = score([ok("a"), ok("b"), ok("c"), abstained("d")], 100);
    expect(scoreStatus(s, 100)).toBe("incomplete");
    expect(taskPassed(s, 100)).toBe(false);
  });

  it("returns incomplete when nothing could be evaluated", () => {
    expect(scoreStatus(score([abstained("a")], 0), 100)).toBe("incomplete");
  });

  it("leaves a fully-evaluated run exactly as it was", () => {
    expect(scoreStatus(score([ok("a")], 100), 100)).toBe("pass");
    expect(scoreStatus(score([ok("a")], 50), 100)).toBe("fail");
  });

  it("STILL refuses to inflate a partial run — the A5 guard survives the rename", () => {
    // The rename must not become a loosening. One abstention is enough, which
    // is the same rule pome-cloud's `isRunIncomplete` applies to the same
    // `criteria_results`. If this ever flips to "every", the two surfaces
    // disagree again and the CLI starts calling partial runs passes.
    const oneSkipOfFour = score([ok("a"), ok("b"), ok("c"), abstained("d")], 100);
    expect(oneSkipOfFour.can_pass).toBe(false);
    expect(taskPassed(oneSkipOfFour, 100)).toBe(false);
  });

  it("degrades to score-only when the response carried no criteria_results", () => {
    // Pre-FDRS-618 cloud builds omit the field; `scoreFromFinalizeResponse`
    // sets can_pass/evaluated true for them, so the guard is a no-op and the
    // verdict is the raw score. This is the compat the `pome run` divergence
    // was written to protect — already protected here.
    const legacy: Score = { ...score([], 100), evaluated: true, can_pass: true };
    expect(scoreStatus(legacy, 100)).toBe("pass");
  });
});

describe("runScoreLine — the copy stops blaming the agent", () => {
  const s = score([ok("a"), ok("b"), abstained("c"), abstained("d")], 100);

  it("names how many criteria were not evaluated", () => {
    const line = runScoreLine(s, 100, "cloud score");
    expect(line).toContain("incomplete");
    expect(line).toContain("2 of 4 criteria not evaluated");
  });

  it("never says `cannot pass` — that is a verdict about the agent", () => {
    expect(runScoreLine(s, 100, "cloud score")).not.toContain("cannot pass");
  });

  it("keeps the counts and the cloud score beside it", () => {
    const line = runScoreLine(s, 100, "cloud score");
    expect(line).toContain("2 passed, 0 failed, 2 skipped, 0 errored");
    expect(line).toContain("cloud score: 100/100");
  });

  it("leaves the passing line untouched", () => {
    expect(runScoreLine(score([ok("a")], 100), 100, "cloud score")).toBe(
      "score: 100/100",
    );
  });
});

// F-1392 — pome-cloud's F-1296 excludes a criterion the seed already
// satisfied from the abstention denominator (`isRunIncomplete` in
// apps/dashboard/src/lib/run-status.ts). The CLI counted every `skipped`
// result with no exemption, so a run the dashboard calls PASS came out
// `incomplete` / exit 1 in CI. These tests pin the fix at the `isPreSatisfied`
// predicate and its two call sites (`scoreStatus` via `can_pass`, and
// `runScoreLine`'s copy).
describe("isPreSatisfied / PRE_SATISFIED_REASON — the one exemption, keyed on the shared reason string", () => {
  it("is true only for a skipped result with the exact reason", () => {
    expect(isPreSatisfied({ skipped: true, reason: PRE_SATISFIED_REASON })).toBe(true);
    expect(isPreSatisfied({ skipped: true, reason: "tool_not_recorded" })).toBe(false);
    // Same reason string but NOT skipped (shouldn't happen on the wire, but
    // the predicate must not key on the string alone).
    expect(isPreSatisfied({ skipped: false, reason: PRE_SATISFIED_REASON })).toBe(false);
  });
});

describe("scoreStatus — a pre-satisfied criterion is not an abstention (F-1392)", () => {
  it("returns pass for a run whose ONLY non-passing criterion is pre-satisfied", () => {
    const s = score([ok("a"), ok("b"), preSatisfied("github.no-new-issues")], 100);
    expect(s.can_pass).toBe(true);
    expect(scoreStatus(s, 100)).toBe("pass");
    expect(taskPassed(s, 100)).toBe(true);
  });

  it("STILL returns incomplete when a genuine abstention accompanies the pre-satisfied one", () => {
    const s = score(
      [ok("a"), preSatisfied("github.no-new-issues"), abstained("d")],
      100,
    );
    expect(s.can_pass).toBe(false);
    expect(scoreStatus(s, 100)).toBe("incomplete");
  });

  it("STILL refuses to inflate a partial run for any OTHER skip reason — narrowing must not become a loosening", () => {
    const s = score([ok("a"), ok("b"), ok("c"), abstained("d")], 100);
    expect(s.can_pass).toBe(false);
    expect(scoreStatus(s, 100)).toBe("incomplete");
  });
});

describe("runScoreLine — pre-satisfied criteria are named apart from abstentions (F-1392)", () => {
  it("names the pre-satisfied count separately from the not-evaluated count, mirroring the dashboard's verdict line", () => {
    // 1 real abstention + 1 pre-satisfied — still incomplete (the abstention),
    // but the line must not say "2 of 4 criteria not evaluated": only the
    // real abstention failed to reach a verdict.
    const s = score(
      [ok("a"), ok("b"), abstained("c"), preSatisfied("github.no-new-issues")],
      100,
    );
    const line = runScoreLine(s, 100, "cloud score");
    expect(line).toContain("incomplete");
    expect(line).toContain("1 of 4 criteria not evaluated");
    expect(line).toContain("1 already true in the seed");
  });

  it("renders the plain passing line when the only skip is pre-satisfied", () => {
    const s = score([ok("a"), preSatisfied("github.no-new-issues")], 100);
    expect(runScoreLine(s, 100, "cloud score")).toBe("score: 100/100");
  });
});
