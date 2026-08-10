// SPDX-License-Identifier: Apache-2.0
// FDRS-644 — the per-trial cloud verdict artifact (verdict.json): write/read
// roundtrip, the two-level scan, run-set grouping, latest-FAILED selection,
// and the fix-prompt discovery semantics (trial dir → its set regardless of
// outcome; root → latest failed set). Foreign/corrupt files never throw.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERDICT_ARTIFACT_VERSION,
  discoverRunSet,
  groupRunSets,
  latestFailedRunSet,
  loadTrialEvents,
  readVerdictArtifact,
  readVerdictArtifactDetailed,
  scanVerdictArtifacts,
  scanVerdictArtifactsDetailed,
  writeVerdictArtifact,
  type VerdictArtifact,
} from "../../../src/hosted/evalResultCache.js";

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

  it("writes `task_path` and still reads pre-F-933 `scenario_path` trials (normalized)", async () => {
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

    // Read path: a run dir written by cli <= 0.8.x still resolves, and the
    // legacy key is surfaced to callers as `task_path`.
    const legacyDir = join(tmp, "scn", "ses_old");
    await mkdir(legacyDir, { recursive: true });
    const { task_path: _tp, ...withoutTaskPath } = verdict({ session_id: "ses_old" });
    await writeFile(
      join(legacyDir, "verdict.json"),
      JSON.stringify({ ...withoutTaskPath, scenario_path: "scenarios/scn.md" }),
      "utf8",
    );
    const legacy = await readVerdictArtifact(legacyDir);
    expect(legacy?.verdict.task_path).toBe("scenarios/scn.md");
    expect(groupRunSets([legacy!])[0]!.taskPath).toBe("scenarios/scn.md");

    // Neither spelling present → still foreign.
    const neither = join(tmp, "scn", "ses_none");
    await mkdir(neither, { recursive: true });
    await writeFile(join(neither, "verdict.json"), JSON.stringify(withoutTaskPath), "utf8");
    expect(await readVerdictArtifact(neither)).toBeNull();
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
      // group B: older, one failed
      { runDir: "b1", verdict: verdict({ group_id: "grp_b", session_id: "b1", finalized_at: "2026-07-06T01:00:00Z" }) },
      { runDir: "b2", verdict: verdict({ group_id: "grp_b", session_id: "b2", passed: false, score: 40, finalized_at: "2026-07-06T01:01:00Z" }) },
      // solo run, failed, oldest
      { runDir: "s1", verdict: verdict({ session_id: "s1", passed: false, finalized_at: "2026-07-06T00:00:00Z" }) },
    ];
    const sets = groupRunSets(trials);
    expect(sets).toHaveLength(3);
    // Sorted by latest finalize ascending; trials inside sorted ascending.
    expect(sets.map((s) => s.groupId)).toEqual([null, "grp_b", "grp_a"]);
    expect(sets[2]!.anyFailed).toBe(false);
    expect(sets[1]!.anyFailed).toBe(true);
    expect(sets[1]!.trials.map((t) => t.verdict.session_id)).toEqual(["b1", "b2"]);

    // Latest FAILED ≠ latest overall: grp_a is newest but green.
    expect(latestFailedRunSet(sets)?.groupId).toBe("grp_b");
  });

  // F-1392 — `anyFailed` reads `!t.verdict.passed`, so a group holding a
  // trial whose only non-passing criterion was pre-satisfied must NOT trip
  // `anyFailed`, or it gets misrouted to `pome fix-prompt` as an agent
  // defect. This is resolved upstream in `scoreFromFinalizeResponse` (the
  // trial's `passed` is written correctly at verdict.json write time); this
  // test pins the group-level behavior against the artifact directly rather
  // than re-deriving it.
  it("a group holding a pre-satisfied-only trial (passed: true) is NOT anyFailed", async () => {
    const trials = [
      {
        runDir: "p1",
        verdict: verdict({
          group_id: "grp_p",
          session_id: "p1",
          passed: true,
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
    expect(sets[0]!.anyFailed).toBe(false);
  });

  it("discoverRunSet(root): latest failed set; all-green roots return set=null with totalSets>0", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-root-"));
    await writeTrial(tmp, "scn", "g1", { group_id: "grp_g", finalized_at: "2026-07-06T05:00:00Z" });
    await writeTrial(tmp, "scn", "f1", { group_id: "grp_f", passed: false, score: 0, finalized_at: "2026-07-06T04:00:00Z" });

    const d = await discoverRunSet(tmp);
    expect(d.kind).toBe("root");
    expect(d.totalSets).toBe(2);
    expect(d.set?.groupId).toBe("grp_f");

    const green = await mkdtemp(join(tmpdir(), "verdict-green-"));
    await writeTrial(green, "scn", "g2", { group_id: "grp_h" });
    const dg = await discoverRunSet(green);
    expect(dg.totalSets).toBe(1);
    expect(dg.set).toBeNull();

    const empty = await mkdtemp(join(tmpdir(), "verdict-empty-"));
    const de = await discoverRunSet(empty);
    expect(de.totalSets).toBe(0);
    expect(de.set).toBeNull();

    const missing = await discoverRunSet(join(empty, "nope"));
    expect(missing.totalSets).toBe(0);
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

  it("loadTrialEvents skips corrupt rows and tolerates a missing file", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-events-"));
    await writeFile(
      join(tmp, "events.jsonl"),
      '{"kind":"twin_http","path":"/a"}\nnot json\n\n{"kind":"twin_http","path":"/b"}\n',
      "utf8",
    );
    const events = await loadTrialEvents(tmp);
    expect(events).toHaveLength(2);
    expect(await loadTrialEvents(join(tmp, "missing"))).toEqual([]);
  });

  it("loadTrialEvents drops valid-JSON non-object rows (null, numbers, strings)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "verdict-events2-"));
    await writeFile(
      join(tmp, "events.jsonl"),
      'null\n3\n"x"\n{"kind":"twin_http","path":"/a"}\n',
      "utf8",
    );
    const events = await loadTrialEvents(tmp);
    expect(events).toHaveLength(1);
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
