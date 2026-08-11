// SPDX-License-Identifier: Apache-2.0
// FDRS-644 — the per-trial cloud verdict artifact (verdict.json): write/read
// roundtrip, the two-level scan, run-set grouping, latest-FAILED selection,
// and the fix-prompt discovery semantics (trial dir → its set regardless of
// outcome; root → latest failed set). Foreign/corrupt files never throw.
//
// F-1404 — `outcome` (fail / incomplete / pass) is derived from the on-disk
// `state`, not `!passed`: `passed` alone can't tell a genuine failure apart
// from a trial the grader never finished, and both used to trip the old
// `anyFailed` boolean the same way.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERDICT_ARTIFACT_VERSION,
  discoverRunSet,
  readVerdictArtifact,
  readVerdictArtifactDetailed,
  scanVerdictArtifacts,
  scanVerdictArtifactsDetailed,
  writeVerdictArtifact,
  type VerdictArtifact,
} from "../../../src/hosted/evalResultCache.js";
import {
  groupRunSets,
  latestFailedRunSet,
  latestIncompleteRunSet,
} from "../../../src/hosted/runSets.js";

function verdict(over: Partial<VerdictArtifact>): VerdictArtifact {
  return {
    version: VERDICT_ARTIFACT_VERSION,
    source: "cloud-finalize",
    task_name: "scn",
    task_path: "tasks/scn.md",
    group_id: null,
    session_id: "ses_x",
    cloud_run_id: "run_x",
    cloud_dashboard_url: "https://app.pome.sh/runs/run_x",
    judge_model: "test-judge",
    score: 100,
    pass_threshold: 100,
    state: "pass",
    passed: true,
    evaluated: 1,
    not_evaluated: 0,
    pre_satisfied: 0,
    total: 1,
    criteria_results: [
      {
        criterion: { type: "model", text: "Severity is set correctly" },
        passed: true,
        skipped: false,
        reason: "ok",
      },
    ],
    duration_ms: 1000,
    finalized_at: "2026-07-06T00:00:00.000Z",
    ...over,
  };
}

/** F-1195 — a verdict.json exactly as a pre-F-1195 CLI wrote it: recognizable
 *  (source/session_id/task_name/task_path/criteria_results all present and
 *  shaped) but missing `state` and the four counts, at `version: 1`. */
function v1OnDiskArtifact(sessionId: string): Record<string, unknown> {
  return {
    version: 1,
    source: "cloud-finalize",
    task_name: "scn",
    task_path: "tasks/scn.md",
    group_id: null,
    session_id: sessionId,
    cloud_run_id: "run_v1",
    cloud_dashboard_url: "https://app.pome.sh/runs/run_v1",
    judge_model: "test-judge",
    score: 100,
    pass_threshold: 100,
    passed: false,
    criteria_results: [
      {
        criterion: { type: "model", text: "Severity is set correctly" },
        passed: true,
        skipped: false,
        reason: "ok",
      },
    ],
    duration_ms: 1000,
    finalized_at: "2026-07-06T00:00:00.000Z",
  };
}

async function writeTrial(
  root: string,
  slug: string,
  sid: string,
  over: Partial<VerdictArtifact>,
): Promise<string> {
  const runDir = join(root, slug, sid);
  await mkdir(runDir, { recursive: true });
  await writeVerdictArtifact(runDir, verdict({ session_id: sid, ...over }));
  return runDir;
}

