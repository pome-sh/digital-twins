// SPDX-License-Identifier: Apache-2.0
// The CLI half — the CLI names the third state `incomplete` and stops contradicting
// the cloud.

import { ABSTAINED_SCORE_STATE, ADVISORY_SCORE_STATE } from "@pome-sh/wire/run-completeness";
import { describe, expect, it } from "vitest";
import type { CriterionResult } from "../../../src/contract/index.js";
import { finalizeResponseSchema } from "../../../src/contract/index.js";
import {
  evaluationCounts,
  isNarrated,
  isPreSatisfied,
  PRE_SATISFIED_REASON,
  runScoreLine,
  scoreStatus,
  taskPassed,
  type Score,
} from "../../../src/hosted/evalResultView.js";
import { scoreFromFinalizeResponse } from "../../../src/hosted/uploadAndFinalize.js";

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
// The one exemption: excluded because the seed already satisfied it,
// not because the grader couldn't reach a verdict.
const preSatisfied = (text: string): CriterionResult => ({
  criterion: { type: "code", text },
  passed: false,
  skipped: true,
  reason: PRE_SATISFIED_REASON,
});
// The narrator's two states. `[model]` rather than `[code]`, which is the only
// lane they occur in, and indistinguishable from `abstained()` above on the two
// booleans alone — `score_state` is the whole difference.
const advisory = (text: string): CriterionResult => ({
  criterion: { type: "model", text },
  passed: false,
  skipped: true,
  reason: "the assistant acknowledged the cancellation in its reply",
  score_state: ADVISORY_SCORE_STATE,
});
const abstainedByNarrator = (text: string): CriterionResult => ({
  criterion: { type: "model", text },
  passed: false,
  skipped: true,
  reason: "no refund was requested in this run",
  score_state: ABSTAINED_SCORE_STATE,
});

