// SPDX-License-Identifier: Apache-2.0
/**
 * When a finished run has a verdict to state, and when it has none.
 *
 * WHY THIS IS IN WIRE AND NOT IN EITHER REPO'S OWN TREE. Four surfaces answer
 * this question about the same run, and they do not all live in the same
 * repository. In pome-cloud: the dashboard's badge (`run-status.ts`'s
 * `isRunIncomplete`, over the wire `criteria_results`) and the markdown
 * report's header word (`run-report.ts`, over `criteria_breakdown`). In
 * digital-twins: the CLI's terminal verdict and the `state` field of the
 * `verdict.json` a hosted run writes for CI to read.
 *
 * F-1399 collapsed the first two into one predicate inside pome-cloud's private
 * `packages/contract`, and they have not drifted since — they cannot, because
 * there is nothing left to drift from. Across the repo boundary the same defect
 * survived it: `cli/test/unit/hosted/cross-surface-agreement.test.ts` held a
 * hand-written TRANSCRIPTION of the predicate so it could assert the CLI and
 * the dashboard never split on "did this pass". A transcription is a parallel
 * copy with a longer feedback loop, and it went stale GREEN — passing while
 * asserting something false about the other repo — the moment F-1399 changed
 * the original. Nothing detected that; it was caught because one person
 * happened to be holding both sides.
 *
 * Neither repo could fix it alone. `@pome-cloud/contract` is a private,
 * unpublished workspace package, so digital-twins cannot depend on it;
 * `scripts/lint-no-cloud-imports.sh` denies the import by design (ADR-002); and
 * no CI check in digital-twins could diff the transcription against a private
 * source without a credential the public repo's guardrails exist to keep out.
 * So the predicate moved to the one package that ALREADY crosses this boundary
 * (F-1416): wire is published from digital-twins and consumed by pome-cloud,
 * so both sides can import the same function and a change to it is a type error
 * or a red test on both sides rather than a silent pass on one.
 *
 * WHY IT IS WIRE'S TO CARRY, and why that does not loosen F-942. Everything
 * below reads exactly two fields of a `criteria_results` row — `skipped` and
 * `reason` — and returns a boolean. That row is a WIRE shape: it is what
 * /finalize puts on the wire and what both repos parse back. `reason` in
 * particular carries `PRE_SATISFIED_REASON` as a VALUE, so the string is
 * already wire vocabulary in the same sense a semconv attribute key is. Nothing
 * here names a session, a task, a run id, a REST route or a database column,
 * and nothing here imports anything. The input types are structural on purpose
 * (see `CriteriaTallyLike`), so no cloud class crosses the boundary with the
 * predicate — only the arithmetic does.
 *
 * SUBPATH-ONLY (`@pome-sh/wire/run-completeness`), deliberately off the root
 * barrel — the call `correlation/` and `otel/fixtures` already make, for a
 * different reason. Theirs is load cost; this one is scope: the barrel is what
 * every twin, the sdk and the adapter import, none of them has a run to ask
 * about, and the barrel's F-942 doc is the thing that keeps control-plane
 * vocabulary from creeping into them. `test/export-surface.test.ts` fails if any
 * symbol below appears on the root barrel.
 */

/**
 * The reason stamped on a criterion excluded for having already been true in
 * the seed.
 *
 * Owned here because it is the input to the predicate below on every side, so a
 * drift in the string is a silent drift in the predicate: a reader on a stale
 * spelling would count every exclusion as an abstention and stamp `Incomplete`
 * on every correctly-scored dedup run. pome-cloud's control plane
 * (`evaluators/deterministic/pre-satisfied.ts`) is what STAMPS it and
 * re-exports this constant; the CLI's `hosted/evalResultView.ts` re-exports it
 * for its own call sites. Nothing anywhere re-declares it.
 */
export const PRE_SATISFIED_REASON = "already_true_in_seed";

/**
 * The shape every surface reduces its criteria to before asking the question.
 *
 * `preSatisfied` is a SUBSET of `notEvaluated`, not a fourth bucket — a consumer
 * that adds `evaluated + notEvaluated` and expects `total` keeps working, and
 * one that ignores `preSatisfied` gets the pre-F-1296 arithmetic rather than a
 * wrong one. Structural rather than a shared class so the dashboard's
 * `CriteriaCounts` (which also carries `passed`) and the control plane's
 * `CriteriaTally` (which also carries `failed`) both satisfy it as they are —
 * and, since F-1416, so that this module can be published to a consumer whose
 * classes wire has never heard of. A nominal type here would have dragged one
 * repo's vocabulary into the other; a structural one drags nothing.
 */
export interface CriteriaTallyLike {
  /** Criteria the grader reached a verdict on: the score's denominator. */
  evaluated: number;
  /** Criteria that left the denominator, for any reason. */
  notEvaluated: number;
  /** The subset of `notEvaluated` the seed already satisfied. */
  preSatisfied: number;
  /** Every criterion the run recorded. */
  total: number;
}

