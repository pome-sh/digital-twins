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
 * The first two collapsed into one predicate inside pome-cloud's private
 * `packages/contract`, and they have not drifted since — they cannot, because
 * there is nothing left to drift from. Across the repo boundary the same defect
 * survived it: `cli/test/unit/hosted/cross-surface-agreement.test.ts` held a
 * hand-written TRANSCRIPTION of the predicate so it could assert the CLI and
 * the dashboard never split on "did this pass". A transcription is a parallel
 * copy with a longer feedback loop, and it went stale GREEN — passing while
 * asserting something false about the other repo — the moment that changed
 * the original. Nothing detected that; it was caught because one person
 * happened to be holding both sides.
 *
 * Neither repo could fix it alone. `@pome-cloud/contract` is a private,
 * unpublished workspace package, so digital-twins cannot depend on it;
 * `scripts/lint-no-cloud-imports.sh` denies the import by design (ADR-002); and
 * no CI check in digital-twins could diff the transcription against a private
 * source without a credential the public repo's guardrails exist to keep out.
 * So the predicate moved to the one package that ALREADY crosses this boundary: wire is published from digital-twins and consumed by pome-cloud,
 * so both sides can import the same function and a change to it is a type error
 * or a red test on both sides rather than a silent pass on one.
 *
 * WHY IT IS WIRE'S TO CARRY, and why that does not loosen the barrel rule. Everything
 * below reads exactly three fields of a `criteria_results` row — `skipped`,
 * `reason` and `score_state` — and returns a boolean. That row is a WIRE shape:
 * it is what /finalize puts on the wire and what both repos parse back. `reason`
 * and `score_state` in particular carry `PRE_SATISFIED_REASON` and the two
 * narrator states as VALUES, so those strings are
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
 * about, and the barrel's own doc is the thing that keeps control-plane
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
 * The two states a `[model]` criterion can be in that `passed` and `skipped`
 * cannot tell apart — the values of the `score_state` field.
 *
 * - `advisory` — the narrator READ the criterion and wrote its reading into
 *   `reason`, but has no score authority over it. The default posture for a
 *   `[model]` criterion once the narrator is the judge.
 * - `abstained` — the criterion names a subject that does not exist in this
 *   run, so there was nothing to read.
 *
 * Both arrive as `passed: false, skipped: true`, which is what makes the field
 * additive: the two booleans already say the honest thing (this row is not in
 * the score denominator) and the value only says WHY.
 *
 * THE FIELD IS `score_state` AND NOT `outcome`, which is not a style choice.
 * The CLI's display model (`cli/src/hosted/evalResultView.ts`) has reserved
 * `outcome` on this same object for a DISJOINT vocabulary —
 * `passed | failed | skipped | errored` — and reserved it *for the cloud to
 * fill*. Its `outcomeOf` prefers the wire value over the two booleans, so a
 * cloud writing `advisory` into that key would hand the CLI a value outside its
 * own union and render an advisory row with the SKIPPED glyph: the exact
 * conflation the narrator states exist to remove. `score_state` also says what
 * these two values ARE — a statement about this row's relationship to the
 * score, not a verdict on the criterion.
 *
 * OWNED HERE FOR THE REASON `PRE_SATISFIED_REASON` IS, and it is the same
 * reason twice. The predicate below reads these literals to decide whether a
 * row is a GAP or a reading, so a drift in either string is a silent drift in
 * the predicate — a reader on a stale spelling counts every advisory row as an
 * abstention and stamps `Incomplete` on a run whose every scored criterion
 * scored. The VALUES live here; the zod field stays in pome-cloud's
 * `@pome-cloud/contract`, which is what SERVES `criteria_results` and builds
 * its `criterionScoreStateSchema` from these two constants rather than from
 * inline literals. That split is not a compromise between the two rules — it is
 * both of them being true at once, exactly as `PRE_SATISFIED_REASON` above is a
 * wire VALUE on a contract-owned SHAPE.
 */
export const ADVISORY_SCORE_STATE = "advisory";
export const ABSTAINED_SCORE_STATE = "abstained";

