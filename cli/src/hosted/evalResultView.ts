// SPDX-License-Identifier: Apache-2.0
//
// Cloud-verdict DISPLAY model + pure label/render helpers (FDRS-656/657).
//
// The OSS CLI is CAPTURE-ONLY: it never computes a score, never runs a judge,
// and never correlates locally. Every helper here operates on a score object
// that ORIGINATES FROM THE CLOUD (a hosted `pome run` /finalize response, or a
// `pome eval` upload verdict — see `scoreFromFinalizeResponse`). Nothing in
// this module derives a verdict from twin state, events, or a judge call.
//
// This is the relocation of the former `src/evaluator/score.ts` + the
// verdict-rendering half of `src/cli/render.ts`. The local scoring engine
// (`scoreResults`, the deterministic matchers, the BYOK LLM judge) was deleted
// under FDRS-657; only the pure display model survives, moved out of the
// `evaluator/` tree so the `no-eval-in-oss` gate can assert that tree is gone.
//
// F-689/D16 — moved AGAIN from `src/score/view.ts` to here. `score/` (a
// module-name stem the repo-wide gate now denies outright) has to cease to
// exist, so this pure display model lives under `hosted/` with the rest of
// the cloud-facing surface it renders.

// Wire-side criterion, NOT the scenario-markdown one: cloud responses carry
// the unified "code"/"model" vocabulary (legacy "D"/"P" tolerated) while
// scenario files still parse [code]/[model] markers. This module renders CLOUD
// verdicts, so it takes the wide wire shape (FDRS-643 live-run finding).
import type { z } from "zod";
import type { criterionSchema } from "../types/shared.js";

type WireCriterion = z.infer<typeof criterionSchema>;

// FDRS-591 + FDRS-611 — unified per-criterion outcome model as reported by the
// cloud judge.
//
//   passed   — criterion evaluated and satisfied.
//   failed   — criterion evaluated and NOT satisfied.
//   skipped  — the cloud could not evaluate this criterion.
//   errored  — judge/infra failure while evaluating.
//
// `skipped` and `errored` are BOTH excluded from the satisfaction denominator
// (only `passed`/`failed` count) but are surfaced as explicit counts so a run
// that evaluated nothing renders as "incomplete", never as a hard 0%.
export type CriterionOutcome = "passed" | "failed" | "skipped" | "errored";

export type CriterionResult = {
  criterion: WireCriterion;
  // FDRS-591/611: explicit four-state outcome. ADDITIVE + OPTIONAL — when
  // absent (older cloud producers) it is derived from `passed`/`skipped` via
  // `outcomeOf`.
  outcome?: CriterionOutcome;
  passed: boolean;
  // Wire-compat: `skipped` stays a boolean and is TRUE for both `skipped` and
  // `errored` outcomes.
  skipped: boolean;
  reason: string;
  // [model]-only fields, populated by the cloud judge.
  confidence?: number;
  judge_model?: string;
  judge_tokens_in?: number;
  judge_tokens_out?: number;
  judge_has_usage?: boolean;
};

export type Score = {
  // passed / (passed + failed), rounded to 0-100. 0 when nothing was evaluated
  // — callers MUST consult `evaluated`/`can_pass` before reading this as a
  // verdict, since a 0 here means "not evaluated", not "hard fail".
  satisfaction: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  // F-1392 — the SUBSET of `skipped` excluded because the seed already
  // satisfied it (`PRE_SATISFIED_REASON`/`isPreSatisfied` above). Not a
  // separate outcome — these criteria still count in `skipped` and still
  // render with the `-` marker (`outcomeOf` keeps mapping them to
  // `"skipped"`) — but they are not abstentions, so `can_pass` and
  // `runScoreLine` subtract this count back out of the "not evaluated" tally.
  preSatisfied: number;
  // = passed + failed. The satisfaction denominator.
  total_required: number;
  // false when total_required === 0 (nothing was evaluated). Renders as
  // "incomplete" instead of 0%.
  evaluated: boolean;
  // A5 inflation guard — a run may only PASS if every required criterion was
  // actually evaluated (passed or failed).
  can_pass: boolean;
  results: CriterionResult[];
  // Run-level [model] aggregates from the cloud judge. Null when absent.
  judge_model: string | null;
  judge_tokens_in: number | null;
  judge_tokens_out: number | null;
};