describe("verdict artifact (FDRS-644)", () => {
  it("write/read roundtrip; corrupt and foreign files read as null", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-"));
    const runDir = join(tmp, "scn", "ses_1");
    await mkdir(runDir, { recursive: true });
    await writeVerdictArtifact(runDir, verdict({ session_id: "ses_1" }));
    const read = await readVerdictArtifact(runDir);
    expect(read?.verdict.session_id).toBe("ses_1");
    expect(read?.verdict.source).toBe("cloud-finalize");

    const corrupt = join(tmp, "scn", "ses_2");
    await mkdir(corrupt, { recursive: true });
    await writeFile(join(corrupt, "verdict.json"), "{not json", "utf8");
    expect(await readVerdictArtifact(corrupt)).toBeNull();

    const foreign = join(tmp, "scn", "ses_3");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "verdict.json"), '{"hello":"world"}', "utf8");
    expect(await readVerdictArtifact(foreign)).toBeNull();

    expect(await readVerdictArtifact(join(tmp, "scn", "nope"))).toBeNull();
  });

  it("writes `task_path`; the retired `scenario_path` spelling is refused BY NAME, not normalized (F-1195)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-legacy-"));

    // Write path: the retired spelling never lands on disk again.
    const fresh = join(tmp, "scn", "ses_new");
    await mkdir(fresh, { recursive: true });
    await writeVerdictArtifact(fresh, verdict({ session_id: "ses_new" }));
    const onDisk = JSON.parse(
      await readFile(join(fresh, "verdict.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(onDisk.task_path).toBe("tasks/scn.md");
    expect(onDisk).not.toHaveProperty("scenario_path");

    // Read path: F-933's normalize branch is gone. Every file spelling the
    // path the old way was written by `@pome-sh/cli` <= 0.8.x at artifact
    // version 1, so the version gate refuses it first — but it is still
    // RECOGNIZED as ours, so the skip is named rather than silently dropped
    // the way a foreign file is.
    const legacyDir = join(tmp, "scn", "ses_old");
    await mkdir(legacyDir, { recursive: true });
    const { task_path: _tp, ...withoutTaskPath } = verdict({ session_id: "ses_old" });
    await writeFile(
      join(legacyDir, "verdict.json"),
      JSON.stringify({ ...withoutTaskPath, version: 1, scenario_path: "scenarios/scn.md" }),
      "utf8",
    );
    expect(await readVerdictArtifact(legacyDir)).toBeNull();
    expect(await readVerdictArtifactDetailed(legacyDir)).toEqual({
      status: "stale-version",
      version: 1,
    });

    // Neither spelling present → not recognizable as a verdict.json at all,
    // which is a different answer from "a version we can't read".
    const neither = join(tmp, "scn", "ses_none");
    await mkdir(neither, { recursive: true });
    await writeFile(join(neither, "verdict.json"), JSON.stringify(withoutTaskPath), "utf8");
    expect(await readVerdictArtifactDetailed(neither)).toEqual({ status: "unreadable" });
  });

  it("rejects half-recognizable files instead of crashing downstream (adversarial fix)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-hostile-"));
    const base = verdict({});

    // finalized_at missing → groupRunSets would crash sorting on it.
    const noFinalized = join(tmp, "scn", "h1");
    await mkdir(noFinalized, { recursive: true });
    const { finalized_at: _f, ...rest } = base;
    await writeFile(join(noFinalized, "verdict.json"), JSON.stringify(rest), "utf8");
    expect(await readVerdictArtifact(noFinalized)).toBeNull();

    // criteria_results elements must be shaped — [null] and [{}] crash
    // prompt assembly if let through.
    for (const [name, results] of [
      ["h2", [null]],
      ["h3", [{}]],
      ["h4", [{ criterion: { text: 42 }, reason: "x", passed: true, skipped: false }]],
    ] as const) {
      const dir = join(tmp, "scn", name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "verdict.json"),
        JSON.stringify({ ...base, criteria_results: results }),
        "utf8",
      );
      expect(await readVerdictArtifact(dir)).toBeNull();
    }
  });

  it("scan walks exactly <root>/<slug>/<runId>/verdict.json and skips junk", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-scan-"));
    await writeTrial(tmp, "scn", "ses_1", {});
    await writeTrial(tmp, "other", "ses_2", { task_name: "other" });
    await writeFile(join(tmp, "loose.json"), "{}", "utf8");
    await mkdir(join(tmp, "scn", "empty-dir"), { recursive: true });

    const scanned = await scanVerdictArtifacts(tmp);
    expect(scanned.map((t) => t.verdict.session_id).sort()).toEqual([
      "ses_1",
      "ses_2",
    ]);
    expect(await scanVerdictArtifacts(join(tmp, "missing"))).toEqual([]);
  });

  it("groups by group_id (solo runs are their own sets) and finds the latest FAILED set", async () => {
    const trials = [
      // group A: newer, all passed
      { runDir: "a1", verdict: verdict({ group_id: "grp_a", session_id: "a1", finalized_at: "2026-07-06T03:00:00Z" }) },
      { runDir: "a2", verdict: verdict({ group_id: "grp_a", session_id: "a2", finalized_at: "2026-07-06T03:01:00Z" }) },
      // group B: older, one genuinely failed
      { runDir: "b1", verdict: verdict({ group_id: "grp_b", session_id: "b1", finalized_at: "2026-07-06T01:00:00Z" }) },
      { runDir: "b2", verdict: verdict({ group_id: "grp_b", session_id: "b2", passed: false, state: "fail", score: 40, finalized_at: "2026-07-06T01:01:00Z" }) },
      // solo run, failed, oldest
      { runDir: "s1", verdict: verdict({ session_id: "s1", passed: false, state: "fail", finalized_at: "2026-07-06T00:00:00Z" }) },
    ];
    const sets = groupRunSets(trials);
    expect(sets).toHaveLength(3);
    // Sorted by latest finalize ascending; trials inside sorted ascending.
    expect(sets.map((s) => s.groupId)).toEqual([null, "grp_b", "grp_a"]);
    expect(sets[2]!.outcome).toBe("pass");
    expect(sets[1]!.outcome).toBe("fail");
    expect(sets[1]!.trials.map((t) => t.verdict.session_id)).toEqual(["b1", "b2"]);

    // Latest FAILED ≠ latest overall: grp_a is newest but green.
    expect(latestFailedRunSet(sets)?.groupId).toBe("grp_b");
    // No set is incomplete-only in this table.
    expect(latestIncompleteRunSet(sets)).toBeNull();
  });

  // F-1392 — the old `anyFailed` read `!t.verdict.passed`, so a group holding
  // a trial whose only non-passing criterion was pre-satisfied must NOT trip
  // it, or it gets misrouted to `pome fix-prompt` as an agent defect. This is
  // resolved upstream in `scoreFromFinalizeResponse` (the trial's `passed`
  // and `state` are written correctly at verdict.json write time); this test
  // pins the group-level behavior against the artifact directly rather than
  // re-deriving it.
  it("a group holding a pre-satisfied-only trial (state: pass) has outcome pass, not fail", async () => {
    const trials = [
      {
        runDir: "p1",
        verdict: verdict({
          group_id: "grp_p",
          session_id: "p1",
          passed: true,
          state: "pass",
          criteria_results: [
            {
              criterion: { type: "code", text: "github.no-new-issues" },
              passed: false,
              skipped: true,
              reason: "already_true_in_seed",
            },
          ],
          finalized_at: "2026-08-10T00:00:00Z",
        }),
      },
      {
        runDir: "p2",
        verdict: verdict({ group_id: "grp_p", session_id: "p2", finalized_at: "2026-08-10T00:01:00Z" }),
      },
    ];
    const sets = groupRunSets(trials);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.outcome).toBe("pass");
  });

  // F-1404 — the defect as filed: a set holding ONLY an incomplete trial (no
  // trial genuinely failed) must not read as `outcome: "fail"`. Both trials
  // here have `passed: false` (the old, wrong signal) but neither has
  // `state: "fail"` — this is the exact shape `!t.verdict.passed` could not
  // tell apart from group B above.
  it("a group whose only non-passing trials are INCOMPLETE has outcome incomplete, not fail", async () => {
    const trials = [
      {
        runDir: "i1",
        verdict: verdict({
          group_id: "grp_i",
          session_id: "i1",
          passed: false,
          state: "incomplete",
          score: 0,
          evaluated: 0,
          not_evaluated: 1,
          total: 1,
          finalized_at: "2026-08-10T01:00:00Z",
        }),
      },
      {
        runDir: "i2",
        verdict: verdict({
          group_id: "grp_i",
          session_id: "i2",
          passed: false,
          state: "incomplete",
          score: 0,
          evaluated: 0,
          not_evaluated: 1,
          total: 1,
          finalized_at: "2026-08-10T01:01:00Z",
        }),
      },
    ];
    const sets = groupRunSets(trials);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.outcome).toBe("incomplete");
    // The reversed defect, pinned directly: an incomplete-only set must
    // never be picked up as the latest FAILED set either.
    expect(latestFailedRunSet(sets)).toBeNull();
    expect(latestIncompleteRunSet(sets)?.groupId).toBe("grp_i");
  });

  // F-1404 — a set mixing a genuine failure with an incomplete trial: the
  // failure is real signal and must win. `fix-prompt` should still be told
  // there is something to fix here, not that the set merely has a grading
  // gap.
  it("a group mixing a genuine failure and an incomplete trial has outcome fail (fail wins)", async () => {
    const trials = [
      {
        runDir: "m1",
        verdict: verdict({
          group_id: "grp_m",
          session_id: "m1",
          passed: false,
          state: "fail",
          score: 0,
          finalized_at: "2026-08-10T02:00:00Z",
        }),
      },
      {
        runDir: "m2",
        verdict: verdict({
          group_id: "grp_m",
          session_id: "m2",
          passed: false,
          state: "incomplete",
          score: 0,
          evaluated: 0,
          not_evaluated: 1,
          total: 1,
          finalized_at: "2026-08-10T02:01:00Z",
        }),
      },
    ];
    const sets = groupRunSets(trials);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.outcome).toBe("fail");
    expect(latestFailedRunSet(sets)?.groupId).toBe("grp_m");
    // A set already counted as failed is never ALSO reported as the latest
    // incomplete one — that would be the same set under two names.
    expect(latestIncompleteRunSet(sets)).toBeNull();
  });

  // F-1404 — "pass" is the one outcome that asserts a verified result, so it
  // must never be what an unrecognized `state` falls through to. The read path
  // already refuses such a file (`isVerdictArtifact` checks `state` against
  // the three words), so this pins the SECOND line of defense: a `state` this
  // build does not know reads "incomplete", the claim that checks least — an
  // ungraded run must not become an invisible one.
  it("groupRunSets never reports an unrecognized state as a pass", () => {
    const sets = groupRunSets([
      {
        runDir: "x1",
        verdict: verdict({
          group_id: "grp_x",
          session_id: "x1",
          state: "who-knows" as never,
        }),
      },
    ]);
    expect(sets[0]!.outcome).toBe("incomplete");
    expect(latestFailedRunSet(sets)).toBeNull();
  });

  it("discoverRunSet(root): latest failed set; all-green roots return set=null with totalSets>0", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-root-"));
    await writeTrial(tmp, "scn", "g1", { group_id: "grp_g", finalized_at: "2026-07-06T05:00:00Z" });
    await writeTrial(tmp, "scn", "f1", {
      group_id: "grp_f",
      passed: false,
      state: "fail",
      score: 0,
      finalized_at: "2026-07-06T04:00:00Z",
    });

    const d = await discoverRunSet(tmp);
    expect(d.kind).toBe("root");
    expect(d.totalSets).toBe(2);
    expect(d.set?.groupId).toBe("grp_f");
    // A genuine failure exists, so the incomplete slot stays empty even
    // though nothing else checked for an incomplete set here.
    expect(d.incompleteSet).toBeNull();

    const green = await mkdtemp(join(tmpdir(), "verdict-green-"));
    await writeTrial(green, "scn", "g2", { group_id: "grp_h" });
    const dg = await discoverRunSet(green);
    expect(dg.totalSets).toBe(1);
    expect(dg.set).toBeNull();
    expect(dg.incompleteSet).toBeNull();

    const empty = await mkdtemp(join(tmpdir(), "verdict-empty-"));
    const de = await discoverRunSet(empty);
    expect(de.totalSets).toBe(0);
    expect(de.set).toBeNull();

    const missing = await discoverRunSet(join(empty, "nope"));
    expect(missing.totalSets).toBe(0);
  });

  // F-1404 — the root-level shape the ticket names directly: a root whose
  // only non-passing run set is INCOMPLETE. `set` must stay null (nothing
  // here is proven to be the agent's fault) and `incompleteSet` must name
  // the gap instead of the caller falling back to "all passed".
  it("discoverRunSet(root): an incomplete-only root surfaces incompleteSet, not set", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-incomplete-root-"));
    await writeTrial(tmp, "scn", "i1", {
      group_id: "grp_i",
      passed: false,
      state: "incomplete",
      score: 0,
      evaluated: 0,
      not_evaluated: 1,
      total: 1,
      finalized_at: "2026-08-10T01:00:00Z",
    });

    const d = await discoverRunSet(tmp);
    expect(d.kind).toBe("root");
    expect(d.set).toBeNull();
    expect(d.incompleteSet?.groupId).toBe("grp_i");
  });

  it("discoverRunSet(trial dir): that trial's whole set, even when it passed", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-trial-"));
    const t1 = await writeTrial(tmp, "scn", "t1", { group_id: "grp_t", finalized_at: "2026-07-06T01:00:00Z" });
    await writeTrial(tmp, "scn", "t2", { group_id: "grp_t", passed: false, finalized_at: "2026-07-06T01:01:00Z" });
    await writeTrial(tmp, "scn", "z9", { group_id: "grp_z", passed: false, finalized_at: "2026-07-06T09:00:00Z" });

    const d = await discoverRunSet(t1);
    expect(d.kind).toBe("trial-dir");
    expect(d.set?.groupId).toBe("grp_t");
    expect(d.set?.trials.map((t) => t.verdict.session_id)).toEqual(["t1", "t2"]);
  });

  // F-1195 — a v1 artifact is RECOGNIZABLE (it has every field a verdict.json
  // has always had), just missing `state` and the four counts this ticket
  // added. `readVerdictArtifact` still refuses it (no dual-format reader —
  // zero customers), but the detailed API must say WHY, distinctly from a
  // foreign/corrupt file, so a v1 run never looks identical to "no run
  // happened here" to fix-prompt discovery.
  describe("v1 verdict.json is a named stale-version skip, not a silent drop (F-1195)", () => {
    it("readVerdictArtifact still returns null for a v1 file (no dual-format reader)", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-v1-"));
      const dir = join(tmp, "scn", "ses_v1");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "verdict.json"), JSON.stringify(v1OnDiskArtifact("ses_v1")), "utf8");
      expect(await readVerdictArtifact(dir)).toBeNull();
    });

    it("readVerdictArtifactDetailed names it stale-version with the on-disk version number", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-v1-detail-"));
      const dir = join(tmp, "scn", "ses_v1");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "verdict.json"), JSON.stringify(v1OnDiskArtifact("ses_v1")), "utf8");
      expect(await readVerdictArtifactDetailed(dir)).toEqual({
        status: "stale-version",
        version: 1,
      });
      // A genuinely foreign file is still a plain "unreadable", not confused
      // for a stale version.
      const foreignDir = join(tmp, "scn", "foreign");
      await mkdir(foreignDir, { recursive: true });
      await writeFile(join(foreignDir, "verdict.json"), '{"hello":"world"}', "utf8");
      expect(await readVerdictArtifactDetailed(foreignDir)).toEqual({ status: "unreadable" });
    });

    it("`stale-version` is keyed on the version number, never on the new fields being absent", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-version-key-"));

      // A file that CLAIMS the current version but is missing `state` is a
      // corrupt current-version file, not a prior version — saying
      // "stale-version" about it would be the artifact stating more than it
      // checked, one layer down.
      const corruptCurrent = join(tmp, "scn", "ses_corrupt");
      await mkdir(corruptCurrent, { recursive: true });
      const { state: _state, ...withoutState } = verdict({ session_id: "ses_corrupt" });
      await writeFile(
        join(corruptCurrent, "verdict.json"),
        JSON.stringify(withoutState),
        "utf8",
      );
      expect(await readVerdictArtifactDetailed(corruptCurrent)).toEqual({
        status: "unreadable",
      });

      // A file with no `version` key at all (the very first writers) is a
      // version we can't read, reported with `version: null` rather than a
      // guessed number.
      const noVersion = join(tmp, "scn", "ses_nover");
      await mkdir(noVersion, { recursive: true });
      const { version: _v, ...withoutVersion } = verdict({ session_id: "ses_nover" });
      await writeFile(join(noVersion, "verdict.json"), JSON.stringify(withoutVersion), "utf8");
      expect(await readVerdictArtifactDetailed(noVersion)).toEqual({
        status: "stale-version",
        version: null,
      });

      // And a FUTURE version (a newer CLI wrote it) is the same named skip —
      // the check is `!== VERDICT_ARTIFACT_VERSION`, and no surface claims it
      // was "older".
      const future = join(tmp, "scn", "ses_future");
      await mkdir(future, { recursive: true });
      await writeFile(
        join(future, "verdict.json"),
        JSON.stringify(verdict({ session_id: "ses_future", version: 99 })),
        "utf8",
      );
      expect(await readVerdictArtifactDetailed(future)).toEqual({
        status: "stale-version",
        version: 99,
      });
    });

    it("scanVerdictArtifactsDetailed separates stale-version dirs from readable trials", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-v1-scan-"));
      await writeTrial(tmp, "scn", "ses_current", {});
      const staleDir = join(tmp, "scn", "ses_v1");
      await mkdir(staleDir, { recursive: true });
      await writeFile(join(staleDir, "verdict.json"), JSON.stringify(v1OnDiskArtifact("ses_v1")), "utf8");

      const { trials, staleVersionDirs } = await scanVerdictArtifactsDetailed(tmp);
      expect(trials.map((t) => t.verdict.session_id)).toEqual(["ses_current"]);
      expect(staleVersionDirs).toEqual([staleDir]);
      // The plain (non-detailed) scan still only returns readable trials.
      expect((await scanVerdictArtifacts(tmp)).map((t) => t.verdict.session_id)).toEqual([
        "ses_current",
      ]);
    });

    it("discoverRunSet(root) reports staleVersionCount alongside totalSets:0 instead of looking like an empty runs/", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-v1-root-"));
      const staleDir = join(tmp, "scn", "ses_v1");
      await mkdir(staleDir, { recursive: true });
      await writeFile(join(staleDir, "verdict.json"), JSON.stringify(v1OnDiskArtifact("ses_v1")), "utf8");

      const discovery = await discoverRunSet(tmp);
      expect(discovery.kind).toBe("root");
      expect(discovery.totalSets).toBe(0);
      expect(discovery.set).toBeNull();
      expect(discovery.staleVersionCount).toBe(1);

      // A truly empty runs/ still reports staleVersionCount: 0 — the two
      // "nothing to read" cases stay distinguishable.
      const empty = await mkdtemp(join(tmpdir(), "verdict-v1-empty-"));
      const emptyDiscovery = await discoverRunSet(empty);
      expect(emptyDiscovery.totalSets).toBe(0);
      expect(emptyDiscovery.staleVersionCount).toBe(0);
    });

    it("discoverRunSet(root) still counts stale trials when readable ones exist beside them", async () => {
      // The realistic upgrade shape, and the one a "only report it when
      // there's nothing else" guard would drop: a group half-written by the
      // old CLI. The set fix-prompt builds is SHORT, so the count has to
      // survive to the caller or the prompt silently covers fewer trials
      // than the dir holds.
      const tmp = await mkdtemp(join(tmpdir(), "verdict-v1-mixed-"));
      await writeTrial(tmp, "scn", "ses_current", {
        group_id: "grp_mixed",
        passed: false,
        state: "fail",
      });
      const staleDir = join(tmp, "scn", "ses_v1");
      await mkdir(staleDir, { recursive: true });
      await writeFile(join(staleDir, "verdict.json"), JSON.stringify(v1OnDiskArtifact("ses_v1")), "utf8");

      const discovery = await discoverRunSet(tmp);
      expect(discovery.totalSets).toBe(1);
      expect(discovery.set?.trials.map((t) => t.verdict.session_id)).toEqual(["ses_current"]);
      expect(discovery.staleVersionCount).toBe(1);
    });

    it("discoverRunSet(trial dir) pointed straight at a v1 verdict.json names the skip", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-v1-trialdir-"));
      const staleDir = join(tmp, "scn", "ses_v1");
      await mkdir(staleDir, { recursive: true });
      await writeFile(join(staleDir, "verdict.json"), JSON.stringify(v1OnDiskArtifact("ses_v1")), "utf8");

      const discovery = await discoverRunSet(staleDir);
      expect(discovery.kind).toBe("trial-dir");
      expect(discovery.set).toBeNull();
      expect(discovery.totalSets).toBe(0);
      expect(discovery.staleVersionCount).toBe(1);
    });
  });
});
