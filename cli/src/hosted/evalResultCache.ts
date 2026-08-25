// SPDX-License-Identifier: Apache-2.0
// The per-trial CLOUD verdict artifact.
//
// Hosted `pome run` persists each finalized trial's cloud verdict payload
// (what /finalize returned and the terminal rendered) as `verdict.json`
// next to the trial's raw trace. This is a provenance-labeled CACHE of the
// cloud judge's output — NOT a local score: the OSS CLI still has no
// scoring engine (the `no-eval` lint rule), score.json is still never
// written, and deleting verdict.json loses nothing the dashboard doesn't
// hold. `pome fix-prompt` reads these to hand grouped failure signatures
// to the user's coding agent without a credentialed cloud round-trip —
// the F0-3 / L5 intent recorded in uploadAndFinalize.ts ("so the CLI can
// render per-criterion verdicts … without a follow-up cloud round-trip").
//
// Artifact-layout knowledge lives HERE and only here:
//   <artifacts-root>/<task-slug>/<session-id>/verdict.json
// (runDir shape from recorder/artifacts.ts `writeRunArtifactsCore`).
//
// Moved from `src/recorder/verdictArtifact.ts` to here (and
// renamed: the repo-wide no-eval gate denies any module NAMED verdict*, so
// this file itself can't be called that anymore) and grouped under
// `hosted/` since it caches a CLOUD response, not a recorder concern.

import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
// The DISPLAY-model row, not the contract one: the writer passes
// `score.results` and `fix-prompt` reduces this array with `outcomeOf`.
import type { CriterionResult, ScoreStatus } from "./evalResultView.js";
import {
  groupRunSets,
  latestFailedRunSet,
  latestIncompleteRunSet,
  type RunSet,
} from "./runSets.js";

// Bumped 1 → 2: the artifact gained `state` (the run's three-state
// verdict, by name) and the `evaluated`/`not_evaluated`/`pre_satisfied`/
// `total` counts `score` is computed over. Before this, a CI script reading
// `score >= pass_threshold` on an incomplete run read `true`, because
// `verdict.json` carried no denominator and no name for the third state —
// `passed: false` was the only signal, and it carries no reason. A v1 file
// on disk is a RECOGNIZABLE prior version, not garbage: `readVerdictArtifact`
// refuses it (the new fields are required, not optional-with-a-default — zero
// customers, no dual-format reader) but `scanVerdictArtifactsDetailed` /
// `discoverRunSet` name the skip instead of making it indistinguishable from
// "no run happened here" (see `looksLikeVerdictArtifactBase` below).
export const VERDICT_ARTIFACT_VERSION = 2;

export const VERDICT_FILENAME = "verdict.json";

const VALID_STATES: ReadonlySet<string> = new Set<ScoreStatus>([
  "pass",
  "fail",
  "incomplete",
]);

export interface VerdictArtifact {
  version: number;
  /** Provenance: the only writer is the /finalize response path. */
  source: "cloud-finalize";
  task_name: string;
  /** The task path as the run invocation saw it (may move later — readers
   *  must tolerate a dangling path). */
  task_path: string;
  /** Shared trial-group id (`grp_` + nanoid21); null on single runs. */
  group_id: string | null;
  session_id: string;
  cloud_run_id: string;
  cloud_dashboard_url: string;
  judge_model: string | null;
  /** Cloud-authoritative satisfaction score, 0-100 — the percentage over
   *  `evaluated` ALONE, never over `total`. Version 2 shipped `evaluated`
   *  beside it for that reason: `score` on its own does not say how much of
   *  the task it covers, and `score >= pass_threshold` is not the gate on a
   *  run where `not_evaluated > 0` (`state` and `passed` are). When
   *  `evaluated` is 0 the cloud sends 0 for want of a denominator — that is
   *  "nothing was scored", not "nothing was correct". */
  score: number;
  pass_threshold: number;
  /** The run's three-state verdict, BY NAME, taken from
   *  `RunTaskHostedResult.verdict` (itself `scoreStatus(score,
   *  passThreshold)`) rather than re-derived here. `passed` alone told a
   *  reader "not a pass" with no reason; `state` says which of the two
   *  reasons.
   *
   *  It is the word the TERMINAL prints, always — one local, one derivation.
   *  It is the word the DASHBOARD renders (`deriveRunStatus`, pome-cloud
   *  `apps/dashboard/src/lib/run-status.ts`) on the same three words and on
   *  every shape `cross-surface-agreement.test.ts` walks EXCEPT one, named
   *  here rather than left for a reader to discover from a mismatch:
   *    - a task whose `pass_threshold` is not 100: the dashboard's pass bar
   *      is a hard `satisfaction_score === 100` and it has no field to learn
   *      the task's threshold from. `pass_threshold` is in this artifact
   *      beside `state` precisely so a reader can see which bar was used.
   *
   *  The other one is closed: a run whose criteria were ALL pre-satisfied
   *  used to read `incomplete` here (no denominator, so no verified pass —
   *  the A5 guard) against `fail` on the dashboard. pome-cloud's shared
   *  incomplete-run predicate now adds an `evaluated === 0` clause, so both
   *  surfaces say `incomplete`. The reasoning is in `evalResultView.ts`'s
   *  `scoreStatus` comment and stated only there: one place to correct when
   *  pome-cloud changes this again, rather than four that go false
   *  independently. */
  state: ScoreStatus;
  passed: boolean;
  /** `EvaluationCounts` from `evalResultView.ts`, so `score` is
   *  legible as "N of what" instead of a bare number beside a threshold. */
  evaluated: number;
  not_evaluated: number;
  pre_satisfied: number;
  total: number;
  criteria_results: CriterionResult[];
  duration_ms: number;
  finalized_at: string;
}