// Built by the SHIPPED producer rather than re-derived here.
function score(results: CriterionResult[], satisfaction: number): Score {
  return scoreFromFinalizeResponse({
    run_id: "run_test",
    score: satisfaction,
    dashboard_url: "https://app.pome.sh/runs/run_test",
    criteria_results: results,
  });
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
    // Older cloud builds omit the field; `scoreFromFinalizeResponse` sets
    // can_pass/evaluated true for them, so the guard is a no-op and the verdict is the raw.
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

// Pome-cloud excludes a criterion the seed already satisfied from the abstention
// denominator (`isRunIncomplete` in apps/dashboard/src/lib/run-status.ts).
describe("isPreSatisfied / PRE_SATISFIED_REASON — the one exemption, keyed on the shared reason string", () => {
  it("is true only for a skipped result with the exact reason", () => {
    expect(isPreSatisfied({ skipped: true, reason: PRE_SATISFIED_REASON })).toBe(true);
    expect(isPreSatisfied({ skipped: true, reason: "tool_not_recorded" })).toBe(false);
    // Same reason string but NOT skipped (shouldn't happen on the wire, but
    // the predicate must not key on the string alone).
    expect(isPreSatisfied({ skipped: false, reason: PRE_SATISFIED_REASON })).toBe(false);
  });
});

describe("scoreStatus — a pre-satisfied criterion is not an abstention", () => {
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

  it("is still incomplete when EVERY criterion was pre-satisfied — no denominator, no verified pass", () => {
    // The A5 guard (`total_required > 0`) predates this exemption and outranks it:
    // nothing passed and nothing failed, so there is no score to clear a threshold.
    const s = score([preSatisfied("github.no-new-issues")], 0);
    expect(s.preSatisfied).toBe(1);
    expect(s.total_required).toBe(0);
    expect(s.evaluated).toBe(false);
    expect(scoreStatus(s, 100)).toBe("incomplete");
  });

  it("never lets the exemption reach an errored criterion — it subtracts out of `skipped` only", () => {
    // `errored` has no wire producer: it is reachable only through
    // `CriterionResult.outcome`, which `finalizeResponseSchema` strips off
    // every real /finalize response (pinned in `uploadAndFinalize.test.ts`).
    // So this asserts against the DISPLAY MODEL, where the state exists,
    // rather than fabricating a finalize response that could never arrive.
    // What it pins is that `preSatisfied` is subtracted out of the SKIPPED
    // tally and nothing else — an errored criterion stays in the
    // not-evaluated count and in the copy.
    const base = score([ok("a"), preSatisfied("github.no-new-issues")], 100);
    const withError: Score = { ...base, errored: 1, can_pass: false };
    const line = runScoreLine(withError, 100, "cloud score");
    expect(line).toContain("1 of 3 criteria not evaluated");
    expect(line).toContain("1 already true in the seed");
  });
});

describe("runScoreLine — pre-satisfied criteria are named apart from abstentions", () => {
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

  it("says `nothing was at risk` for an all-excluded run instead of `0 of N criteria not evaluated`", () => {
    // Nothing passed, nothing failed, and the only criterion left the
    // denominator because the seed already satisfied it. The count-led
    // sentence would read "0 of 1 criteria not evaluated" beside the word
    // incomplete — a line that contradicts itself. Same words the dashboard's
    // `verdictLine` uses for the same shape.
    const s = score([preSatisfied("github.no-new-issues")], 0);
    const line = runScoreLine(s, 100, "cloud score");
    expect(line).toBe(
      "score: incomplete — nothing was at risk (1 criterion already true in the seed); 0 passed, 0 failed, 1 skipped, 0 errored; cloud score: 0/100",
    );
    expect(line).not.toContain("not evaluated");
  });

  it("pluralizes the all-excluded line", () => {
    const s = score(
      [preSatisfied("github.no-new-issues"), preSatisfied("github.no-new-labels")],
      0,
    );
    expect(runScoreLine(s, 100, "cloud score")).toContain(
      "nothing was at risk (2 criteria already true in the seed)",
    );
  });

  it("keeps the count-led sentence when a real abstention sits beside the exclusions", () => {
    // Not the all-excluded shape: something genuinely failed to reach a
    // verdict, so the reader needs the count and the word "not evaluated".
    const s = score([preSatisfied("github.no-new-issues"), abstained("c")], 0);
    const line = runScoreLine(s, 100, "cloud score");
    expect(line).toContain("1 of 2 criteria not evaluated (1 already true in the seed)");
    expect(line).not.toContain("nothing was at risk");
  });
});

// `evaluationCounts` is the ONE place this arithmetic exists, so `verdict.json` and
// `runScoreLine`'s "N of M criteria not evaluated" cannot drift apart.
describe("evaluationCounts — the counts verdict.json and the terminal both read", () => {
  it("a fully-evaluated run: evaluated = total, nothing left out", () => {
    const s = score([ok("a"), ok("b")], 100);
    expect(evaluationCounts(s)).toEqual({
      evaluated: 2,
      notEvaluated: 0,
      preSatisfied: 0,
      total: 2,
    });
  });

  it("an abstained criterion counts as not-evaluated, not folded into evaluated", () => {
    // This is the bug shape: 100/100 over what DID run, with a third
    // criterion that never did.
    const s = score([ok("a"), ok("b"), abstained("c")], 100);
    expect(evaluationCounts(s)).toEqual({
      evaluated: 2,
      notEvaluated: 1,
      preSatisfied: 0,
      total: 3,
    });
  });

  it("a pre-satisfied criterion is excluded from evaluated AND from notEvaluated", () => {
    const s = score([ok("a"), preSatisfied("github.no-new-issues")], 100);
    expect(evaluationCounts(s)).toEqual({
      evaluated: 1,
      notEvaluated: 0,
      preSatisfied: 1,
      total: 2,
    });
  });

  it("a genuine abstention beside a pre-satisfied exclusion counts them separately", () => {
    const s = score(
      [ok("a"), abstained("b"), preSatisfied("github.no-new-issues")],
      100,
    );
    expect(evaluationCounts(s)).toEqual({
      evaluated: 1,
      notEvaluated: 1,
      preSatisfied: 1,
      total: 3,
    });
  });

  it("every criterion pre-satisfied: no denominator, everything in preSatisfied", () => {
    const s = score([preSatisfied("github.no-new-issues")], 0);
    expect(evaluationCounts(s)).toEqual({
      evaluated: 0,
      notEvaluated: 0,
      preSatisfied: 1,
      total: 1,
    });
  });
});

// ── The narrator states, on the CLI's own surfaces ──────────────────────────
//
// The CLI does not call `isIncompleteTally`: it reaches the same verdict
// through `scoreFromFinalizeResponse`'s `can_pass` and `scoreStatus`. So the
// wire predicate learning the narrator states does NOT fix the CLI, and
// `cross-surface-agreement.test.ts` is where the two are held to one answer.
// What this block pins is the CLI half in isolation, starting with the defect
// that made every other assertion here moot.
describe("an advisory [model] row does not take the CLI's verdict", () => {
  it("survives the /finalize parse instead of being stripped", () => {
    // THE FIRST DEFECT, AND THE QUIET ONE. `criterionResultSchema` is a plain
    // `z.object` union and zod strips unknown keys, so before `score_state` was
    // declared on the BASE schema the field was discarded before any
    // arithmetic could read it — the exemption would have been correct and
    // dead. On the base and not one arm because an advisory row carries no
    // `confidence`/`judge_model` and so lands on the DETERMINISTIC arm, whose
    // `.extend({})` object is what would have done the stripping.
    const parsed = finalizeResponseSchema.parse({
      run_id: "run_x",
      score: 100,
      dashboard_url: "https://app.pome.sh/runs/run_x",
      criteria_results: [ok("a"), advisory("b"), abstainedByNarrator("c")],
    });
    expect(parsed.criteria_results?.map((r) => r.score_state)).toEqual([
      undefined,
      ADVISORY_SCORE_STATE,
      ABSTAINED_SCORE_STATE,
    ]);
  });

  it("keeps a 100/100 run with every [code] criterion scored a PASS", () => {
    // The hero row. Three scored `[code]` criteria and two `[model]` rows the
    // narrator read but had no authority to score: nothing is missing, so the
    // run has a verdict and the verdict is the score.
    const s = score([ok("a"), ok("b"), ok("c"), advisory("d"), advisory("e")], 100);
    expect(scoreStatus(s, 100)).toBe("pass");
    expect(taskPassed(s, 100)).toBe(true);
    expect(s.can_pass).toBe(true);
  });

  it("keeps an abstained [model] row from taking the verdict too", () => {
    const s = score([ok("a"), abstainedByNarrator("b")], 100);
    expect(scoreStatus(s, 100)).toBe("pass");
  });

  it("still reports INCOMPLETE when a real gap stands beside an advisory row", () => {
    // The exemption is narrow. An unreachable judge is a gap whether or not
    // the narrator also wrote prose somewhere in the same run.
    const s = score([ok("a"), advisory("b"), abstained("c")], 100);
    expect(scoreStatus(s, 100)).toBe("incomplete");
  });

  it("still reports INCOMPLETE for a [model]-only run — no denominator", () => {
    // Clause 3's shape, and the CLI reaches it by its own route: `evaluated`
    // is false because nothing was scored. Neither a pass nor a failure, so
    // `incomplete` is the honest class here as it is on the dashboard.
    const s = score([advisory("a"), advisory("b")], 0);
    expect(scoreStatus(s, 100)).toBe("incomplete");
    expect(s.evaluated).toBe(false);
  });

  it("counts the narrator rows as their own subsets of skipped", () => {
    // Subsets, not further buckets — the same discipline `preSatisfied`
    // follows, so `total` still names every criterion the run recorded and the
    // terminal line cannot under-report the width of the task.
    const s = score([ok("a"), advisory("b"), abstainedByNarrator("c")], 100);
    expect(s.skipped).toBe(2);
    expect(s.advisory).toBe(1);
    expect(s.abstained).toBe(1);
    expect(evaluationCounts(s)).toEqual({
      evaluated: 1,
      notEvaluated: 0,
      preSatisfied: 0,
      total: 3,
    });
  });

  it("names the narrator rows apart from the abstentions that DO block a pass", () => {
    // `notEvaluated` is documented as "abstentions that actually block
    // can_pass". Once the narrator rows stop blocking it, counting them there
    // would be a fresh lie in `verdict.json` — on a run whose state is `pass`.
    const s = score([ok("a"), advisory("b"), abstained("c")], 100);
    expect(evaluationCounts(s)).toEqual({
      evaluated: 1,
      notEvaluated: 1,
      preSatisfied: 0,
      total: 3,
    });
  });

  it("reads the state off `score_state` and never off the prose in `reason`", () => {
    // `reason` on an advisory row is the narrator's free text. A predicate that
    // sniffed it would exempt any judge that happened to use the word.
    expect(isNarrated(advisory("a"))).toBe(true);
    expect(isNarrated(abstainedByNarrator("a"))).toBe(true);
    expect(isNarrated(ok("a"))).toBe(false);
    const prosePretendingToBeAState: CriterionResult = {
      criterion: { type: "model", text: "a" },
      passed: false,
      skipped: true,
      reason: "the judge was advisory about it",
    };
    expect(isNarrated(prosePretendingToBeAState)).toBe(false);
  });

  it("keeps the seed exemption and the narrator exemption distinct", () => {
    const s = score([ok("a"), preSatisfied("b"), advisory("c")], 100);
    expect(s.preSatisfied).toBe(1);
    expect(s.advisory).toBe(1);
    expect(isPreSatisfied(advisory("c"))).toBe(false);
    expect(isNarrated(preSatisfied("b"))).toBe(false);
    expect(scoreStatus(s, 100)).toBe("pass");
  });
});