/**
 * The shape every surface reduces its criteria to before asking the question.
 *
 * `preSatisfied`, `advisory` and `abstained` are DISJOINT SUBSETS of
 * `notEvaluated`, not further buckets — a consumer that adds `evaluated +
 * notEvaluated` and expects `total` keeps working, and one that ignores the
 * three gets the legacy arithmetic rather than a wrong one. Disjoint is
 * load-bearing and not merely descriptive: the predicate subtracts all three
 * from `notEvaluated`, so a reduction that counted one row into two of them
 * would drive that clause negative and exempt a real gap standing beside it.
 * `tallyCriteriaResults` guarantees it by counting each row at most once.
 *
 * The two narrator counts are named separately rather than as one `narrated`
 * because both consumers already carry these two names, and because the
 * surfaces that RENDER them render them differently: an advisory row has a
 * reading to show, an abstain has a missing subject to name. Structural rather
 * than a shared class so the dashboard's
 * `CriteriaCounts` (which also carries `passed`) and the control plane's
 * `CriteriaTally` (which also carries `failed`) both satisfy it as they are —
 * and so that this module can be published to a consumer whose
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
  /** The subset of `notEvaluated` the narrator read but could not score. */
  advisory: number;
  /** The subset of `notEvaluated` whose subject this run did not contain. */
  abstained: number;
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
 * 2. `notEvaluated - preSatisfied - advisory - abstained > 0` → incomplete.
 *    ANY criterion the grader could not reach makes the run neither
 *    green nor red, because a score of 100 over a shrunken denominator is what
 * "the check never ran" looks like. The three subtractions are the exemptions,
 *    and all three are the same claim: the grader DID reach a verdict on this
 *    row, so its absence from the denominator is not a gap.
 *
 *    - `preSatisfied` — the criterion was already true in the seed, so the
 *      verdict is that it tested nothing. Counting it would stamp the word on
 *      every correctly-scored dedup and injection run, which is how a reader
 *      learns to stop reading it.
 *    - `advisory` / `abstained` — the narrator has no score authority over a
 *      `[model]` criterion, so a run whose every `[code]` criterion scored is
 *      complete with narrator prose beside it. Without this the word landed on
 *      EVERY narrator run, and (because the markdown report gates the rerun
 *      recipe on this predicate) took the fix→green loop with it.
 *
 *    The exemptions are narrow on purpose: they excuse the states the grader
 *    named and nothing standing beside them. An unreachable judge is still a
 *    gap, and one gap beside three readings still takes the verdict.
 *
 * 3. `evaluated === 0` → incomplete. Given clauses 1 and 2 this fires
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
  const unreached =
    tally.notEvaluated - tally.preSatisfied - tally.advisory - tally.abstained;
  return unreached > 0 || tally.evaluated === 0;
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
  /**
   * The closed-vocabulary half of the same question: `ADVISORY_SCORE_STATE` or
   * `ABSTAINED_SCORE_STATE` when the narrator named the state, absent
   * otherwise.
   *
   * TYPED `string` AND NOT A UNION OF THE TWO, exactly as `reason` above is not
   * a union of the reason codes. This interface is structural and published,
   * and the field it models is a zod enum owned in pome-cloud whose output type
   * is that repo's to widen — a two-literal union here would make every future
   * state a breaking change to this package, and would reject a caller passing
   * rows it reads straight back out of a `criteria_results` jsonb column. The
   * VALUES are still wire's (they are declared above); what is deliberately not
   * wire's is the closed set. `tallyCriteriaResults` treats a spelling it does
   * not recognise as a gap, which is the fail-safe direction.
   */
  score_state?: string;
}

/**
 * `criteria_results` → the counts `isIncompleteTally` reads.
 *
 * WHY THIS IS HERE AND NOT BESIDE ITS CALLERS. Merging the PREDICATE
 * left the reduction written by hand on the dashboard, which was fine while the
 * dashboard was the only surface counting this column. Two more arrived:
 * the MCP's `first_failure_viewed` and the control plane's prior-failure probe
 * both have a runs row in hand and must decide the same question about it. Three
 * hand-written copies of `if (skipped) { notEvaluated++; if (reason === …) }` is
 * the shape this file's header says will drift — and it drifts SILENTLY here,
 * because a copy that miscounts still returns a boolean and still looks like an
 * answer. So the reduction moved next to the predicate that consumes it, and
 * The pair crossed the repo boundary together for the same
 * reason: separating them would have left one repo owning half the arithmetic.
 *
 * The three exemption counts come off two different fields — `preSatisfied` off
 * `reason`, the two narrator states off `score_state` — because that is how the
 * two producers stamp them, and a reduction that guessed one from the other
 * would be sniffing prose. `score_state` is absent on every row whose two
 * booleans fully describe it, so a pre-narrator row and a post-narrator row of
 * the same state still reduce identically.
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
  let advisory = 0;
  let abstained = 0;
  for (const result of results) {
    if (result.skipped) {
      notEvaluated += 1;
      // AT MOST ONE exemption per row, which is why this is an else-if chain
      // and not three independent counters. `isIncompleteTally` subtracts all
      // three from `notEvaluated`, so a row counted twice would make the
      // subtraction exceed what it added and exempt an unrelated gap. No
      // producer emits a row carrying two of these (the seed exclusion is a
      // `[code]` evaluator's and the narrator states are the `[model]`
      // judge's), and the arithmetic does not depend on that staying true.
      if (result.reason === PRE_SATISFIED_REASON) preSatisfied += 1;
      else if (result.score_state === ADVISORY_SCORE_STATE) advisory += 1;
      else if (result.score_state === ABSTAINED_SCORE_STATE) abstained += 1;
      continue;
    }
    // A `score_state` on a row that was NOT skipped is ignored rather than
    // counted: the row is in the denominator, so exempting it would subtract
    // something `notEvaluated` never held.
    evaluated += 1;
  }
  return {
    evaluated,
    notEvaluated,
    preSatisfied,
    advisory,
    abstained,
    total: results.length,
  };
}
