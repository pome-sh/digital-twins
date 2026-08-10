// SPDX-License-Identifier: Apache-2.0
//
// F-1392 / D3 — "no surface states more than it checked", applied to the two
// surfaces that answer ONE question: is this run a pass, a fail, or a run the
// grader did not finish?
//
// The CLI answers it in `scoreFromFinalizeResponse` + `scoreStatus`. The
// dashboard answers it in `deriveRunStatus` (`apps/dashboard/src/lib/
// run-status.ts`, pome-cloud). They share no code — the two repos publish no
// module to each other, and the only thing that crosses is the
// `criteria_results` wire shape plus one reason string. So "they agree" is a
// claim someone has to check, and until this file existed nobody did: F-1392
// was a run the CLI called INCOMPLETE and the dashboard called PASS, shipped
// for as long as it took a human to notice the two screens disagreeing.
//
// `dashboardRunStatus` below is a TRANSCRIPTION of run-status.ts, named line by
// line so a reviewer can diff it against the original, and deliberately NOT a
// generalization of it. It is the oracle, not an implementation: nothing in
// `src/` imports it. When pome-cloud changes its predicate, this table is what
// goes red.
//
// The one row where the two surfaces still differ is in the table too, marked
// `divergence`, with the reason. A known divergence with a test on it is a
// fact; the same divergence with no test on it is the F-1392 defect again.

import { describe, expect, it } from "vitest";
import type { CriterionResult } from "../../../src/contract/index.js";
import { PRE_SATISFIED_REASON, scoreStatus } from "../../../src/hosted/evalResultView.js";
import { scoreFromFinalizeResponse } from "../../../src/hosted/uploadAndFinalize.js";

// ── The oracle: pome-cloud's answer, transcribed ────────────────────────────
//
// apps/dashboard/src/lib/run-status.ts:
//   deriveCriteriaCounts  (75-95)  — skipped ⇒ notEvaluated, +preSatisfied when
//                                    the reason matches; else evaluated (+passed)
//   isRunIncomplete      (117-122) — total > 0 && notEvaluated - preSatisfied > 0
//   deriveRunStatus      (135-141) — incomplete first, then
//                                    satisfaction_score === 100 ? pass : fail
//
// The satisfaction score the dashboard reads is the run row's, which the
// control plane computes in `score-merge.ts:314-315` as
// `evaluated === 0 ? 0 : round(passed / evaluated * 100)` — the same number
// /finalize returns to the CLI, so one `satisfaction` input drives both sides
// of every row below.
type DashboardStatus = "pass" | "fail" | "incomplete";

function dashboardRunStatus(
  results: readonly CriterionResult[],
  satisfactionScore: number,
): DashboardStatus {
  let notEvaluated = 0;
  let preSatisfied = 0;
  for (const r of results) {
    if (!r.skipped) continue;
    notEvaluated += 1;
    if (r.reason === PRE_SATISFIED_REASON) preSatisfied += 1;
  }
  const total = results.length;
  if (total > 0 && notEvaluated - preSatisfied > 0) return "incomplete";
  return satisfactionScore === 100 ? "pass" : "fail";
}

// ── The CLI's answer, through the shipped path ──────────────────────────────
function cliRunStatus(
  results: CriterionResult[],
  satisfactionScore: number,
): DashboardStatus {
  const score = scoreFromFinalizeResponse({
    run_id: "run_x",
    score: satisfactionScore,
    dashboard_url: "https://app.pome.sh/runs/run_x",
    criteria_results: results,
  });
  // The dashboard's pass bar is a hard 100 (`satisfaction_score === 100`), so
  // the comparison only means anything at the CLI's matching threshold. A task
  // that lowers `passThreshold` is opting the CLI out of that agreement
  // knowingly, and the dashboard has no field to learn it from.
  return scoreStatus(score, 100);
}

const passing = (text: string): CriterionResult => ({
  criterion: { type: "code", text },
  passed: true,
  skipped: false,
  reason: "matched",
});
const failing = (text: string): CriterionResult => ({
  criterion: { type: "code", text },
  passed: false,
  skipped: false,
  reason: "state did not match",
});
const abstained = (text: string): CriterionResult => ({
  criterion: { type: "code", text },
  passed: false,
  skipped: true,
  reason: "tool_not_recorded",
});
const excluded = (text: string): CriterionResult => ({
  criterion: { type: "code", text },
  passed: false,
  skipped: true,
  reason: PRE_SATISFIED_REASON,
});

