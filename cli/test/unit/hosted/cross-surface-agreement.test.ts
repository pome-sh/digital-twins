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
// `dashboardRunStatus` below WAS a transcription — a hand copy of pome-cloud's
// three clauses, named clause by clause so a reviewer could diff it against the
// original. F-1416 deleted the copy. It now CALLS the real predicate, which
// both repositories install from `@pome-sh/wire/run-completeness`.
//
// WHY THAT MATTERS MORE THAN IT LOOKS. F-1399 moved the arithmetic out of
// `run-status.ts` into a shared predicate inside pome-cloud, closing this exact
// defect class one repo over — and the copy in THIS file went stale the moment
// it did, and went stale GREEN: it kept passing while asserting something false
// about the other repo. F-1413 was the second time that happened. Both times
// nothing detected it; it was caught because one person happened to be holding
// both sides. A transcription is a parallel copy with the longest possible
// feedback loop, and it was sitting inside the very test written to prove
// parallel copies are gone.
//
// The fix was a cross-repo move, not a one-file patch: `isIncompleteTally`,
// `tallyCriteriaResults` and `PRE_SATISFIED_REASON` now live in
// `packages/wire/src/run-completeness.ts` here, published as
// `@pome-sh/wire/run-completeness` and imported by pome-cloud's dashboard,
// control plane and markdown report instead of by a private cloud package.
// There is one implementation left across both repos. Changing it can no longer
// leave this file asserting the old behaviour — the two things that could
// happen are a type error and a red test, and no third thing.
//
// WHAT IS STILL WRITTEN OUT BY HAND HERE, stated so nobody has to guess: the
// two-line COMPOSITION in `dashboardRunStatus` — incomplete outranks the score,
// and the pass bar is a hard 100. That is `deriveRunStatus`
// (`apps/dashboard/src/lib/run-status.ts`), and it stays cloud-side on purpose:
// its `RunStatus` includes `in_progress`, a state derived from a `runs` row's
// `finished_at`, and wire has no business knowing what a runs row is. What
// moved is the ARITHMETIC — the counting, the exemption, the empty denominator
// — which is the part that drifted twice and the part that drifts SILENTLY,
// because a miscounting copy still returns a boolean. An ordering change is a
// different animal: it is one line, it has no counts in it, and it cannot be
// wrong by an off-by-one.
//
// There is no known divergence between the two surfaces today — F-1399 closed
// the last one (below). A row CAN still carry a `divergence` marker if the two
// surfaces disagree again: a known divergence with a test on it is a fact; the
// same divergence with no test on it is the F-1392 defect again.
//
// F-1195 — there is now a THIRD surface answering the same question: the
// `state` field of the `verdict.json` a hosted run writes, which is what CI
// reads instead of scraping stderr. It answers with the CLI's word by
// construction (`runTaskHosted.ts` passes the one `verdict` local it already
// computed into the artifact; `test/e2e/runTaskHosted.test.ts` pins that end
// to end). What this file adds is the VOCABULARY claim — that the artifact
// spells the answer in the dashboard's three words and no others.

import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isIncompleteTally, tallyCriteriaResults } from "@pome-sh/wire/run-completeness";
import { describe, expect, it } from "vitest";
import type { CriterionResult } from "../../../src/contract/index.js";
import {
  readVerdictArtifact,
  VERDICT_ARTIFACT_VERSION,
  writeVerdictArtifact,
  type VerdictArtifact,
} from "../../../src/hosted/evalResultCache.js";
import { PRE_SATISFIED_REASON, scoreStatus } from "../../../src/hosted/evalResultView.js";
import { scoreFromFinalizeResponse } from "../../../src/hosted/uploadAndFinalize.js";

// ── The oracle: pome-cloud's answer, CALLED rather than copied ──────────────
//
// This is `deriveRunStatus` (`apps/dashboard/src/lib/run-status.ts`), minus the
// `in_progress` arm that only a live `runs` row can be in. Every line of
// counting inside it is now an import:
//
//   isRunIncomplete(results)
//     = isIncompleteTally(deriveCriteriaCounts(results))     ← dashboard
//     = isIncompleteTally(tallyCriteriaResults(results))     ← here
//
// The two are the same call. `deriveCriteriaCounts` is `{ passed, ...
// tallyCriteriaResults(results) }` — it adds the score's numerator, which the
// predicate does not read, and pome-cloud's own `run-status.test.ts` asserts
// that equality directly. So this function makes the same two decisions the
// dashboard makes, out of the same package, and the only thing left written
// down twice is their ORDER.
//
// The satisfaction score the dashboard reads is the run row's, which the
// control plane computes in `score-merge.ts` as
// `evaluated === 0 ? 0 : round(passed / evaluated * 100)` — the same number
// /finalize returns to the CLI, so one `satisfaction` input drives both sides
// of every row below.
type DashboardStatus = "pass" | "fail" | "incomplete";