/**
 * Has this finished run's grader failed to produce a verdict it can be scored
 * on?
 *
 * `true` means the run is neither a pass nor a failure: the honest word is
 * `incomplete` / `INCOMPLETE`, and no pass-rate denominator may contain it.
 *
 * THREE CLAUSES, EACH LOAD-BEARING:
 *
 * 1. `total === 0` → `false`, never incomplete. A production run carries no
 *    criteria at all until online eval scores it, and a replay run records none
 *    by construction (pome-cloud's `replay-run.ts` writes `criteriaResults: []`
 *    and encodes "the bug came back" as the score itself). Calling those
 *    incomplete would relabel every one of them. "No criteria were recorded" is
 *    a different fact from "criteria were recorded and none could be
 *    evaluated", and only the second is a finding — the same reading
 *    `score-merge.ts`'s `isFullyUnevaluated` settled on for `all_skipped`.
 *
 * 2. `notEvaluated - preSatisfied > 0` → incomplete (F-925, narrowed by
 *    F-1296). ANY criterion the grader could not reach makes the run neither
 *    green nor red, because a score of 100 over a shrunken denominator is what
 *    "the check never ran" looks like. Subtracting `preSatisfied` is the F-1296
 *    exemption: a criterion excluded for having already been true in the seed
 *    is not an abstention — the grader DID reach a verdict, and the verdict is
 *    that the criterion tested nothing. Counting it would stamp the word on
 *    every correctly-scored dedup and injection run, which is how a reader
 *    learns to stop reading it.
 *
 * 3. `evaluated === 0` → incomplete (F-1399). Given clauses 1 and 2 this fires
 *    for exactly ONE shape that clause 2 does not already catch: every
 *    criterion excluded as already true in the seed. (If `total > 0` and
 *    `evaluated === 0` then `notEvaluated === total`, so clause 2 is false only
 *    when `preSatisfied === total`.) That run scores 0 — not because anything
 *    failed, but because `score-merge.ts` returns 0 rather than dividing by an
 *    empty denominator — and without this clause it fell through to
 *    `satisfaction_score === 100 ? pass : fail` and landed on `fail`: a verdict
 *    about the AGENT for a run in which the agent could not have done anything
 *    wrong. It is written as its own clause rather than folded into clause 2
 *    because it is a different fact (there is no denominator) from clause 2's
 *    (something was not reached), and because folding it in would require
 *    `preSatisfied` to stop being an exemption.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is distinguish the two ways an empty
 * denominator arises — "nothing was at risk" (all pre-satisfied) from "not
 * evaluable" (the grader could not run). Both are `incomplete`, because neither
 * is a pass or a failure. WHICH one it was is a separate question, answered in
 * the same words on both surfaces by the dashboard's `verdictLine` and the
 * report's `scoreBasis`, and both key that off `notEvaluated - preSatisfied`
 * rather than off this boolean.
 */
export function isIncompleteTally(tally: CriteriaTallyLike): boolean {
  if (tally.total === 0) return false;
  return tally.notEvaluated - tally.preSatisfied > 0 || tally.evaluated === 0;
}

/**
 * One `criteria_results` row, reduced to the two facts the tally needs.
 *
 * Structural rather than either repo's full `CriterionResult` so a caller
 * reading the column back off a DB row satisfies it without importing a
 * criterion union — and so it is obvious that nothing else on the row can
 * change the answer. `passed` in particular cannot: a criterion that was
 * evaluated counts toward the denominator whichever way it went.
 */
export interface CriterionResultLike {
  /** Did this criterion leave the score denominator? */
  skipped: boolean;
  /** Why it left. `PRE_SATISFIED_REASON` is the one reason that is not a gap. */
  reason?: string;
}

/**
 * `criteria_results` → the counts `isIncompleteTally` reads.
 *
 * WHY THIS IS HERE AND NOT BESIDE ITS CALLERS. F-1399 merged the PREDICATE and
 * left the reduction written by hand on the dashboard, which was fine while the
 * dashboard was the only surface counting this column. F-1414 added two more:
 * the MCP's `first_failure_viewed` and the control plane's prior-failure probe
 * both have a runs row in hand and must decide the same question about it. Three
 * hand-written copies of `if (skipped) { notEvaluated++; if (reason === …) }` is
 * the shape this file's header says will drift — and it drifts SILENTLY here,
 * because a copy that miscounts still returns a boolean and still looks like an
 * answer. So the reduction moved next to the predicate that consumes it, and
 * F-1416 carried the pair across the repo boundary together for the same
 * reason: separating them would have left one repo owning half the arithmetic.
 *
 * `criteria_results` and not `criteria_breakdown`: the two agree on this split
 * by construction (`score-merge.ts` builds both from one `criteria.map`), and
 * only `criteria_results` is populated on every row, including the pre-M7 ones
 * whose breakdown column is empty. A surface that already has a breakdown in
 * hand (the markdown report) keeps using `tallyBreakdown`, which produces the
 * same counts plus the `failed` split the report prints.
 *
 * NOTE THE EMPTY ARRAY IS `total: 0`, which `isIncompleteTally` reads as "not
 * incomplete" — see clause 1 there. That is what keeps a replay run (which
 * records no criteria and encodes its verdict as the score) and a pre-M7 row
 * readable as the pass or failure they are.
 */
export function tallyCriteriaResults(
  results: readonly CriterionResultLike[],
): CriteriaTallyLike {
  let evaluated = 0;
  let notEvaluated = 0;
  let preSatisfied = 0;
  for (const result of results) {
    if (result.skipped) {
      notEvaluated += 1;
      if (result.reason === PRE_SATISFIED_REASON) preSatisfied += 1;
      continue;
    }
    evaluated += 1;
  }
  return { evaluated, notEvaluated, preSatisfied, total: results.length };
}