// Derive the four-state outcome from a cloud result. Prefers the explicit
// `outcome` field; falls back to the legacy passed/skipped booleans. PURE.
export function outcomeOf(result: CriterionResult): CriterionOutcome {
  if (result.outcome) return result.outcome;
  if (result.skipped) return "skipped";
  return result.passed ? "passed" : "failed";
}

// F-1296 (pome-cloud) stamps this reason on a criterion the seed already
// satisfied — the control plane graded the FINAL state alone, found the
// criterion true before the agent ran, and moved it out of the score
// denominator so a task cannot earn credit for doing nothing (AutomationBench's
// "no reward for doing nothing" rule). Restated here rather than imported: the
// CLI shares no code with the control plane, and this travels as a string on
// the `criteria_results` wire shape (`apps/control-plane/src/services/
// evaluators/deterministic/pre-satisfied.ts` on the pome-cloud side).
//
// F-1392 — the CLI is the fifth surface this string has to agree with
// (score-merge, run-report, run-status and drift-telemetry are the other
// four, per pre-satisfied.ts's own doc comment). Defined ONCE and read from
// here at every call site so the string is never repeated inline.
export const PRE_SATISFIED_REASON = "already_true_in_seed";

/**
 * Was this criterion excluded for having already been true in the seed?
 *
 * Mirrors the dashboard's `isPreSatisfiedResult`
 * (apps/dashboard/src/lib/run-status.ts) over the same `criteria_results`
 * wire shape — same predicate, same reason string, two repos.
 */
export function isPreSatisfied(
  result: Pick<CriterionResult, "skipped" | "reason">,
): boolean {
  return result.skipped && result.reason === PRE_SATISFIED_REASON;
}

export type ScoreStatus = "pass" | "fail" | "incomplete";

// Single source of truth for "did this run pass?", applied to a CLOUD score.
// Encodes the A5 guard: a run is only a PASS when it was evaluated, every
// required criterion was evaluated (can_pass), AND satisfaction cleared the
// threshold. PURE — no computation of the score itself.
//
// F-932 renamed the third state from `unevaluated` to `incomplete` and CHANGED
// NOTHING ELSE HERE. The guard is the one place the CLI refuses to inflate a
// partial run into a pass — the same refusal pome-cloud added server-side in
// F-925 — so the rename must not become a loosening.
//
// One rule, two repos: `can_pass` is false for any abstention EXCEPT a
// criterion the seed already satisfied (`PRE_SATISFIED_REASON` above) —
// `uploadAndFinalize.ts`'s `scoreFromFinalizeResponse` subtracts
// `preSatisfied` out of the `skipped` tally before deciding `can_pass`, and
// pome-cloud's `isRunIncomplete` subtracts the same `preSatisfied` count out
// of `notEvaluated` over the same `criteria_results`
// (apps/dashboard/src/lib/run-status.ts). F-1392 — the CLI used to count
// every `skipped` result with no exemption, which called a run INCOMPLETE
// that the dashboard called PASS. ANY OTHER skipped reason, and every
// `errored`, still fails this guard — only the one named exemption is
// narrowed. Deliberately NOT read from the wire's `all_skipped`, which is the
// narrower every-abstained predicate and would loosen this guard.
//
// The one input the two surfaces still word differently, stated so nobody
// reads the paragraph above as more agreement than there is: a run whose
// criteria are ALL pre-satisfied (nothing passed, nothing failed, so no
// denominator). Here it is `incomplete` — `evaluated` is false and the A5
// guard predates and outranks this exemption. On the dashboard
// `isRunIncomplete` is false (every abstention is exempt) and
// `deriveRunStatus` falls through to `satisfaction_score === 100`, which is 0
// for an empty denominator (`score-merge.ts`), so it renders FAILED while its
// own `verdictLine` says "nothing was at risk". The two surfaces agree on the
// only thing a CI caller can act on — neither passes it, both exit non-zero —
// and disagree on the word. Filed as F-1399 against pome-cloud rather than
// papered over here: calling it `fail` locally would blame the agent for a run in which
// nothing was ever at risk, which is the F-925 inversion pointed the other
// way. `runScoreLine` names this state explicitly instead of printing "0 of N
// criteria not evaluated".
// `cross-surface-agreement.test.ts` walks both predicates over one table of
// wire fixtures so this paragraph cannot quietly stop being true.
export function scoreStatus(score: Score, passThreshold: number): ScoreStatus {
  if (!score.evaluated || !score.can_pass) return "incomplete";
  return score.satisfaction >= passThreshold ? "pass" : "fail";
}

