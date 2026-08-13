// SPDX-License-Identifier: Apache-2.0
//
// F-1399 — the truth table for the one predicate that decides whether a
// finished run has a verdict to state.
//
// F-1416 MOVED THIS FILE HERE, from pome-cloud's private `packages/contract`,
// along with the predicate it tests. Four surfaces in two repositories ask this
// question about the same run — pome-cloud's dashboard badge (`run-status.ts`)
// and markdown report header (`run-report.ts`), and this repo's CLI terminal
// verdict and `verdict.json` `state`. Each pome-cloud surface used to carry a
// hand-written copy of the clauses, edited in lockstep twice (F-1296 added the
// seed-exclusion exemption to both, F-1399 the empty-denominator clause) before
// F-1399 merged them; the CLI's agreement test then carried a THIRD copy, as a
// transcription, and that one went stale green. The table belongs wherever the
// shared answer lives, because a test on one side can only ever pin what one
// side believes — and since F-1416 the shared answer is here, in the one
// package both repositories install.
//
// Each row is a real run shape, and the comment on it is the shape's name in
// the product, not a restatement of the arithmetic.

import { describe, expect, it } from "vitest";
import {
  isIncompleteTally,
  PRE_SATISFIED_REASON,
  tallyCriteriaResults,
} from "../src/run-completeness.js";

/** Build a tally the way both surfaces do: `preSatisfied` ⊆ `notEvaluated`. */
function tally(opts: { evaluated: number; unreached?: number; preSatisfied?: number }) {
  const unreached = opts.unreached ?? 0;
  const preSatisfied = opts.preSatisfied ?? 0;
  const notEvaluated = unreached + preSatisfied;
  return {
    evaluated: opts.evaluated,
    notEvaluated,
    preSatisfied,
    total: opts.evaluated + notEvaluated,
  };
}

describe("isIncompleteTally", () => {
  const cases: Array<{ name: string; tally: ReturnType<typeof tally>; incomplete: boolean }> = [
    {
      // A replay run, or a production run whose criteria online eval has not
      // scored yet. `replay-run.ts` writes an empty `criteriaResults` and
      // encodes "the bug came back" in the score itself, so calling this
      // incomplete would take the verdict away from every replay.
      name: "no criteria recorded at all",
      tally: tally({ evaluated: 0 }),
      incomplete: false,
    },
    {
      name: "every criterion evaluated, all passed",
      tally: tally({ evaluated: 3 }),
      incomplete: false,
    },
    {
      name: "every criterion evaluated, some failed",
      tally: tally({ evaluated: 3 }),
      incomplete: false,
    },
    {
      // F-925: a score of 100 over a shrunken denominator is what "the check
      // never ran" looks like, so ANY unreached criterion takes the verdict.
      name: "one criterion the grader could not reach beside three it could",
      tally: tally({ evaluated: 3, unreached: 1 }),
      incomplete: true,
    },
    {
      // F-1296: an exclusion is a verdict, not a gap. A dedup task scoring 3/3
      // with a fourth criterion the seed already satisfied is a clean pass.
      name: "one criterion excluded as already true in the seed beside three evaluated",
      tally: tally({ evaluated: 3, preSatisfied: 1 }),
      incomplete: false,
    },
    {
      name: "an exclusion AND a gap beside evaluated criteria — the gap still wins",
      tally: tally({ evaluated: 3, unreached: 1, preSatisfied: 1 }),
      incomplete: true,
    },
    {
      // F-1399, the hero shape. Score 0, and not one thing the agent could
      // have got wrong. This is the row the third clause exists for.
      name: "EVERY criterion excluded as already true in the seed",
      tally: tally({ evaluated: 0, preSatisfied: 2 }),
      incomplete: true,
    },
    {
      name: "a single criterion, excluded — the smallest all-excluded run",
      tally: tally({ evaluated: 0, preSatisfied: 1 }),
      incomplete: true,
    },
    {
      // Already incomplete before F-1399 and still incomplete after: the new
      // clause must not be the only thing holding these up.
      name: "EVERY criterion unreached — nothing could be evaluated",
      tally: tally({ evaluated: 0, unreached: 4 }),
      incomplete: true,
    },
    {
      name: "every criterion gone, some excluded and some unreached",
      tally: tally({ evaluated: 0, unreached: 1, preSatisfied: 1 }),
      incomplete: true,
    },
  ];

  for (const c of cases) {
    it(`${c.incomplete ? "has no verdict" : "has a verdict"}: ${c.name}`, () => {
      expect(isIncompleteTally(c.tally)).toBe(c.incomplete);
    });
  }

  // THE CLAIM THAT MAKES THE FIX SAFE. `evaluated === 0` reads much broader
  // than "every criterion was excluded", and a reviewer is right to ask what
  // else it swept up. The answer is nothing, and it is arithmetic rather than
  // luck: with `total > 0` and `evaluated === 0` we have
  // `notEvaluated === total`, so the older `notEvaluated - preSatisfied > 0`
  // clause is false only when `preSatisfied === total`. Exhausted here over
  // every tally up to a realistic width, so a later edit to any clause that
  // widens the third one's reach fails this rather than shipping a run
  // relabelled by accident.
  it("changes the answer for exactly one shape: every criterion excluded", () => {
    const beforeF1399 = (t: ReturnType<typeof tally>) =>
      t.total > 0 && t.notEvaluated - t.preSatisfied > 0;
    const moved: string[] = [];
    for (let evaluated = 0; evaluated <= 4; evaluated++) {
      for (let unreached = 0; unreached <= 4; unreached++) {
        for (let preSatisfied = 0; preSatisfied <= 4; preSatisfied++) {
          const t = tally({ evaluated, unreached, preSatisfied });
          if (isIncompleteTally(t) !== beforeF1399(t)) {
            moved.push(`${evaluated}/${unreached}/${preSatisfied}`);
          }
        }
      }
    }
    // evaluated=0, unreached=0, preSatisfied=1..4 — and nothing else.
    expect(moved).toEqual(["0/0/1", "0/0/2", "0/0/3", "0/0/4"]);
  });
});

