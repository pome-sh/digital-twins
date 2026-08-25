// SPDX-License-Identifier: Apache-2.0
// The per-trial cloud verdict artifact (verdict.json): write/read roundtrip, the
// two-level scan, run-set grouping, latest-FAILED selection, and the fix-prompt.

import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
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

/** A verdict.json exactly as a legacy CLI wrote it: recognizable
 *  (source/session_id/task_name/task_path/criteria_results all present and shaped) but missing. */
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

describe("verdict artifact", () => {
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

  it("writes `task_path`; the retired `scenario_path` spelling is refused BY NAME, not normalized", async () => {
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

    // Read path: the old spelling is not normalized into the new one. This
    // artifact is refused on its `version`, and the absent `task_path` is not
    // filled in from `scenario_path`.
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

  // Reading the group outcome off `!t.verdict.passed` would trip on a trial whose
  // only non-passing criterion was pre-satisfied. It must not.
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

  // The defect as filed: a set holding ONLY an incomplete trial (no trial genuinely
  // failed) must not read as `outcome: "fail"`.
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

  // A set mixing a genuine failure with an incomplete trial: the failure is real
  // signal and must win.
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

  // "pass" is the one outcome that asserts a verified result, so it must never be what
  // an unrecognized `state` falls through to.
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

  // The root-level shape the ticket names directly: a root whose only non-passing run
  // set is INCOMPLETE.
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

  // A v1 artifact is RECOGNIZABLE (it has every field a verdict.json has always had),
  // just missing `state` and the four counts this ticket added.
  describe("v1 verdict.json is a named stale-version skip, not a silent drop", () => {
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

      // A file claiming the current version but missing `state` is CORRUPT, not a
      // prior version: "stale-version" would state more than it checked.
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

  // A v2 verdict.json can be truncated, hand-edited into an unexpected `state`,
  // or valid JSON that is not a verdict artifact at all. Each must be named and
  // counted rather than passed off as a plain absence.
  describe("a corrupt current-version verdict.json is a named, counted 'unreadable' skip", () => {
    // Each of the three damage shapes the ticket names is asserted TWICE, and the
    // second assertion is the one that matters: `readVerdictArtifactDetailed` already.
    async function discoverOne(prefix: string, sid: string, body: string) {
      const tmp = await mkdtemp(join(tmpdir(), prefix));
      const dir = join(tmp, "scn", sid);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "verdict.json"), body, "utf8");
      return { dir, discovery: await discoverRunSet(tmp) };
    }

    it("a truncated verdict.json is counted and named, not dropped", async () => {
      const { dir, discovery } = await discoverOne(
        "verdict-truncated-",
        "ses_truncated",
        '{"version": 2, "source":',
      );
      expect(await readVerdictArtifactDetailed(dir)).toEqual({ status: "unreadable" });
      expect(discovery.unreadableCount).toBe(1);
      expect(discovery.unreadablePaths).toEqual([dir]);
      expect(discovery.staleVersionCount).toBe(0);
      expect(discovery.totalSets).toBe(0);
    });

    it("a v2 verdict.json with an unexpected `state` value is counted as unreadable, not as stale-version", async () => {
      const { dir, discovery } = await discoverOne(
        "verdict-badstate-",
        "ses_badstate",
        JSON.stringify(verdict({ session_id: "ses_badstate", state: "bogus" as never })),
      );
      expect(await readVerdictArtifactDetailed(dir)).toEqual({ status: "unreadable" });
      expect(discovery.unreadableCount).toBe(1);
      expect(discovery.unreadablePaths).toEqual([dir]);
      // The file CLAIMS the current version, so the stale-version count must
      // stay at zero: "an older CLI wrote this correctly" would be false.
      expect(discovery.staleVersionCount).toBe(0);
      expect(discovery.totalSets).toBe(0);
    });

    it("valid JSON that isn't a verdict artifact at all is counted and named", async () => {
      const { dir, discovery } = await discoverOne(
        "verdict-notartifact-",
        "ses_notartifact",
        JSON.stringify({ hello: "world", count: 3 }),
      );
      expect(await readVerdictArtifactDetailed(dir)).toEqual({ status: "unreadable" });
      expect(discovery.unreadableCount).toBe(1);
      expect(discovery.unreadablePaths).toEqual([dir]);
      expect(discovery.staleVersionCount).toBe(0);
      expect(discovery.totalSets).toBe(0);
    });

    it("scanVerdictArtifactsDetailed separates unreadable dirs from readable trials AND from stale-version dirs, without flagging a run dir that has no verdict.json at all", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-unreadable-scan-"));
      await writeTrial(tmp, "scn", "ses_ok", {});
      const staleDir = join(tmp, "scn", "ses_v1");
      await mkdir(staleDir, { recursive: true });
      await writeFile(join(staleDir, "verdict.json"), JSON.stringify(v1OnDiskArtifact("ses_v1")), "utf8");
      const truncatedDir = join(tmp, "scn", "ses_truncated");
      await mkdir(truncatedDir, { recursive: true });
      await writeFile(join(truncatedDir, "verdict.json"), '{"version": 2, "source":', "utf8");
      const badStateDir = join(tmp, "scn", "ses_badstate");
      await mkdir(badStateDir, { recursive: true });
      await writeFile(
        join(badStateDir, "verdict.json"),
        JSON.stringify(verdict({ session_id: "ses_badstate", state: "bogus" as never })),
        "utf8",
      );
      const notArtifactDir = join(tmp, "scn", "ses_notartifact");
      await mkdir(notArtifactDir, { recursive: true });
      await writeFile(join(notArtifactDir, "verdict.json"), JSON.stringify({ hello: "world" }), "utf8");
      // A run dir that never got a verdict.json at all (e.g. an in-progress
      // or crashed run) is neither stale nor unreadable — it is simply not
      // finalized yet, and must stay silently skipped as before.
      await mkdir(join(tmp, "scn", "ses_never_finalized"), { recursive: true });

      const { trials, staleVersionDirs, unreadableDirs } = await scanVerdictArtifactsDetailed(tmp);
      expect(trials.map((t) => t.verdict.session_id)).toEqual(["ses_ok"]);
      expect(staleVersionDirs).toEqual([staleDir]);
      // Asserted in SORTED order, not "sort both sides and compare": the
      // scan sorts on purpose so the trimmed path list fix-prompt prints is
      // the same on APFS (readdir hands back names sorted) and ext4 (hash
      // order). Sorting the actual before comparing would hide a regression
      // there and let the display test flake on Linux only.
      expect(unreadableDirs).toEqual([badStateDir, notArtifactDir, truncatedDir]);
      expect(unreadableDirs).toEqual([...unreadableDirs].sort());
    });

    // the own lesson, replayed for `unreadable`: the count must survive to the caller
    // even when a real, readable run set exists beside it — a "only report it.
    it("discoverRunSet(root) reports unreadableCount and names the path even when another run set parsed fine", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-unreadable-mixed-"));
      await writeTrial(tmp, "scn", "ses_fail", {
        group_id: "grp_mixed",
        passed: false,
        state: "fail",
      });
      const corruptDir = join(tmp, "scn", "ses_badstate");
      await mkdir(corruptDir, { recursive: true });
      await writeFile(
        join(corruptDir, "verdict.json"),
        JSON.stringify(verdict({ session_id: "ses_badstate", state: "bogus" as never })),
        "utf8",
      );

      const discovery = await discoverRunSet(tmp);
      expect(discovery.totalSets).toBe(1);
      expect(discovery.set?.trials.map((t) => t.verdict.session_id)).toEqual(["ses_fail"]);
      expect(discovery.unreadableCount).toBe(1);
      expect(discovery.unreadablePaths).toEqual([corruptDir]);
      // Never folded into the stale-version count — different fact.
      expect(discovery.staleVersionCount).toBe(0);
    });

    it("discoverRunSet(root) with ONLY a corrupt file reports unreadableCount, distinct from an empty runs/ and from stale-version", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-unreadable-only-"));
      const corruptDir = join(tmp, "scn", "ses_truncated");
      await mkdir(corruptDir, { recursive: true });
      await writeFile(join(corruptDir, "verdict.json"), '{"version": 2, "source":', "utf8");

      const discovery = await discoverRunSet(tmp);
      expect(discovery.kind).toBe("root");
      expect(discovery.totalSets).toBe(0);
      expect(discovery.set).toBeNull();
      expect(discovery.unreadableCount).toBe(1);
      expect(discovery.unreadablePaths).toEqual([corruptDir]);
      expect(discovery.staleVersionCount).toBe(0);

      // A truly empty runs/ still reports unreadableCount: 0 — "nothing here"
      // and "something here is damaged" stay distinguishable.
      const empty = await mkdtemp(join(tmpdir(), "verdict-unreadable-empty-"));
      const emptyDiscovery = await discoverRunSet(empty);
      expect(emptyDiscovery.totalSets).toBe(0);
      expect(emptyDiscovery.unreadableCount).toBe(0);
    });

    it("discoverRunSet(trial dir) pointed straight at a corrupt verdict.json names the skip as unreadable", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-unreadable-trialdir-"));
      const corruptDir = join(tmp, "scn", "ses_badstate");
      await mkdir(corruptDir, { recursive: true });
      await writeFile(
        join(corruptDir, "verdict.json"),
        JSON.stringify(verdict({ session_id: "ses_badstate", state: "bogus" as never })),
        "utf8",
      );

      const discovery = await discoverRunSet(corruptDir);
      expect(discovery.kind).toBe("trial-dir");
      expect(discovery.set).toBeNull();
      expect(discovery.totalSets).toBe(0);
      expect(discovery.unreadableCount).toBe(1);
      expect(discovery.unreadablePaths).toEqual([corruptDir]);
      expect(discovery.staleVersionCount).toBe(0);
    });
  });

  // The counts above are only honest about DAMAGE if a file that is merely mid-write
  // can never reach them.
  describe("verdict.json is published by rename, so a concurrent scan never sees a prefix", () => {
    /** Big enough that the write is a measurable interval rather than an instant: ~4
     *  MB of JSON. */
    function largeVerdict(sid: string): VerdictArtifact {
      return verdict({
        session_id: sid,
        criteria_results: Array.from({ length: 3000 }, (_, i) => ({
          criterion: { type: "model" as const, text: `criterion ${i} ${"c".repeat(320)}` },
          passed: true,
          skipped: false,
          reason: `reason ${i} ${"r".repeat(320)}`,
        })),
      });
    }

    it("a scan running throughout a large write never reports an unreadable count", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-atomic-scan-"));
      const runDir = join(tmp, "scn", "ses_hot");
      await mkdir(runDir, { recursive: true });
      const artifact = largeVerdict("ses_hot");
      // Seed one COMPLETE artifact first: the claim is that a reader sees
      // either the previous artifact or the new one, which needs a previous
      // one to exist.
      await writeVerdictArtifact(runDir, artifact);

      let writing = true;
      const writer = (async () => {
        try {
          for (let i = 0; i < 20; i += 1) {
            await writeVerdictArtifact(runDir, artifact);
          }
        } finally {
          writing = false;
        }
      })();
      const scans: { unreadable: number; sets: number }[] = [];
      const scanner = async () => {
        while (writing) {
          const d = await discoverRunSet(tmp);
          scans.push({ unreadable: d.unreadableCount, sets: d.totalSets });
        }
      };
      await Promise.all([writer, scanner(), scanner()]);

      // Sampling proof: an assertion over zero observations is not evidence.
      expect(scans.length).toBeGreaterThan(10);
      // The ticket's claim, both halves: no scan accused the run of damage, and every
      // scan still found the one complete run set — "silently saw nothing" would.
      expect(scans.filter((s) => s.unreadable > 0)).toEqual([]);
      expect(scans.filter((s) => s.sets !== 1)).toEqual([]);
    }, 60_000);

    it("republishing swaps the directory entry (new inode) instead of truncating in place", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-atomic-inode-"));
      const runDir = join(tmp, "scn", "ses_swap");
      await mkdir(runDir, { recursive: true });

      await writeVerdictArtifact(runDir, verdict({ session_id: "ses_swap" }));
      const first = await stat(join(runDir, "verdict.json"));
      await writeVerdictArtifact(runDir, verdict({ session_id: "ses_swap", score: 40 }));
      const second = await stat(join(runDir, "verdict.json"));

      // The deterministic half of the claim above, which the concurrency test
      // can only sample: `writeFile` reuses the inode (it opens the SAME file
      // with O_TRUNC), a rename replaces the directory entry with a different
      // one. A same-inode second write is an in-place rewrite, i.e. a window.
      expect(second.ino).not.toBe(first.ino);
      // And the content is the new artifact, not a stale one left behind.
      const onDisk = JSON.parse(await readFile(join(runDir, "verdict.json"), "utf8")) as {
        score: number;
      };
      expect(onDisk.score).toBe(40);
    });

    it("leaves no temp file behind in the run dir", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-atomic-tidy-"));
      const runDir = join(tmp, "scn", "ses_tidy");
      await mkdir(runDir, { recursive: true });
      await writeVerdictArtifact(runDir, verdict({ session_id: "ses_tidy" }));
      await writeVerdictArtifact(runDir, verdict({ session_id: "ses_tidy" }));
      // The temp file is a SIBLING (same directory ⇒ same filesystem ⇒ the
      // rename is atomic), so tidiness is this module's problem: a leftover
      // `.verdict.json.*.tmp` in every run dir would be a visible mess in the
      // user's runs/ even though no reader looks at it.
      expect(await readdir(runDir)).toEqual(["verdict.json"]);
    });
  });

  // `readVerdictArtifactDetailed` names the absence itself, so no call site has
  // to re-`existsSync` the path to tell "not there" from "there and broken".
  describe("an absent verdict.json is `missing`, not `unreadable`", () => {
    it("names the absence directly, for a run dir with no verdict.json and for a dir that isn't there", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "verdict-missing-"));
      const empty = join(tmp, "scn", "ses_never_finalized");
      await mkdir(empty, { recursive: true });

      expect(await readVerdictArtifactDetailed(empty)).toEqual({ status: "missing" });
      expect(await readVerdictArtifactDetailed(join(tmp, "scn", "nope"))).toEqual({
        status: "missing",
      });
      // The collapsing reader still collapses: callers that only want usable
      // trials are unaffected.
      expect(await readVerdictArtifact(empty)).toBeNull();
    });

    it("every path that does not RESOLVE is `missing`, so the scan's junk-skipping is unchanged", async () => {
      // The `existsSync` guard this status replaces answered `false` for more
      // than ENOENT, and each of those is a count that would otherwise move.
      // ENOTDIR is the one that reaches a real user: the scan walks every
      // entry under a task slug as a run dir, so `<root>/<slug>/loose.txt`
      // gets read as `<...>/loose.txt/verdict.json`. Keying `missing` on
      // ENOENT alone would newly count every stray file under a task slug as
      // a damaged artifact. ELOOP and ENAMETOOLONG are the same fact for a
      // path a user typed at `pome fix-prompt`.
      const tmp = await mkdtemp(join(tmpdir(), "verdict-missing-notdir-"));
      await writeTrial(tmp, "scn", "ses_ok", {});
      const loose = join(tmp, "scn", "loose.txt");
      await writeFile(loose, "not a run dir", "utf8");
      const loop = join(tmp, "scn", "loop");
      await symlink(loop, loop); // self-referential → ELOOP on resolve
      const tooLong = join(tmp, "scn", "n".repeat(5000)); // → ENAMETOOLONG

      expect(await readVerdictArtifactDetailed(loose)).toEqual({ status: "missing" });
      expect(await readVerdictArtifactDetailed(loop)).toEqual({ status: "missing" });
      expect(await readVerdictArtifactDetailed(tooLong)).toEqual({ status: "missing" });

      const { trials, unreadableDirs } = await scanVerdictArtifactsDetailed(tmp);
      expect(trials.map((t) => t.verdict.session_id)).toEqual(["ses_ok"]);
      expect(unreadableDirs).toEqual([]);
      const discovery = await discoverRunSet(tmp);
      expect(discovery.totalSets).toBe(1);
      expect(discovery.unreadableCount).toBe(0);
    });

    it("a fix-prompt target with no verdict.json still falls through to the artifacts-root read", async () => {
      // `discoverRunSet` distinguishes "you pointed me at a damaged trial"
      // from "you pointed me at a root" — with `missing` that is a status
      // check rather than a second stat of the same path.
      const tmp = await mkdtemp(join(tmpdir(), "verdict-missing-root-"));
      await writeTrial(tmp, "scn", "ses_fail", { passed: false, state: "fail" });

      const discovery = await discoverRunSet(tmp);
      expect(discovery.kind).toBe("root");
      expect(discovery.totalSets).toBe(1);
      expect(discovery.unreadableCount).toBe(0);
      expect(discovery.set?.trials.map((t) => t.verdict.session_id)).toEqual(["ses_fail"]);

      // A root that does not exist at all is still an empty root, not a
      // trial dir.
      const gone = await discoverRunSet(join(tmp, "not-here"));
      expect(gone.kind).toBe("root");
      expect(gone.totalSets).toBe(0);
      expect(gone.unreadableCount).toBe(0);
    });
  });
});