export function taskPassed(score: Score, passThreshold: number): boolean {
  return scoreStatus(score, passThreshold) === "pass";
}

// FDRS-591/611 per-criterion marker: ✓ passed, ✗ failed, - skipped, ! errored.
export function markerFor(outcome: CriterionOutcome): string {
  switch (outcome) {
    case "passed":
      return "✓";
    case "failed":
      return "✗";
    case "errored":
      return "!";
    default:
      return "-";
  }
}

// Multi-twin (M3): the per-criterion bracket for terminal display —
// `[code]` / `[model]`, plus the `:<twin>` suffix when the criterion attributes
// to a specific twin (so a `[code:slack]`/`[model:github]` marker survives into the
// INCOMPLETE / criteria list). A bare (primary-twin) criterion renders `[code]`
// unchanged.
export function criterionMarkerLabel(criterion: WireCriterion): string {
  return criterion.twin ? `[${criterion.type}:${criterion.twin}]` : `[${criterion.type}]`;
}

// Multi-twin (M3): when the cloud could not evaluate a criterion for a
// twin-related reason (a twin-tagged criterion, or a `no_matching_predicate`
// skip), name the twin inline so the INCOMPLETE line explains WHICH twin's timeline
// came up empty. Returns "" when there's nothing twin-specific to add.
export function twinSkipSuffix(result: CriterionResult): string {
  const twin = result.criterion.twin;
  if (!twin) return "";
  const outcome = outcomeOf(result);
  const twinRelated =
    outcome === "skipped" ||
    outcome === "errored" ||
    /no_matching_predicate|no matching predicate/i.test(result.reason);
  return twinRelated ? ` (twin: ${twin})` : "";
}

function criteriaWord(n: number): string {
  return n === 1 ? "criterion" : "criteria";
}

export function scoreCountsSummary(score: Score): string {
  return `${score.passed ?? 0} passed, ${score.failed ?? 0} failed, ${score.skipped ?? 0} skipped, ${score.errored ?? 0} errored`;
}

export function runScoreLine(
  score: Score,
  passThreshold: number,
  unevaluatedNumericLabel: string,
): string {
  const status = scoreStatus(score, passThreshold);
  if (status === "incomplete") {
    // Leads with the COUNT, which is the fact the reader needs and the same
    // fact the cloud's own header now states. The old copy said "cannot pass",
    // which is a verdict about the AGENT for a gap in the GRADER — the exact
    // inversion F-925 exists to stop, one surface over.
    //
    // F-1392 — `preSatisfied` criteria are named APART from the abstentions
    // instead of folded into "not evaluated", the way the dashboard's
    // `verdictLine` does (run-status.ts:173-199): a pre-satisfied criterion
    // reached a verdict (the grader wasn't gapped), it just tested nothing.
    const allExcluded = score.skipped + score.errored;
    const unreached = allExcluded - score.preSatisfied;
    const total = score.total_required + allExcluded;
    // The all-excluded run: nothing passed, nothing failed, and every
    // criterion that left the denominator left it because the seed already
    // satisfied it. `unreached` is 0, so the sentence below would read "0 of 2
    // criteria not evaluated" while the line calls itself incomplete — a
    // surface stating a count that contradicts its own verdict. Say what
    // actually happened, in the dashboard's words for the same shape
    // (`verdictLine`'s "nothing was at risk" branch). Still `incomplete` and
    // still exit 1: no denominator means no verified pass, which is the A5
    // guard and is older than this exemption.
    if (score.total_required === 0 && unreached === 0 && score.preSatisfied > 0) {
      return `score: incomplete — nothing was at risk (${score.preSatisfied} ${criteriaWord(score.preSatisfied)} already true in the seed); ${scoreCountsSummary(score)}; ${unevaluatedNumericLabel}: ${score.satisfaction}/100`;
    }
    const preSatisfiedClause =
      score.preSatisfied > 0 ? ` (${score.preSatisfied} already true in the seed)` : "";
    return `score: incomplete — ${unreached} of ${total} criteria not evaluated${preSatisfiedClause}; ${scoreCountsSummary(score)}; ${unevaluatedNumericLabel}: ${score.satisfaction}/100`;
  }
  return `score: ${score.satisfaction}/100`;
}