interface Row {
  name: string;
  results: CriterionResult[];
  satisfaction: number;
  expected: DashboardStatus;
  /** Set only where the two surfaces are known to word the same run
   *  differently. The value is the CLI's word; `expected` stays the
   *  dashboard's. */
  divergence?: { cli: DashboardStatus; why: string };
}

const table: Row[] = [
  {
    name: "everything passed",
    results: [passing("a"), passing("b")],
    satisfaction: 100,
    expected: "pass",
  },
  {
    name: "one criterion failed",
    results: [passing("a"), failing("b")],
    satisfaction: 50,
    expected: "fail",
  },
  {
    name: "one criterion abstained beside three passes",
    results: [passing("a"), passing("b"), passing("c"), abstained("d")],
    satisfaction: 100,
    expected: "incomplete",
  },
  {
    name: "F-925: an abstention outranks a failing score",
    results: [passing("a"), failing("b"), abstained("c")],
    satisfaction: 50,
    expected: "incomplete",
  },
  {
    name: "every criterion abstained",
    results: [abstained("a"), abstained("b")],
    satisfaction: 0,
    expected: "incomplete",
  },
  {
    // The F-1392 hero shape: support-triage-dedup scores 100 over three
    // criteria with a fourth excluded as already true in the seed. This is the
    // row that used to read pass / incomplete.
    name: "seed-excluded criterion beside three passes",
    results: [passing("a"), passing("b"), passing("c"), excluded("github.no-new-issues")],
    satisfaction: 100,
    expected: "pass",
  },
  {
    name: "seed-excluded criterion beside a real abstention",
    results: [passing("a"), excluded("github.no-new-issues"), abstained("c")],
    satisfaction: 100,
    expected: "incomplete",
  },
  {
    name: "seed-excluded criterion beside a failure",
    results: [failing("a"), excluded("github.no-new-issues")],
    satisfaction: 0,
    expected: "fail",
  },
  {
    name: "every criterion seed-excluded — no denominator",
    results: [excluded("github.no-new-issues"), excluded("github.no-new-labels")],
    satisfaction: 0,
    expected: "fail",
    divergence: {
      cli: "incomplete",
      why:
        "The dashboard exempts every abstention, falls through to " +
        "`satisfaction_score === 100`, and gets 0 because the denominator is " +
        "empty — so it renders FAILED while its own verdictLine says " +
        '"nothing was at risk". The CLI keeps the older A5 guard ' +
        "(`total_required > 0` ⇒ not evaluated ⇒ incomplete), which is the " +
        "honest word for a run in which nothing was ever at risk. Both refuse " +
        "to pass it and both exit non-zero, so no CI caller can act on the " +
        "difference; the fix belongs in pome-cloud's deriveRunStatus (F-1399), " +
        "not in a CLI that would then have to blame the agent for an empty " +
        "denominator. Retire this row when F-1399 lands.",
    },
  },
];

describe("CLI and dashboard answer `what state is this run in?` the same way (F-1392)", () => {
  for (const row of table) {
    const label = row.divergence ? `${row.name} [known divergence]` : row.name;
    it(label, () => {
      expect(dashboardRunStatus(row.results, row.satisfaction)).toBe(row.expected);
      expect(cliRunStatus(row.results, row.satisfaction)).toBe(
        row.divergence?.cli ?? row.expected,
      );
      // Whatever the word, the two surfaces must never split on the only bit
      // a CI caller can act on: did this run pass?
      expect(cliRunStatus(row.results, row.satisfaction) === "pass").toBe(
        dashboardRunStatus(row.results, row.satisfaction) === "pass",
      );
    });
  }

  it("has exactly one known divergence, and it is the empty-denominator row", () => {
    // A guard on the guard: adding a `divergence` to a row is how this file
    // would be silenced, so the count is asserted rather than left to review.
    const diverging = table.filter((row) => row.divergence);
    expect(diverging.map((row) => row.name)).toEqual([
      "every criterion seed-excluded — no denominator",
    ]);
  });
});
