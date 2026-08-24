// SPDX-License-Identifier: Apache-2.0
//
// Cloud-verdict DISPLAY model + pure label/render helpers.
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
// under the no-eval-in-OSS rule; only the pure display model survives, moved out of the
// `evaluator/` tree so the `no-eval` lint rule can assert that tree is gone.
//
// Moved AGAIN from `src/score/view.ts` to here. `score/` (a
// module-name stem the repo-wide gate now denies outright) has to cease to
// exist, so this pure display model lives under `hosted/` with the rest of
// the cloud-facing surface it renders.

// Wire-side criterion, NOT the scenario-markdown one: cloud responses carry
// the unified "code"/"model" vocabulary (legacy "D"/"P" tolerated) while
// scenario files still parse [code]/[model] markers. This module renders CLOUD
// verdicts, so it takes the wide wire shape (a live-run finding).
import { PRE_SATISFIED_REASON } from "@pome-sh/wire/run-completeness";
import type { z } from "zod";
import type { criterionSchema } from "../types/shared.js";

type WireCriterion = z.infer<typeof criterionSchema>;

// Unified per-criterion outcome model as reported by the
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
  // Explicit four-state outcome. ADDITIVE + OPTIONAL — when
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
  // The SUBSET of `skipped` excluded because the seed already
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

// pome-cloud stamps this reason on a criterion the seed already
// satisfied — the control plane graded the FINAL state alone, found the
// criterion true before the agent ran, and moved it out of the score
// denominator so a task cannot earn credit for doing nothing (AutomationBench's
// "no reward for doing nothing" rule). It travels as a string on the
// `criteria_results` wire shape (`apps/control-plane/src/services/evaluators/
// deterministic/pre-satisfied.ts` on the pome-cloud side).
//
// The CLI is the fifth surface this string has to agree with
// (score-merge, run-report, run-status and drift-telemetry are the other
// four, per pre-satisfied.ts's own doc comment). Re-exported ONCE from here so
// every call site in this module reads one name and the string is never
// repeated inline.
//
// IMPORTED rather than restated. The comment that used to sit here
// said "restated here rather than imported: the CLI shares no code with the
// control plane", and that stopped being true when the predicate this string
// feeds moved into `@pome-sh/wire` — the package this repo publishes and
// pome-cloud consumes. A literal restated on both sides of a repo boundary is
// the D3 parallel copy with the longest possible feedback loop; a rename now
// breaks the build on whichever side has not moved, instead of quietly making
// one of them count every seed exclusion as an abstention.
export { PRE_SATISFIED_REASON };

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
// The third state was renamed from `unevaluated` to `incomplete`, and that CHANGED
// NOTHING ELSE HERE. The guard is the one place the CLI refuses to inflate a
// partial run into a pass — the same refusal pome-cloud added server-side in
// So the rename must not become a loosening.
//
// One rule, two repos: `can_pass` is false for any abstention EXCEPT a
// criterion the seed already satisfied (`PRE_SATISFIED_REASON` above) —
// `uploadAndFinalize.ts`'s `scoreFromFinalizeResponse` subtracts
// `preSatisfied` out of the `skipped` tally before deciding `can_pass`, and
// pome-cloud subtracts the same `preSatisfied` count out of `notEvaluated`
// over the same `criteria_results`. That subtraction lives in
// `@pome-cloud/contract`'s `isIncompleteTally`, which the dashboard's
// `isRunIncomplete` (apps/dashboard/src/lib/run-status.ts) and the markdown
// report both CALL rather than each keeping a copy of. The CLI used
// to count every `skipped` result with no exemption, which called a run
// INCOMPLETE that the dashboard called PASS. ANY OTHER skipped reason, and
// every `errored`, still fails this guard — only the one named exemption is
// narrowed. Deliberately NOT read from the wire's `all_skipped`, which is the
// narrower every-abstained predicate and would loosen this guard.
//
// The all-pre-satisfied run — nothing passed, nothing failed, so no
// denominator — is `incomplete` here: `evaluated` is false and the A5 guard
// predates and outranks the exemption. Calling it `fail` locally would blame
// the agent for a run in which nothing was ever at risk, which is the
// inversion pointed the other way. `runScoreLine` names this state explicitly
// instead of printing "0 of N criteria not evaluated".
//
// The dashboard used to answer that same run `fail`, and this
// paragraph used to say so at length. `isIncompleteTally`'s third clause
// (`evaluated === 0`) closed it: both surfaces read it `incomplete` now, and
// the last shape they still word differently is a task whose `passThreshold`
// is not 100 (the dashboard's bar is a hard `satisfaction_score === 100` and
// it has no field to learn the task's threshold from).
//
// Correcting that cost real work, and is why the prose is here and not
// also somewhere else: pome-cloud shipped the fix and every copy of the old
// claim in this repo went false while staying green.
// `cross-surface-agreement.test.ts` pins the two PREDICATES row by row, which
// is what keeps the arithmetic honest — but it cannot pin a sentence. So
// claims about pome-cloud's run-state behaviour are stated ONCE, here, and
// pointed at from the tests and from `VerdictArtifact.state`'s doc rather
// than restated in each.
export function scoreStatus(score: Score, passThreshold: number): ScoreStatus {
  if (!score.evaluated || !score.can_pass) return "incomplete";
  return score.satisfaction >= passThreshold ? "pass" : "fail";
}

export function taskPassed(score: Score, passThreshold: number): boolean {
  return scoreStatus(score, passThreshold) === "pass";
}

// Per-criterion marker: ✓ passed, ✗ failed, - skipped, ! errored.
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

// The completeness arithmetic, factored out of `runScoreLine` so
// `verdict.json` (runTaskHosted.ts) can carry the SAME counts the terminal
// line already prints instead of a second, hand-rolled computation. Before
// this existed, `verdict.json` wrote `score: 100, pass_threshold: 100,
// passed: false` with no denominator anywhere in the file — a CI script that
// trusted `score >= pass_threshold` read `true` on a run where a third of the
// criteria never ran, because nothing in the artifact said so.
export interface EvaluationCounts {
  /** passed + failed — the satisfaction denominator (`score.total_required`). */
  evaluated: number;
  /** skipped + errored − preSatisfied — abstentions that actually block
   *  `can_pass`. Zero on a fully-evaluated OR fully-pre-satisfied run. */
  notEvaluated: number;
  /** Excluded from the denominator because the seed already satisfied them
   *  (`PRE_SATISFIED_REASON`) — not an abstention, so not counted in
   *  `notEvaluated`. */
  preSatisfied: number;
  /** evaluated + notEvaluated + preSatisfied — every criterion the run
   *  considered, so `score` (over `evaluated`) is legible as "N of total". */
  total: number;
}

export function evaluationCounts(score: Score): EvaluationCounts {
  const evaluated = score.total_required;
  const notEvaluated = score.skipped + score.errored - score.preSatisfied;
  return {
    evaluated,
    notEvaluated,
    preSatisfied: score.preSatisfied,
    total: evaluated + notEvaluated + score.preSatisfied,
  };
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
    // inversion this guard exists to stop, one surface over.
    //
    // `preSatisfied` criteria are named APART from the abstentions
    // instead of folded into "not evaluated", the way the dashboard's
    // `verdictLine` does (run-status.ts:174-206): a pre-satisfied criterion
    // reached a verdict (the grader wasn't gapped), it just tested nothing.
    const { notEvaluated: unreached, total } = evaluationCounts(score);
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
