// SPDX-License-Identifier: Apache-2.0
// Split out of evalResultCache.ts to keep that module under the
// file-size tripwire: grouping trials into run sets and deriving their
// outcome is a distinct concern from reading/writing/scanning the
// verdict.json artifact itself, and depends on nothing but `TrialVerdict`.

import type { TrialVerdict } from "./evalResultCache.js";

// The three-way verdict a run SET can carry, named like
// `ScoreStatus` (the per-trial word) because it is built from it: "fail" =
// at least one trial genuinely failed (graded, unsatisfied) — the only
// outcome that asserts an agent defect. "incomplete" = no trial failed, but
// at least one trial's grading never finished — a grader/seed gap, not
// evidence the agent did anything wrong; "fail" wins when a set has both,
// since a real failure is signal worth naming over a sibling's gap.
// "pass" = EVERY trial's state is exactly "pass", tested that way round on
// purpose: "pass" is the one outcome claiming a verified result, so it is
// never the fallthrough. An unrecognized state reads "incomplete", not green
// (`isVerdictArtifact` already refuses such a file — second line of defense).
export type RunSetOutcome = "fail" | "incomplete" | "pass";

export interface RunSet {
  /** null = a single run that never had a group. */
  groupId: string | null;
  taskName: string;
  /** The task path recorded at run time (first trial's). */
  taskPath: string;
  /** Trials sorted by finalized_at ascending. */
  trials: TrialVerdict[];
  latestFinalizedAt: string;
  /** Derived from the on-disk `state` (see `RunSetOutcome`), never
   *  from `passed` alone: `passed` is false for BOTH a genuine failure and a
   *  trial the grader never finished, so it can't tell "agent defect" from
   *  "never graded" apart. The ONE computation both the routing decision
   *  (`latestFailedRunSet` / `latestIncompleteRunSet`) and the message shown
   *  to the user read, so they cannot disagree. */
  outcome: RunSetOutcome;
}

/** Group trials into run sets: trials sharing a group_id form one set; a
 *  null group_id is its own single-run set.
 *
 *  `outcome` reads the on-disk `state`, not `!passed`
 *  (the finding was that `!passed` is true for both a genuine failure and an
 *  incomplete trial, so a set holding only incomplete trials used to trip
 *  the old `anyFailed` and get handed to `pome fix-prompt` as an agent
 *  defect). `evalResultCache.test.ts` pins all three outcomes against the
 *  written artifact. */
export function groupRunSets(trials: TrialVerdict[]): RunSet[] {
  const byKey = new Map<string, TrialVerdict[]>();
  for (const trial of trials) {
    const key = trial.verdict.group_id ?? `solo:${trial.verdict.session_id}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(trial);
    else byKey.set(key, [trial]);
  }
  const sets: RunSet[] = [];
  for (const bucket of byKey.values()) {
    bucket.sort((a, b) =>
      a.verdict.finalized_at.localeCompare(b.verdict.finalized_at),
    );
    const last = bucket[bucket.length - 1]!;
    const hasFailed = bucket.some((t) => t.verdict.state === "fail");
    const allPassed = bucket.every((t) => t.verdict.state === "pass");
    sets.push({
      groupId: bucket[0]!.verdict.group_id,
      taskName: bucket[0]!.verdict.task_name,
      taskPath: bucket[0]!.verdict.task_path,
      trials: bucket,
      latestFinalizedAt: last.verdict.finalized_at,
      outcome: hasFailed ? "fail" : allPassed ? "pass" : "incomplete",
    });
  }
  sets.sort((a, b) => a.latestFinalizedAt.localeCompare(b.latestFinalizedAt));
  return sets;
}

/** The newest run set with at least one genuinely FAILED (graded, not
 *  satisfied) trial — the only outcome `pome fix-prompt` may hand to a
 *  coding agent as an agent defect. */
export function latestFailedRunSet(sets: RunSet[]): RunSet | null {
  for (let i = sets.length - 1; i >= 0; i -= 1) {
    if (sets[i]!.outcome === "fail") return sets[i]!;
  }
  return null;
}

/** The newest run set whose worst outcome is INCOMPLETE: no trial
 *  failed, but at least one trial's grading never finished. Callers use this
 *  to name the gap distinctly from both "fix this" (a fail set exists) and
 *  "nothing to fix" (every set passed) — never silently folded into either. */
export function latestIncompleteRunSet(sets: RunSet[]): RunSet | null {
  for (let i = sets.length - 1; i >= 0; i -= 1) {
    if (sets[i]!.outcome === "incomplete") return sets[i]!;
  }
  return null;
}