// F-1414 — the reduction that feeds the table above, now that three surfaces in
// three apps count the same column: the dashboard's badge, the MCP's
// `first_failure_viewed`, and the control plane's prior-failure probe. Only the
// `skipped` flag and the reason move the counts; everything else on a criterion
// row is the caller's business.
describe("tallyCriteriaResults", () => {
  const scored = (passed: boolean) => ({ skipped: false, passed, reason: "judged" });
  const excludedBySeed = () => ({ skipped: true, passed: false, reason: PRE_SATISFIED_REASON });
  const unreached = () => ({ skipped: true, passed: false, reason: "judge_unavailable" });

  it("counts an evaluated criterion into the denominator whichever way it went", () => {
    // The failing one is the point: `passed` is the SCORE's business, and a
    // reduction that let it move `evaluated` would make a red run read as a
    // shrunken denominator.
    expect(tallyCriteriaResults([scored(true), scored(false)])).toEqual({
      evaluated: 2,
      notEvaluated: 0,
      preSatisfied: 0,
      total: 2,
    });
  });

  it("counts a seed exclusion as BOTH notEvaluated and preSatisfied", () => {
    // `preSatisfied` is a subset, not a fourth bucket — `evaluated +
    // notEvaluated` still equals `total`, which is what lets the predicate
    // subtract one from the other.
    const tally = tallyCriteriaResults([scored(true), excludedBySeed()]);
    expect(tally).toEqual({ evaluated: 1, notEvaluated: 1, preSatisfied: 1, total: 2 });
    expect(tally.evaluated + tally.notEvaluated).toBe(tally.total);
    expect(isIncompleteTally(tally)).toBe(false);
  });

  it("counts a criterion the grader could not reach as notEvaluated only", () => {
    const tally = tallyCriteriaResults([scored(true), unreached()]);
    expect(tally).toEqual({ evaluated: 1, notEvaluated: 1, preSatisfied: 0, total: 2 });
    expect(isIncompleteTally(tally)).toBe(true);
  });

  it("reduces the all-excluded run to the empty denominator the predicate refuses", () => {
    // The F-1399 hero shape as a criteria array rather than a hand-built tally:
    // this is the run that scores 0 with nothing at risk, and the run every
    // funnel used to read as an agent failure.
    const tally = tallyCriteriaResults([excludedBySeed(), excludedBySeed()]);
    expect(tally).toEqual({ evaluated: 0, notEvaluated: 2, preSatisfied: 2, total: 2 });
    expect(isIncompleteTally(tally)).toBe(true);
  });

  it("reduces no criteria at all to total 0 — which is NOT incomplete", () => {
    const tally = tallyCriteriaResults([]);
    expect(tally).toEqual({ evaluated: 0, notEvaluated: 0, preSatisfied: 0, total: 0 });
    expect(isIncompleteTally(tally)).toBe(false);
  });

  it("treats an unrecognised skip reason as a gap, not an exclusion", () => {
    // The fail-safe direction for a reason this package has never heard of
    // (a future evaluator's, or a stale spelling of the seed exclusion):
    // counting it as `preSatisfied` would exempt it from clause 2 and hand a
    // verdict to a run nothing was evaluated in.
    const tally = tallyCriteriaResults([
      { skipped: true, reason: `${PRE_SATISFIED_REASON}_v2` },
      { skipped: true },
    ]);
    expect(tally.preSatisfied).toBe(0);
    expect(isIncompleteTally(tally)).toBe(true);
  });
});

describe("PRE_SATISFIED_REASON", () => {
  // The literal is on the wire in `runs.criteria_results`, so it is a
  // compatibility surface, not an internal name. pome-cloud's control plane
  // stamps it (`evaluators/deterministic/pre-satisfied.ts`, which re-exports
  // this), pome-cloud's dashboard counts it, and this repo's CLI reads it back
  // (`cli/src/hosted/evalResultView.ts`, which also re-exports it rather than
  // restating it — F-1416). A rename that reached only some of them would make
  // every dedup run read as incomplete on those surfaces alone.
  it("is the exact string the control plane stamps and every reader counts", () => {
    expect(PRE_SATISFIED_REASON).toBe("already_true_in_seed");
  });
});
