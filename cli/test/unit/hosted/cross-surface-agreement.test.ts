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
// `dashboardRunStatus` below is a TRANSCRIPTION, named clause by clause so a
// reviewer can diff it against the original, and deliberately NOT a
// generalization of it. It is the oracle, not an implementation: nothing in
// `src/` imports it. When pome-cloud changes its predicate, this table is what
// goes red.
//
// F-1399 moved the arithmetic out of `run-status.ts` and into
// `@pome-cloud/contract`'s `isIncompleteTally` (`packages/contract/src/
// run-completeness.ts`), the shared predicate the dashboard and the control
// plane's markdown report both now call instead of keeping their own copies —
// closing the exact defect class this file exists to catch, one repo over.
// This transcription still cannot import that package (ADR-002: no cloud
// imports in OSS), so it stays a transcription; see the note at the bottom of
// this file on what a real fix would take.
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

// ── The oracle: pome-cloud's answer, transcribed ────────────────────────────
//
// @pome-cloud/contract's packages/contract/src/run-completeness.ts:
//   isIncompleteTally (107-109) — three clauses, in order:
//     1. `total === 0` ⇒ false, never incomplete (no criteria recorded is a
//        different fact from "recorded and none could be evaluated").
//     2. `notEvaluated - preSatisfied > 0` ⇒ incomplete (F-925, narrowed by
//        F-1296's seed-exclusion exemption).
//     3. `evaluated === 0` ⇒ incomplete (F-1399). Fires for exactly the shape
//        clause 2 does not already catch: every criterion excluded as already
//        true in the seed. That run has an empty denominator and used to fall
//        through to `satisfaction_score === 100 ? pass : fail` and land on
//        `fail` — a verdict about the agent for a run nothing was ever at
//        risk in.
//
// apps/dashboard/src/lib/run-status.ts:
//   deriveCriteriaCounts (73-93)   — skipped ⇒ notEvaluated, +preSatisfied
//                                    when the reason matches; else evaluated
//                                    (+passed)
//   isRunIncomplete      (110-114) — isIncompleteTally(deriveCriteriaCounts(results))
//   deriveRunStatus      (127-133) — incomplete first, then
//                                    satisfaction_score === 100 ? pass : fail
//
// The satisfaction score the dashboard reads is the run row's, which the
// control plane computes in `score-merge.ts:314-315` as
// `evaluated === 0 ? 0 : round(passed / evaluated * 100)` — the same number
// /finalize returns to the CLI, so one `satisfaction` input drives both sides
// of every row below.
type DashboardStatus = "pass" | "fail" | "incomplete";

function dashboardRunStatus(
  results: readonly CriterionResult[],
  satisfactionScore: number,
): DashboardStatus {
  let notEvaluated = 0;
  let preSatisfied = 0;
  for (const r of results) {
    if (!r.skipped) continue;
    notEvaluated += 1;
    if (r.reason === PRE_SATISFIED_REASON) preSatisfied += 1;
  }
  const total = results.length;
  const evaluated = total - notEvaluated;
  if (total > 0 && (notEvaluated - preSatisfied > 0 || evaluated === 0)) return "incomplete";
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
      const row = table.find(
        (r) => r.name === "every criterion seed-excluded — no denominator",
      )!;
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

// ── F-1413: why this stays a transcription, and what would stop it drifting
// again ───────────────────────────────────────────────────────────────────
//
// F-1413 is the second time this table has gone stale-green: pome-cloud
// changed the predicate under it and nothing here noticed until a human read
// both repos side by side. That is the parallel-copy defect this repo is
// otherwise trying to close (D3) — one level up, across a repo boundary
// instead of within one file.
//
// This repo cannot import `@pome-cloud/contract` to fix that at the root.
// Two independent reasons, not one:
//   1. Policy — `scripts/lint-no-cloud-imports.sh` denies every `pome-cloud/*`
//      import (bare or scoped) anywhere under `packages/`, `cli/src/`,
//      `cli/scripts/`, `scripts/`; this file lives under `cli/test/`, which
//      the gate does not cover, but the module it would need to import does
//      not reach here regardless of the gate — see (2).
//   2. Reachability — `@pome-cloud/contract` is a `private` workspace member
//      of pome-cloud, published to no registry. `@pome-sh/wire` is the one
//      package this repo publishes FOR pome-cloud to consume (GitHub
//      Packages, F-949); nothing runs the other direction today.
//
// A REAL fix exists but is a cross-repo migration, not a one-file patch:
// extract `isIncompleteTally` + `PRE_SATISFIED_REASON` out of pome-cloud's
// private `packages/contract` and into the already-published `@pome-sh/wire`
// (or a new sibling package built the same way), with the dashboard, the
// control plane, and the markdown report importing it from there instead of
// owning the source — the same collapse F-1399 just did for `run-status.ts`
// and `run-report.ts`, one repo boundary further out. That needs a pome-cloud
// PR to consume the published package, a `@pome-sh/wire` version bump here,
// and this file's `dashboardRunStatus`/`cliRunStatus` comparison rewritten
// against ONE real predicate instead of an oracle transcription — at which
// point a table like this one still has value (agreement is still worth
// pinning row by row) but the copy of the ARITHMETIC disappears, and with it
// the only thing that can go stale.
//
// Short of that, there is no self-detecting middle ground available from
// inside this repo's CI: a job that diffs this transcription against
// pome-cloud's source would need read access to a private repo, which is
// exactly the credential the public repo's "zero embedded cloud config"
// guardrail (AGENTS.md, Public Repo Guardrails) exists to keep out of here.
// A pinned commit SHA plus a maintainer-run (non-CI) diff script is possible
// and would be strictly better than today — it turns "silently stale" into
// "stale unless someone runs the check" — but it is still not automatic, and
// building it is out of scope for this ticket. Filing the `@pome-sh/wire`
// extraction as its own ticket is the concrete next step if this drift is
// worth spending more than a comment on.