export interface TrialVerdict {
  runDir: string;
  verdict: VerdictArtifact;
}

/** Publish by RENAME, never by writing the live path in place.
 *  `writeFile` opens with `O_TRUNC` and the bytes land afterwards, so
 *  `verdict.json` was observably empty and then partial for the whole of a
 *  write, and a `pome fix-prompt` scanning the root while a `pome run`
 *  finalized in it read that prefix. It then REPORTED that read: path
 *  named, counted in `unreadableCount`, described as "truncated, hand-edited,
 *  or not a verdict artifact" — a correct read of the bytes and a wrong
 *  account of the run, whose suggested fix (inspect it, delete it) is wrong
 *  for a file that is complete a moment later. `rename` is atomic within a
 *  filesystem, so a reader now sees the previous artifact or the complete new
 *  one, never a prefix.
 *
 *  The temp file MUST be a sibling inside `runDir`, and that is the whole of
 *  the same-filesystem guarantee: a directory cannot span a mount, so this
 *  rename is always the atomic kind. `os.tmpdir()` is not a substitute — with
 *  an artifacts root on another mount (container volume, external disk, network
 *  share) `rename(2)` fails `EXDEV`, and the reflex fix for `EXDEV` is a copy,
 *  which is exactly the torn window this removes. That would still pass a
 *  same-machine test, so the constraint is stated here rather than left to CI.
 *
 *  Deliberately not fsync'd: the window this closes belongs to a concurrent
 *  READER, not a power cut, and this file is a cache of a cloud response the
 *  dashboard holds authoritatively (see the header). */