function dashboardRunStatus(
  results: readonly CriterionResult[],
  satisfactionScore: number,
): DashboardStatus {
  // F-925 — incomplete outranks the score, including a failing one. If `fail`
  // won that contest, the same instrument gap would produce a different run
  // state depending on how the agent performed.
  if (isIncompleteTally(tallyCriteriaResults(results))) return "incomplete";
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
    // F-1399 added `isIncompleteTally`'s third clause (`evaluated === 0`):
    // an all-excluded run has an empty denominator, which used to fall
    // through to `satisfaction_score === 100 ? pass : fail` and land on
    // `fail` here. Both surfaces now agree it is `incomplete` — the CLI
    // already read it that way (its own A5 guard), so this row used to be
    // the one known divergence and is now just another agreement row.
    name: "every criterion seed-excluded — no denominator",
    results: [excluded("github.no-new-issues"), excluded("github.no-new-labels")],
    satisfaction: 0,
    expected: "incomplete",
  },
];

/** Tracked-by-name lookup for the tests below that single a row out.
 *
 *  Not `table.find((r) => r.divergence)`: that predicate selected the row only
 *  while the row was MARKED as a divergence, so closing the divergence handed
 *  its caller `undefined` and the test kept passing on a `!`-asserted ghost
 *  (F-1413). Renaming a row must red with a readable message instead. */
