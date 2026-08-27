// SPDX-License-Identifier: Apache-2.0
//
// Pome verdicts → LangSmith feedback.
//
// Nothing here decides anything. Every verdict was reached by pome-cloud against
// the twin's own recorded tape and final state; this module RENDERS those
// verdicts in the two shapes a LangSmith SDK evaluator may return, and its whole
// job is to not lose information on the way.
//
// The split is the point, and it is the one thing to get right:
//
//   [code]  → a SCORE (`{ key, score, comment }`). The verdict is a fact about
//             the twin's state, so 1 and 0 mean what a number should mean.
//   [model] → a CATEGORICAL (`{ key, value, comment }`). Pome's narrator READS a
//             `[model]` criterion and writes its reading, but has no score
//             authority over it — the row arrives with a `status` of `advisory`
//             or `abstained`. Flattening that to 0 would put a judge's opinion
//             back on the customer's dashboard as a number, which is exactly what
//             Pome's narrator model removed. LangSmith carries it as a value
//             instead, so `advisory` reads as `advisory`.
//
// A `[code]` row that could not be evaluated (its subject is missing, its
// sentence bound to nothing) scores `null`, not 0: `ScoreType` is
// `number | boolean | null`, LangSmith drops a null out of that key's aggregate,
// and that is the honest arithmetic for "we did not find out".
//
// ── The field name, and why it is worth a module comment ────────────────────
//
// Braintrust reads `name`; LangSmith reads `key`. Porting the sibling example by
// copy-paste and leaving `name` in place does NOT fail loudly: the SDK's
// `coerceEvaluationResult` passes an entry with no `key` straight through, and
// `_logEvaluationFeedback` then calls `createFeedback(runId, undefined, …)` — so
// the criterion's identity is gone before the request is even built, and nothing
// in this process throws. Measured against langsmith 0.9.0.
// `test/scoring.test.ts` pins the field name, and `test/langsmith-seam.test.ts`
// pins the rewrite by driving the real SDK.

import type { ScoreType, ValueType } from "langsmith/schemas";

/** One criterion's verdict, flattened out of whichever half of the finalize
 *  response carried it. */
export interface PomeVerdict {
  /** The criterion id this run was finalized with — the feedback key's suffix. */
  id: string;
  kind: "code" | "model";
  /** `passed` | `failed` for [code]; `advisory` | `abstained` for [model]. Left
   *  a plain string on purpose: the control plane is a tolerant-reader wire and
   *  may grow a state, and an unknown one must render as itself rather than
   *  crash a whole eval row. */
  status: string;
  reason: string;
  text: string;
}

/** The numeric half of LangSmith's `EvaluationResult`. `score` is typed from the
 *  SDK's own `ScoreType` so `tsc --noEmit` — the leg `gate:examples` runs — is
 *  what catches a drift in what LangSmith accepts, rather than a 422 mid-eval. */
export interface ScoreFeedback {
  key: string;
  score: ScoreType;
  comment: string;
  evaluatorInfo: Record<string, unknown>;
}

/** The categorical half. Note the absence of `score`: not `score: undefined`,
 *  absent. `createFeedback` spreads what it is handed straight into the
 *  `POST /feedback` body, so a present-but-undefined `score` is a `score` field
 *  on the wire. */
export interface ReadingFeedback {
  key: string;
  value: ValueType;
  comment: string;
  evaluatorInfo: Record<string, unknown>;
}

/** Feedback keys are namespaced so a reader can tell Pome's keys from their own
 *  evaluators' at a glance in the experiment table. */
export const FEEDBACK_KEY_PREFIX = "pome/";

const PASSED = "passed";
const FAILED = "failed";

/** Read the per-criterion verdicts off a `/finalize` (or `GET /v1/runs/:id`)
 *  body. */
export function readVerdicts(body: unknown): PomeVerdict[] {
  const breakdown = (body as { criteria_breakdown?: unknown })?.criteria_breakdown;
  // Loud, not empty. Returning `[]` here would emit an eval row with no Pome
  // feedback at all, and LangSmith renders a missing key as a blank cell —
  // indistinguishable, in the experiment table, from a row that had nothing to
  // report. Every failure to READ the verdicts has to look different from a row
  // whose verdicts were all fine.
  //
  // Silently, is the part worth knowing. An evaluator that returns
  // `{results: []}` is not an error to this SDK: `_selectEvalResults` reads the
  // empty array, iterates it zero times, and calls `createFeedback` never. No
  // throw, no log, no feedback — measured against langsmith 0.9.0. Which is why
  // `exitCodeFor` in `src/index.ts` requires every row to carry at least one
  // `pome/` key rather than trusting that it does.
  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    throw new Error(
      "the finalize response carried no per-criterion detail (`criteria_breakdown`) — " +
        "nothing to render as feedback. This control plane graded the run but did not " +
        "return the breakdown; check the response body before trusting the score.",
    );
  }
  return breakdown.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      kind: r.kind === "model" ? "model" : "code",
      status: String(r.status),
      reason: typeof r.reason === "string" ? r.reason : "",
      text: typeof r.text === "string" ? r.text : "",
    };
  });
}

/** One numeric feedback key per `[code]` criterion. */
export function scoreFeedback(verdicts: PomeVerdict[]): ScoreFeedback[] {
  return verdicts
    .filter((v) => v.kind === "code")
    .map((v) => ({
      key: `${FEEDBACK_KEY_PREFIX}${v.id}`,
      score: v.status === PASSED ? 1 : v.status === FAILED ? 0 : null,
      comment: v.reason,
      evaluatorInfo: { criterion: v.text, status: v.status, kind: v.kind },
    }));
}

/** One categorical feedback key per `[model]` criterion.
 *
 *  No `feedbackConfig` is attached, and that is a decision rather than an
 *  omission. A `{type: "categorical", categories: [...]}` config travels to
 *  `POST /feedback` and pins the set of values LangSmith will accept for that
 *  key across the tenant — "if a conflicting config exists for the same key, a
 *  400 error is raised". Pome's narrator states are `advisory` and `abstained`
 *  today and the control plane may grow one; a closed list would turn that into
 *  a 400 on a key that already has a config, which is a worse failure than a
 *  value LangSmith infers the kind of. */
export function readingFeedback(verdicts: PomeVerdict[]): ReadingFeedback[] {
  return verdicts
    .filter((v) => v.kind === "model")
    .map((v) => ({
      key: `${FEEDBACK_KEY_PREFIX}${v.id}`,
      value: v.status,
      comment: v.reason,
      evaluatorInfo: { criterion: v.text, kind: v.kind },
    }));
}