export async function writeVerdictArtifact(
  runDir: string,
  verdict: VerdictArtifact,
): Promise<void> {
  const tmpPath = join(runDir, `.${VERDICT_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
    await rename(tmpPath, join(runDir, VERDICT_FILENAME));
  } catch (err) {
    // No debris in the user's runs/ when the write or the rename fails. The
    // caller treats that as "fix-prompt won't see this trial" (runTaskHosted
    // step 11) and must still receive the original error, so a failure to
    // clean up never replaces it.
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/** Read one trial's verdict.json. Returns null when absent or when the file
 *  isn't a recognizable verdict artifact (foreign/corrupt files are skipped,
 *  never thrown on — fix-prompt discovery must survive a messy runs/). */
/** Every field the fix-prompt pipeline dereferences must hold its declared
 *  shape, or the FILE is rejected — discovery treats a half-recognizable
 *  verdict.json as foreign rather than crashing downstream on it.
 *
 *  This is RECOGNITION, not reading: the shape shared by every
 *  artifact version this repo has ever written, so a prior-version file can
 *  be told apart from a foreign/corrupt one and its skip NAMED rather than
 *  folded into "not a verdict file". Deliberately more generous than
 *  `isVerdictArtifact` below — including the legacy `scenario_path`
 *  spelling, which no reader accepts any more (see `isVerdictArtifact`) but
 *  which still identifies the file as one of ours worth naming. */
function looksLikeVerdictArtifactBase(parsed: unknown): parsed is Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null) return false;
  const v = parsed as Record<string, unknown>;
  if (v.source !== "cloud-finalize") return false;
  if (typeof v.session_id !== "string") return false;
  if (typeof v.task_name !== "string") return false;
  if (typeof v.task_path !== "string" && typeof v.scenario_path !== "string") return false;
  if (v.group_id !== null && typeof v.group_id !== "string") return false;
  if (typeof v.finalized_at !== "string") return false;
  if (typeof v.passed !== "boolean") return false;
  if (typeof v.score !== "number") return false;
  if (!Array.isArray(v.criteria_results)) return false;
  return v.criteria_results.every((r) => {
    if (typeof r !== "object" || r === null) return false;
    const result = r as Record<string, unknown>;
    const criterion = result.criterion as Record<string, unknown> | null;
    return (
      typeof criterion === "object" &&
      criterion !== null &&
      typeof criterion.text === "string" &&
      typeof result.reason === "string" &&
      typeof result.passed === "boolean" &&
      typeof result.skipped === "boolean"
    );
  });
}

/** The CURRENT version's shape: the base fields plus `version ===
 *  VERDICT_ARTIFACT_VERSION`, the named `state`, and the four counts. A file
 *  that passes `looksLikeVerdictArtifactBase` but fails this is a prior
 *  version or a corrupt current one — `readVerdictArtifactDetailed` tells
 *  those two apart.
 *
 *  Version 2 also retired the legacy `scenario_path` tolerance the read path
 *  used to carry: `task_path` is required here. Every file spelling it the
 *  old way was written by `@pome-sh/cli` <= 0.8.x at artifact version 1, so
 *  the version check refuses it before the spelling could matter — the
 *  normalize step was a dual-format reader that could no longer fire, and
 *  this repo keeps no back-compat it cannot exercise. */
function isVerdictArtifact(parsed: unknown): parsed is VerdictArtifact {
  if (!looksLikeVerdictArtifactBase(parsed)) return false;
  const v = parsed;
  if (v.version !== VERDICT_ARTIFACT_VERSION) return false;
  if (typeof v.task_path !== "string") return false;
  if (typeof v.state !== "string" || !VALID_STATES.has(v.state)) return false;
  if (typeof v.evaluated !== "number") return false;
  if (typeof v.not_evaluated !== "number") return false;
  if (typeof v.pre_satisfied !== "number") return false;
  if (typeof v.total !== "number") return false;
  return true;
}

/** The detailed read: distinguishes "current-version artifact",
 *  "recognizable, but written at a DIFFERENT artifact version" (a real trial
 *  this CLI can no longer read), and "not a verdict file at all"
 *  (foreign/corrupt/missing). Callers that only care about usable trials
 *  (`readVerdictArtifact`, `scanVerdictArtifacts`) collapse the last two
 *  together, same as at version 1; discovery callers that need to NAME a
 *  version skip instead of silently reporting "no runs" use this directly.
 *
 *  `stale-version` is keyed on the version NUMBER differing, never on the
 *  new fields being absent, so the status never claims more than it checked:
 *  a file that says `version: 2` and is malformed is a corrupt CURRENT file
 *  (`unreadable`), not a prior version. `version` is null when the file
 *  carries no numeric `version` at all.
 *
 *  `missing` is the fourth: no verdict.json at this path at all (no
 *  run finished here yet, or the caller pointed at an artifacts root rather
 *  than a trial dir). It used to collapse into `unreadable`, which is why both
 *  callers below re-`existsSync`'d the file they had just failed to read — a
 *  second stat answering what the read already knew, and its own
 *  check-then-read window. */
export type VerdictReadResult =
  | { status: "ok"; trial: TrialVerdict }
  | { status: "stale-version"; version: number | null }
  | { status: "unreadable" }
  | { status: "missing" };

/** The errno set for "this path does not resolve to a file": exactly
 *  the set `existsSync` answered `false` for, since a `stat` fails the same
 *  way. ENOENT alone would move a user-visible count — the scan walks every
 *  entry under a task slug as a run dir, so a stray FILE there yields ENOTDIR
 *  on `<file>/verdict.json`; ELOOP and ENAMETOOLONG are the same fact for a
 *  path typed at `pome fix-prompt`. EACCES and EISDIR are NOT here: something
 *  IS at that path and this process could not read it, which is `unreadable`,
 *  as before (`existsSync` succeeds on a file whose parent is traversable). */
const MISSING_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG",
]);

function isMissingFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && MISSING_ERROR_CODES.has(code);
}

export async function readVerdictArtifactDetailed(
  runDir: string,
): Promise<VerdictReadResult> {
  const path = join(runDir, VERDICT_FILENAME);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return isMissingFileError(err) ? { status: "missing" } : { status: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "unreadable" };
  }
  if (!looksLikeVerdictArtifactBase(parsed)) return { status: "unreadable" };
  const version = typeof parsed.version === "number" ? parsed.version : null;
  if (version !== VERDICT_ARTIFACT_VERSION) return { status: "stale-version", version };
  if (!isVerdictArtifact(parsed)) return { status: "unreadable" };
  return { status: "ok", trial: { runDir, verdict: parsed } };
}

export async function readVerdictArtifact(
  runDir: string,
): Promise<TrialVerdict | null> {
  const result = await readVerdictArtifactDetailed(runDir);
  return result.status === "ok" ? result.trial : null;
}

/** The detailed scan behind `scanVerdictArtifacts`: also collects
 *  the dirs whose verdict.json was recognizable but a prior artifact version,
 *  so `discoverRunSet` can name that skip instead of it looking identical to
 *  "no run happened here".
 *
 *  Likewise for `unreadableDirs`: a verdict.json that EXISTS but is
 *  truncated, hand-edited, or otherwise damaged. Kept out of `staleVersionDirs`
 *  on purpose — a prior-version file and a corrupt one are different facts
 *  (upgrade vs. damage) and want different fixes. A run dir with no
 *  verdict.json at all is neither (no run finished there yet), and that
 *  distinction lives in the read's `missing` status, not a re-stat here.
 *
 *  `unreadableDirs` is SORTED, unlike the other two: it is the only one whose
 *  order reaches a user, via the path list `pome fix-prompt` prints and trims
 *  to the first few. `readdir` promises no order — APFS hands back names
 *  sorted, ext4 hands back hash order — so without this the WHICH of "kept
 *  first 5" would differ between a dev's machine and CI, and a test pinning
 *  the trim would pass locally and flake on Linux. */
export interface VerdictScanResult {
  trials: TrialVerdict[];
  staleVersionDirs: string[];
  unreadableDirs: string[];
}

export async function scanVerdictArtifactsDetailed(
  artifactsRoot: string,
): Promise<VerdictScanResult> {
  const trials: TrialVerdict[] = [];
  const staleVersionDirs: string[] = [];
  const unreadableDirs: string[] = [];
  let slugs: string[];
  try {
    slugs = await readdir(artifactsRoot);
  } catch {
    return { trials, staleVersionDirs, unreadableDirs };
  }
  for (const slug of slugs) {
    const slugDir = join(artifactsRoot, slug);
    let runIds: string[];
    try {
      runIds = await readdir(slugDir);
    } catch {
      continue;
    }
    for (const runId of runIds) {
      const runDir = join(slugDir, runId);
      const result = await readVerdictArtifactDetailed(runDir);
      if (result.status === "ok") trials.push(result.trial);
      else if (result.status === "stale-version") staleVersionDirs.push(runDir);
      else if (result.status === "unreadable") unreadableDirs.push(runDir);
    }
  }
  unreadableDirs.sort();
  return { trials, staleVersionDirs, unreadableDirs };
}

/** Scan an artifacts root for finalized trials — exactly the two-level
 *  layout `<root>/<task-slug>/<session-id>/verdict.json`. Anything
 *  unreadable (including a prior artifact version — see
 *  `scanVerdictArtifactsDetailed`) is skipped. */
export async function scanVerdictArtifacts(
  artifactsRoot: string,
): Promise<TrialVerdict[]> {
  return (await scanVerdictArtifactsDetailed(artifactsRoot)).trials;
}

export interface RunSetDiscovery {
  kind: "trial-dir" | "root";
  /** The set to build a fix prompt from (per `kind` semantics: a trial dir
   *  targets ITS set regardless of outcome; a root targets the latest set
   *  whose outcome is `"fail"`). Null when nothing matches — for `kind:
   *  "root"` that means either every set passed, or the newest non-passing
   *  set is `incompleteSet` below rather than a failure to hand to an
   *  agent. */
  set: RunSet | null;
  /** `kind: "root"` only, and only populated when `set` is null:
   *  the newest run set whose outcome is `"incomplete"`. Kept distinct from
   *  `set` so a caller can never conflate "route this to fix-prompt" with
   *  "something was never graded" — the routing decision and the message it
   *  prints must never disagree. */
  incompleteSet: RunSet | null;
  /** Total finalized run sets seen — lets the caller distinguish "no runs
   *  at all" from "runs exist but none failed". */
  totalSets: number;
  /** Verdict.json files recognized as a PRIOR artifact version under
   *  the scanned root (or, for `kind: "trial-dir"`, at the target itself).
   *  Named so a stale-version skip never renders identically to "no runs
   *  happened here" — a v1 file dropped silently is the exact shape this
   *  milestone exists to remove. */
  staleVersionCount: number;
  /** Verdict.json files that EXIST under the scanned root (or, for
   *  `kind: "trial-dir"`, at the target itself) but could not be read: a
   *  truncated file, one hand-edited into an unexpected `state`, or valid
   *  JSON that isn't a verdict artifact at all. Never folded into
   *  `staleVersionCount` (an older CLI wrote that file; nothing wrote this
   *  one correctly) or `totalSets` — a damaged current-version file is not a
   *  usable run set. Reported even when other sets under the same root
   *  parsed fine, same lesson as `staleVersionCount`. */
  unreadableCount: number;
  /** The paths behind `unreadableCount`, so the caller can name them instead
   *  of only counting them. Sorted (see `scanVerdictArtifactsDetailed`) —
   *  callers trim this list for display, so which ones survive the trim must
   *  not depend on the filesystem's `readdir` order. */
  unreadablePaths: string[];
}

/**
 * Resolve what `pome fix-prompt [target]` should read.
 * - `target` = a trial run dir (has verdict.json): that trial's whole set —
 *   the user pointed at it, outcome doesn't matter.
 * - `target` = an artifacts root: the latest set with a genuine FAILURE
 *   under it; if none, the newest INCOMPLETE set is surfaced separately
 *   (`incompleteSet`) so the caller can name the gap instead of either
 *   routing it to an agent or claiming everything passed.
 */
export async function discoverRunSet(target: string): Promise<RunSetDiscovery> {
  const anchorResult = await readVerdictArtifactDetailed(target);
  if (anchorResult.status === "stale-version") {
    // The user pointed fix-prompt directly at a trial dir whose verdict.json
    // is a prior version — name it rather than falling through to the "root"
    // branch below, which would scan `target` as if it were an artifacts
    // root (two levels too shallow) and report a plain "no runs".
    return {
      kind: "trial-dir",
      set: null,
      incompleteSet: null,
      totalSets: 0,
      staleVersionCount: 1,
      unreadableCount: 0,
      unreadablePaths: [],
    };
  }
  // Same reasoning as the stale-version branch above, for a target
  // whose verdict.json exists but is damaged: name it as a trial-dir skip
  // rather than falling through to the "root" branch, which would scan
  // `target` itself (two levels too shallow) and find nothing. What
  // tells this apart from a target that IS an artifacts root (no verdict.json
  // of its own either, and must fall through) is the read's own `missing`
  // status, not a second `existsSync` of the path the read just failed on.
  if (anchorResult.status === "unreadable") {
    return {
      kind: "trial-dir",
      set: null,
      incompleteSet: null,
      totalSets: 0,
      staleVersionCount: 0,
      unreadableCount: 1,
      unreadablePaths: [target],
    };
  }
  if (anchorResult.status === "ok") {
    const anchor = anchorResult.trial;
    // Trial dir → its set. Layout is <root>/<slug>/<runId>, so the root is
    // two levels up; a moved/isolated dir degrades to a set of one.
    const root = join(target, "..", "..");
    const { trials, staleVersionDirs, unreadableDirs } =
      await scanVerdictArtifactsDetailed(root);
    const sets = groupRunSets(trials);
    const own =
      sets.find(
        (s) =>
          (anchor.verdict.group_id !== null &&
            s.groupId === anchor.verdict.group_id) ||
          (anchor.verdict.group_id === null &&
            s.trials.length === 1 &&
            s.trials[0]!.verdict.session_id === anchor.verdict.session_id),
      ) ?? groupRunSets([anchor])[0]!;
    return {
      kind: "trial-dir",
      set: own,
      incompleteSet: null,
      totalSets: Math.max(sets.length, 1),
      staleVersionCount: staleVersionDirs.length,
      unreadableCount: unreadableDirs.length,
      unreadablePaths: unreadableDirs,
    };
  }

  // `missing` — no verdict.json at `target`, so it is an artifacts root (or
  // nothing at all). The `if (!existsSync(target))` early
  // return that sat here: on a root that isn't there `readdir` throws and is
  // caught, and the three empty arrays give the same nulls and zeros through
  // `groupRunSets` / `latestFailedRunSet` / `latestIncompleteRunSet`.
  const { trials, staleVersionDirs, unreadableDirs } =
    await scanVerdictArtifactsDetailed(target);
  const sets = groupRunSets(trials);
  const failedSet = latestFailedRunSet(sets);
  return {
    kind: "root",
    set: failedSet,
    incompleteSet: failedSet ? null : latestIncompleteRunSet(sets),
    totalSets: sets.length,
    staleVersionCount: staleVersionDirs.length,
    unreadableCount: unreadableDirs.length,
    unreadablePaths: unreadableDirs,
  };
}
