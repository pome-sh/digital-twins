// SPDX-License-Identifier: Apache-2.0
//
// Pome verdicts → Braintrust columns.
//
// Nothing here decides anything. Every verdict was reached by pome-cloud against
// the twin's own recorded tape and final state; this module RENDERS those
// verdicts in the two shapes Braintrust's `Eval()` accepts, and its whole job is
// to not lose information on the way.
//
// The split is the point, and it is the one thing to get right:
//
//   [code]  → a SCORE (`{ name, score, metadata }`). The verdict is a fact about
//             the twin's state, so 1 and 0 mean what a number should mean.
//   [model] → a CLASSIFICATION (`{ name, id, label, metadata }`). Pome's narrator
//             READS a `[model]` criterion and writes its reading, but has no
//             score authority over it — the row arrives `passed: false,
//             skipped: true` with a `score_state` of `advisory` or `abstained`.
//             Flattening that to 0 would put a judge's opinion back on the
//             customer's dashboard as a number, which is exactly what Pome's
//             narrator model removed. Braintrust carries it as a categorical
//             instead, so `advisory` reads as `advisory`.
//
// A `[code]` row that could not be evaluated (its subject is missing, its
// sentence bound to nothing) scores `null`, not 0: Braintrust drops a null out
// of that column's aggregate, which is the honest arithmetic for "we did not
// find out".

/** One criterion's verdict, flattened out of whichever half of the finalize
 *  response carried it. */
export interface PomeVerdict {
  /** The criterion id this run was finalized with — the score column's name. */
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

/** The `{ name, score, metadata }` Braintrust reads back as one numeric column. */
export interface ScoreColumn {
  name: string;
  score: number | null;
  metadata: Record<string, unknown>;
}

/** Column names are namespaced so a reader can tell Pome's columns from their
 *  own scorers' at a glance in the experiment table. */
export const COLUMN_PREFIX = "pome/";

const PASSED = "passed";
const FAILED = "failed";

/** Read the per-criterion verdicts off a `/finalize` (or `GET /v1/runs/:id`)
 *  body. */
export function readVerdicts(body: unknown): PomeVerdict[] {
  const breakdown = (body as { criteria_breakdown?: unknown })?.criteria_breakdown;
  // Loud, not empty. Returning `[]` here would emit an eval row with no Pome
  // columns at all, and Braintrust renders a missing column as a blank cell —
  // indistinguishable, in the experiment table, from a row that had nothing to
  // report. Every failure to READ the verdicts has to look different from a row
  // whose verdicts were all fine.
  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    throw new Error(
      "the finalize response carried no per-criterion detail (`criteria_breakdown`) — " +
        "nothing to render as score columns. This control plane graded the run but did not " +
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

/** One numeric column per `[code]` criterion. */
export function scoreColumns(verdicts: PomeVerdict[]): ScoreColumn[] {
  return verdicts
    .filter((v) => v.kind === "code")
    .map((v) => ({
      name: `${COLUMN_PREFIX}${v.id}`,
      score: v.status === PASSED ? 1 : v.status === FAILED ? 0 : null,
      metadata: { criterion: v.text, reason: v.reason, status: v.status, kind: v.kind },
    }));
}

/** The `{ name, id, label, metadata }` Braintrust reads back as one categorical
 *  column. `id` is the machine-readable outcome; `label` is what the UI shows. */
export interface ClassificationColumn {
  name: string;
  id: string;
  label: string;
  metadata: Record<string, unknown>;
}

/** How each narrator state reads in the Braintrust UI. An unrecognised state
 *  falls through as itself rather than being coerced into one of these — a new
 *  score state must show up as a new value, never silently as an old one. */
const CLASSIFICATION_LABELS: Record<string, string> = {
  advisory: "advisory — read, not scored",
  abstained: "abstained — nothing in this run to read",
};

/** One categorical column per `[model]` criterion. */
export function classificationColumns(verdicts: PomeVerdict[]): ClassificationColumn[] {
  return verdicts
    .filter((v) => v.kind === "model")
    .map((v) => ({
      name: `${COLUMN_PREFIX}${v.id}`,
      id: v.status,
      label: CLASSIFICATION_LABELS[v.status] ?? v.status,
      metadata: { criterion: v.text, reason: v.reason, kind: v.kind },
    }));
}
