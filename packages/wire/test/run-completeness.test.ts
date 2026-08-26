// SPDX-License-Identifier: Apache-2.0
// The truth table for the one predicate that decides whether a finished run has a
// verdict to state.

import { describe, expect, it } from "vitest";
import {
  ABSTAINED_SCORE_STATE,
  ADVISORY_SCORE_STATE,
  isIncompleteTally,
  PRE_SATISFIED_REASON,
  tallyCriteriaResults,
} from "../src/run-completeness.js";

/** Build a tally the way both surfaces do: every exemption ⊆ `notEvaluated`. */
function tally(opts: {
  evaluated: number;
  unreached?: number;
  preSatisfied?: number;
  advisory?: number;
  abstained?: number;
}) {
  const unreached = opts.unreached ?? 0;
  const preSatisfied = opts.preSatisfied ?? 0;
  const advisory = opts.advisory ?? 0;
  const abstained = opts.abstained ?? 0;
  const notEvaluated = unreached + preSatisfied + advisory + abstained;
  return {
    evaluated: opts.evaluated,
    notEvaluated,
    preSatisfied,
    advisory,
    abstained,
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
      // A score of 100 over a shrunken denominator is what "the check
      // never ran" looks like, so ANY unreached criterion takes the verdict.
      name: "one criterion the grader could not reach beside three it could",
      tally: tally({ evaluated: 3, unreached: 1 }),
      incomplete: true,
    },
    {
      // An exclusion is a verdict, not a gap. A dedup task scoring 3/3
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
      // The hero shape. Score 0, and not one thing the agent could
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
      // Already incomplete before and still incomplete after: the new
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
    // ── The narrator states. A `[model]` row the narrator read but had no
    // score authority over is `skipped: true` with its reading in `reason`, so
    // before the exemption below every one of them counted as an abstention and
    // took the verdict away from a run whose every `[code]` criterion scored.
    {
      // THE DEFECT ROW. Three `[code]` criteria scored, two `[model]` rows
      // advisory: the grader reached every verdict it had authority to reach,
      // so there is nothing missing to report.
      name: "three scored beside two advisory [model] rows",
      tally: tally({ evaluated: 3, advisory: 2 }),
      incomplete: false,
    },
    {
      // An abstain is the `[model]` lane's third state: the criterion named a
      // subject this run has none of, so there was nothing to read. Same
      // exemption, different word.
      name: "three scored beside two abstained [model] rows",
      tally: tally({ evaluated: 3, abstained: 2 }),
      incomplete: false,
    },
    {
      name: "scored criteria beside one of each narrator state and a seed exclusion",
      tally: tally({ evaluated: 2, advisory: 1, abstained: 1, preSatisfied: 1 }),
      incomplete: false,
    },
    {
      // The exemption is narrow: it excuses the narrator's own states and
      // nothing standing beside them. A judge that could not be reached is
      // still a gap, and the gap still takes the verdict.
      name: "an advisory row AND a real gap beside evaluated criteria — the gap still wins",
      tally: tally({ evaluated: 3, advisory: 1, unreached: 1 }),
      incomplete: true,
    },
    {
      // CLAUSE 3, DELIBERATELY UNCHANGED. A `[model]`-only run has an empty
      // score denominator, so it is neither a pass nor a failure — `incomplete`
      // is the right verdict CLASS and only its WORDS were ever wrong.
      name: "advisory [model] rows and nothing else — no denominator to score",
      tally: tally({ evaluated: 0, advisory: 2 }),
      incomplete: true,
    },
    {
      name: "abstained [model] rows and nothing else — no denominator to score",
      tally: tally({ evaluated: 0, abstained: 2 }),
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

  // THE SAME CLAIM FOR THE NARRATOR EXEMPTION, and the reason it is a loop
  // rather than a handful of rows: "exempt the narrator states" reads as
  // broadly as `evaluated === 0` did, and a reviewer is right to ask what else
  // it relabels. The answer is exactly the runs that HAVE a denominator and
  // whose only unscored rows are the narrator's — a run with a real gap keeps
  // its `incomplete`, and a run with no denominator keeps it too (clause 3).
  it("moves exactly the runs whose only unscored rows are the narrator's", () => {
    const beforeNarrator = (t: ReturnType<typeof tally>) =>
      t.total > 0 && (t.notEvaluated - t.preSatisfied > 0 || t.evaluated === 0);
    const moved: string[] = [];
    const stillIncomplete: string[] = [];
    for (let evaluated = 0; evaluated <= 3; evaluated++) {
      for (let unreached = 0; unreached <= 3; unreached++) {
        for (let advisory = 0; advisory <= 3; advisory++) {
          for (let abstained = 0; abstained <= 3; abstained++) {
            const t = tally({ evaluated, unreached, advisory, abstained });
            const key = `${evaluated}/${unreached}/${advisory}/${abstained}`;
            if (isIncompleteTally(t) !== beforeNarrator(t)) moved.push(key);
            else if (isIncompleteTally(t)) stillIncomplete.push(key);
          }
        }
      }
    }
    // Every shape that moved has a denominator, no gap, and at least one
    // narrator row. Stated as a predicate over the whole set rather than a
    // literal list, because the list is 15 rows of noise.
    for (const key of moved) {
      const [evaluated, unreached, advisory, abstained] = key.split("/").map(Number);
      expect(evaluated).toBeGreaterThan(0);
      expect(unreached).toBe(0);
      expect(advisory + abstained).toBeGreaterThan(0);
    }
    // And the converse, which is the half that would go unnoticed: every such
    // shape DID move. Together these two make the set exact.
    expect(moved.length).toBe(3 * 1 * (4 * 4 - 1));
    // Nothing with a real gap was relabelled.
    for (const key of stillIncomplete) {
      const [evaluated, unreached] = key.split("/").map(Number);
      expect(unreached > 0 || evaluated === 0).toBe(true);
    }
  });
});

// The reduction that feeds the table above, now that three surfaces in three apps
// count the same column: the dashboard's badge, the MCP's `first_failure_viewed`.
describe("tallyCriteriaResults", () => {
  const scored = (passed: boolean) => ({ skipped: false, passed, reason: "judged" });
  const excludedBySeed = () => ({ skipped: true, passed: false, reason: PRE_SATISFIED_REASON });
  const unreached = () => ({ skipped: true, passed: false, reason: "judge_unavailable" });
  // The narrator's two states, as they actually arrive: `skipped: true` with
  // the reading in `reason`, and the state itself in `score_state`. Nothing
  // about the two booleans distinguishes these from `unreached()` above — which
  // is the whole reason the `score_state` field exists.
  const advisory = () => ({
    skipped: true,
    passed: false,
    reason: "the assistant acknowledged the cancellation in its reply",
    score_state: ADVISORY_SCORE_STATE,
  });
  const abstained = () => ({
    skipped: true,
    passed: false,
    reason: "no refund was requested in this run",
    score_state: ABSTAINED_SCORE_STATE,
  });

  it("counts an evaluated criterion into the denominator whichever way it went", () => {
    // The failing one is the point: `passed` is the SCORE's business, and a
    // reduction that let it move `evaluated` would make a red run read as a
    // shrunken denominator.
    expect(tallyCriteriaResults([scored(true), scored(false)])).toEqual({
      evaluated: 2,
      notEvaluated: 0,
      preSatisfied: 0,
      advisory: 0,
      abstained: 0,
      total: 2,
    });
  });

  it("counts a seed exclusion as BOTH notEvaluated and preSatisfied", () => {
    // `preSatisfied` is a subset, not a fourth bucket — `evaluated +
    // notEvaluated` still equals `total`, which is what lets the predicate
    // subtract one from the other.
    const tally = tallyCriteriaResults([scored(true), excludedBySeed()]);
    expect(tally).toEqual({
      evaluated: 1,
      notEvaluated: 1,
      preSatisfied: 1,
      advisory: 0,
      abstained: 0,
      total: 2,
    });
    expect(tally.evaluated + tally.notEvaluated).toBe(tally.total);
    expect(isIncompleteTally(tally)).toBe(false);
  });

  it("counts a criterion the grader could not reach as notEvaluated only", () => {
    const tally = tallyCriteriaResults([scored(true), unreached()]);
    expect(tally).toEqual({
      evaluated: 1,
      notEvaluated: 1,
      preSatisfied: 0,
      advisory: 0,
      abstained: 0,
      total: 2,
    });
    expect(isIncompleteTally(tally)).toBe(true);
  });

  it("reduces the all-excluded run to the empty denominator the predicate refuses", () => {
    // The hero shape as a criteria array rather than a hand-built tally: this is the
    // run that scores 0 with nothing at risk, and the run every funnel used to.
    const tally = tallyCriteriaResults([excludedBySeed(), excludedBySeed()]);
    expect(tally).toEqual({
      evaluated: 0,
      notEvaluated: 2,
      preSatisfied: 2,
      advisory: 0,
      abstained: 0,
      total: 2,
    });
    expect(isIncompleteTally(tally)).toBe(true);
  });

  it("reduces no criteria at all to total 0 — which is NOT incomplete", () => {
    const tally = tallyCriteriaResults([]);
    expect(tally).toEqual({
      evaluated: 0,
      notEvaluated: 0,
      preSatisfied: 0,
      advisory: 0,
      abstained: 0,
      total: 0,
    });
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

  it("counts an advisory row as BOTH notEvaluated and advisory", () => {
    // Same subset discipline `preSatisfied` follows: `evaluated +
    // notEvaluated` still equals `total`, which is what lets the predicate
    // subtract one from the other without the arithmetic going negative.
    const tally = tallyCriteriaResults([scored(true), scored(true), scored(true), advisory()]);
    expect(tally).toEqual({
      evaluated: 3,
      notEvaluated: 1,
      preSatisfied: 0,
      advisory: 1,
      abstained: 0,
      total: 4,
    });
    expect(tally.evaluated + tally.notEvaluated).toBe(tally.total);
    expect(isIncompleteTally(tally)).toBe(false);
  });

  it("counts an abstained row into its OWN bucket, not into advisory", () => {
    // Two names rather than one `narrated` count, because the two surfaces
    // that render them render them differently: an advisory row has a reading
    // to show, an abstain has a missing subject to name.
    const tally = tallyCriteriaResults([scored(true), advisory(), abstained()]);
    expect(tally).toEqual({
      evaluated: 1,
      notEvaluated: 2,
      preSatisfied: 0,
      advisory: 1,
      abstained: 1,
      total: 3,
    });
    expect(isIncompleteTally(tally)).toBe(false);
  });

  it("reduces a [model]-only run to the empty denominator clause 3 refuses", () => {
    // The row the fix deliberately does NOT move. Nothing was scored, so there
    // is no denominator and no pass or failure to state — `incomplete` is the
    // honest class even though every row is accounted for.
    const tally = tallyCriteriaResults([advisory(), advisory()]);
    expect(tally).toEqual({
      evaluated: 0,
      notEvaluated: 2,
      preSatisfied: 0,
      advisory: 2,
      abstained: 0,
      total: 2,
    });
    expect(isIncompleteTally(tally)).toBe(true);
  });

  it("treats an unrecognised score_state as a gap, not an exemption", () => {
    // The same fail-safe direction the unrecognised REASON takes above. A
    // spelling this package has never heard of — a future narrator state, or a
    // stale one — must not exempt itself from clause 2 by arriving.
    const tally = tallyCriteriaResults([
      { skipped: false, reason: "judged" },
      { skipped: true, reason: "read it", score_state: `${ADVISORY_SCORE_STATE}_v2` },
    ]);
    expect(tally.advisory).toBe(0);
    expect(tally.abstained).toBe(0);
    expect(isIncompleteTally(tally)).toBe(true);
  });

  it("ignores a score_state on a row that was actually evaluated", () => {
    // `advisory` is a subset of `notEvaluated`, so a row that is NOT skipped
    // must never land in it: subtracting an exemption the predicate never
    // added to `notEvaluated` would drive clause 2 negative and exempt a real
    // gap standing beside it.
    const tally = tallyCriteriaResults([
      { skipped: false, reason: "judged", score_state: ADVISORY_SCORE_STATE },
      { skipped: true, reason: "judge_unavailable" },
    ]);
    expect(tally).toEqual({
      evaluated: 1,
      notEvaluated: 1,
      preSatisfied: 0,
      advisory: 0,
      abstained: 0,
      total: 2,
    });
    expect(isIncompleteTally(tally)).toBe(true);
  });

  it("counts a row carrying BOTH exemptions once, not twice", () => {
    // Not a shape any producer emits (the seed exclusion is a [code]
    // evaluator's and the narrator states are the [model] judge's), but the
    // arithmetic must not depend on that: double-counting one row would make
    // `preSatisfied + advisory` exceed `notEvaluated` and exempt the gap
    // standing next to it.
    const tally = tallyCriteriaResults([
      { skipped: true, reason: PRE_SATISFIED_REASON, score_state: ADVISORY_SCORE_STATE },
      { skipped: true, reason: "judge_unavailable" },
    ]);
    expect(tally.preSatisfied + tally.advisory + tally.abstained).toBe(1);
    expect(tally.notEvaluated).toBe(2);
    expect(isIncompleteTally(tally)).toBe(true);
  });
});

describe("the narrator score_state values", () => {
  // Both sides of one wire value, exactly as `PRE_SATISFIED_REASON` below.
  // pome-cloud's `@pome-cloud/contract` builds `criterionOutcomeSchema` FROM
  // these two literals and its judge stamps them onto `criteria_results`; the
  // predicate above and this repo's CLI read them back. Declared on both sides
  // of the boundary instead of imported, a rename here would keep parsing and
  // silently stop exempting — every narrator run back to `INCOMPLETE` with
  // nothing failing.
  it("pins the two literals the predicate keys the exemption off", () => {
    expect(ADVISORY_SCORE_STATE).toBe("advisory");
    expect(ABSTAINED_SCORE_STATE).toBe("abstained");
  });
});

describe("PRE_SATISFIED_REASON", () => {
  // The literal is on the wire in `runs.criteria_results`, so it is a compatibility
  // surface, not an internal name.
  it("is the exact string the control plane stamps and every reader counts", () => {
    expect(PRE_SATISFIED_REASON).toBe("already_true_in_seed");
  });
});