function rowNamed(name: string): Row {
  const row = table.find((r) => r.name === name);
  if (row === undefined) {
    throw new Error(`no table row named "${name}" — a test below tracks it by name`);
  }
  return row;
}

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

  // ── isIncompleteTally's FIRST clause, which no row above reaches ─────────
  //
  // `total === 0 ⇒ never incomplete` is the one clause no row in the table
  // exercises, since every row has criteria. Since F-1416 the clause itself is
  // pinned where it is implemented (`packages/wire/test/run-completeness.
  // test.ts` exhausts all three), so what these two cases are for is no longer
  // "cover the transcription" — it is the CROSS-SURFACE fact, which is the only
  // thing this file has ever been about: on the empty-results shape the two
  // surfaces answer DIFFERENTLY, and that is correct rather than a divergence.
  //
  // It is NOT a table row because the table's third assertion — the two
  // surfaces never split on `passed` — is false for this input at
  // satisfaction 100, and that is not a divergence to mark. It is a shape only
  // ONE surface can be asked about. `taskSchema` (`src/task/taskSchema.ts`:
  // `criteria: z.array(criterionSchema).min(1)`) refuses a task carrying no
  // criteria, so a hosted `pome run` always has criteria for /finalize to
  // answer about; an empty `criteria_results` arriving at the CLI means the
  // grader returned nothing for criteria that DO exist, which is precisely
  // what the A5 guard is for. pome-cloud's clause 1 exists for rows the CLI
  // never produces — a replay run (`replay-run.ts` writes `criteriaResults:
  // []` by construction and encodes the finding in the score itself) and a
  // production run not yet scored by online eval.
  describe("a run that recorded no criteria at all (isIncompleteTally clause 1)", () => {
    it("is never `incomplete` on the dashboard — it falls through to the score", () => {
      expect(dashboardRunStatus([], 100)).toBe("pass");
      expect(dashboardRunStatus([], 0)).toBe("fail");
    });

    it("is `incomplete` to the CLI, which is the A5 guard and not a divergence", () => {
      // Same wire shape, different question — see the note above for why the
      // CLI cannot be handed a run this clause was written for.
      expect(cliRunStatus([], 100)).toBe("incomplete");
      expect(cliRunStatus([], 0)).toBe("incomplete");
    });
  });

  // ── The third surface: verdict.json's `state` (F-1195) ───────────────────
  //
  // `runTaskHosted.ts` writes `state: verdict` — the same local that produced
  // the terminal's word — so agreement between the artifact and the terminal
  // is structural, and the e2e tests prove the wiring. The risk this block
  // covers is the OTHER one: that the artifact spells the answer in a
  // vocabulary of its own, which would be the F-1392 defect reappearing in a
  // new file.
  describe("verdict.json spells the state in the same three words (F-1195)", () => {
    async function roundtripState(state: string): Promise<string | undefined> {
      const dir = join(await mkdtemp(join(tmpdir(), "xsurface-")), "scn", "ses_1");
      await mkdir(dir, { recursive: true });
      await writeVerdictArtifact(dir, {
        version: VERDICT_ARTIFACT_VERSION,
        source: "cloud-finalize",
        task_name: "scn",
        task_path: "tasks/scn.md",
        group_id: null,
        session_id: "ses_1",
        cloud_run_id: "run_x",
        cloud_dashboard_url: "https://app.pome.sh/runs/run_x",
        judge_model: null,
        score: 100,
        pass_threshold: 100,
        state: state as VerdictArtifact["state"],
        passed: state === "pass",
        evaluated: 1,
        not_evaluated: 0,
        pre_satisfied: 0,
        total: 1,
        criteria_results: [passing("a")],
        duration_ms: 1,
        finalized_at: "2026-08-10T00:00:00.000Z",
      });
      return (await readVerdictArtifact(dir))?.verdict.state;
    }

    // The dashboard's `RunStatus` is these three plus `in_progress`
    // (run-status.ts) — a state no finalized artifact can be in, and one the
    // artifact must therefore refuse rather than store.
    const dashboardWords: DashboardStatus[] = ["pass", "fail", "incomplete"];

    for (const word of dashboardWords) {
      it(`accepts the dashboard's "${word}" verbatim`, async () => {
        expect(await roundtripState(word)).toBe(word);
      });
    }

    for (const notAWord of ["in_progress", "INCOMPLETE", "passed", "unevaluated", ""]) {
      it(`refuses "${notAWord}" — a fourth word is a fourth vocabulary`, async () => {
        expect(await roundtripState(notAWord)).toBeUndefined();
      });
    }

    it("records the same word as the dashboard now that F-1399 closed the divergence, and the closure is stated in the artifact's own doc", async () => {
      const row = rowNamed("every criterion seed-excluded — no denominator");
      const cliWord = cliRunStatus(row.results, row.satisfaction);
      // The all-pre-satisfied run: F-1399 added `isIncompleteTally`'s
      // `evaluated === 0` clause, so the dashboard now reads `incomplete`
      // here too — the CLI already did, via its own A5 guard. `passed` — the
      // only bit CI can act on — agreed even before F-1399; now the word
      // itself does too.
      expect(cliWord).toBe("incomplete");
      expect(dashboardRunStatus(row.results, row.satisfaction)).toBe("incomplete");
      expect(await roundtripState(cliWord)).toBe("incomplete");

      // The claim in this test's name is checked, not asserted: the field a
      // CI reader meets first is `VerdictArtifact.state`, so the F-1399
      // history has to be legible from there. Delete the mention and this
      // goes red rather than the artifact quietly losing the only place that
      // history was written down.
      const artifactSource = await readFile(
        new URL("../../../src/hosted/evalResultCache.ts", import.meta.url),
        "utf8",
      );
      expect(artifactSource).toContain("F-1399");
    });
  });

  it("has no known divergences between the two surfaces", () => {
    // A guard on the guard: adding a `divergence` to a row is how this file
    // would be silenced, so the count is asserted rather than left to review.
    // F-1399 closed the last one (the empty-denominator row above); the next
    // one has to be added deliberately, not slip in unnoticed.
    const diverging = table.filter((row) => row.divergence);
    expect(diverging.map((row) => row.name)).toEqual([]);
  });
});

// ── What the table is still worth, now that the arithmetic is shared ────────
//
// A reasonable question after F-1416: if both surfaces call one predicate, is a
// row-by-row agreement table anything but a tautology? No, and the rows above
// say why. `dashboardRunStatus` and `cliRunStatus` reach their answers by
// genuinely different routes — the dashboard runs the shared predicate over
// `criteria_results` and then a hard-100 bar, while the CLI goes through
// `scoreFromFinalizeResponse` (which builds its own `Score`, including its own
// `preSatisfied` subtraction and the A5 `can_pass` guard) and then
// `scoreStatus`. Nothing forces those two routes to land on the same word; the
// shared predicate only forces them to count the same way. The empty-results
// case a few blocks up is the standing proof — same input, two different
// answers, both correct.
//
// So the table pins what it always pinned: that two independently-implemented
// readers of one wire shape agree, row by row, and never split on the single
// bit CI can act on. What F-1416 removed is the part that was never a test at
// all — a copy of the other repo's counting, which could only ever agree with
// itself.
