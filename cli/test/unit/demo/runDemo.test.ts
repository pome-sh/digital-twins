// SPDX-License-Identifier: Apache-2.0
// `pome demo` orchestration: group threading, per-trial verdicts from the cloud
// evaluation, errored exclusion, at-capacity abort.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDemo, type DemoTrialClient } from "../../../src/demo/runDemo.js";
import { DemoCapacityError } from "../../../src/demo/capacity.js";
import { HostedQuotaError } from "../../../src/hosted/errors.js";
import type { DemoSession } from "../../../src/demo/mint.js";
import type { runTask } from "../../../src/runner/runTask.js";
import type { FinalizeResponse } from "../../../src/types/shared.js";

type RunTaskFn = typeof runTask;
type RunTaskResult = Awaited<ReturnType<RunTaskFn>>;
type RunTaskOpts = Parameters<RunTaskFn>[0];

function sessionsFixture(count: number): DemoSession[] {
  return Array.from({ length: count }, (_, i) => ({
    session_id: `ses_${i + 1}`,
    demo_token: `jwt.tok${i + 1}.sig`,
    expires_at: "2026-07-05T12:15:00.000Z",
  }));
}

async function artifactsDirWithBlobs(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-demo-run-"));
  await writeFile(
    join(dir, "events.jsonl"),
    `${JSON.stringify({ kind: "TwinHttpEvent", event_id: "e1" })}\n`,
  );
  await writeFile(join(dir, "state_initial.json"), "{}\n");
  await writeFile(join(dir, "state_final.json"), "{}\n");
  await writeFile(join(dir, "meta.json"), "{}\n");
  return dir;
}

function fakeRunTask(
  perTrial: Array<{ exitCode: number; stderr?: string; timedOut?: boolean }>,
  seenOptions: RunTaskOpts[],
): RunTaskFn {
  let call = 0;
  return (async (options: RunTaskOpts) => {
    seenOptions.push(options);
    const spec = perTrial[Math.min(call, perTrial.length - 1)]!;
    call += 1;
    const runDir = await artifactsDirWithBlobs();
    return {
      scenario: { slug: "first-run-demo" },
      runId: `run_${call}`,
      artifacts: { runId: `run_${call}`, runDir },
      agent: {
        stdout: "",
        stderr: spec.stderr ?? "",
        exitCode: spec.exitCode === 0 ? 0 : 1,
        timedOut: spec.timedOut ?? false,
      },
      exitCode: spec.exitCode,
      blockedEgress: [],
    } as unknown as RunTaskResult;
  }) as RunTaskFn;
}

function passedResult(): FinalizeResponse["criteria_results"] {
  return [
    criterion("The bug label was applied to the 500-error issue.", "passed"),
    criterion(
      "Exactly one comment was left on that issue, and it names the failing endpoint (POST /orders).",
      "passed",
    ),
  ];
}

function failedResult(): FinalizeResponse["criteria_results"] {
  return [
    criterion("The bug label was applied to the 500-error issue.", "passed"),
    criterion(
      "Exactly one comment was left on that issue, and it names the failing endpoint (POST /orders).",
      "failed",
    ),
  ];
}

// The wire shape prod actually returns for the packaged demo task, measured on
// 2026-08-29 by replaying a captured trial's own blobs through mint → upload →
// finalize (evaluator f1643-narrator-abstain.1): two `[code]` rows carry the
// score, three `[model]` rows ride beside it as the narrator's readings. Every
// one of those five is `passed`/`skipped` only — `outcome` is never on the
// wire, which is why the CLI reads `score_state`.
function mixedResult(): FinalizeResponse["criteria_results"] {
  return [
    {
      criterion: {
        type: "code" as const,
        text: "Issue #1 in `acme/api` has exactly one classification label, and it is `bug`",
      },
      passed: true,
      skipped: false,
      reason: 'issue #1 has exactly one label ("bug")',
    },
    {
      criterion: {
        type: "code" as const,
        text: 'A comment containing "POST /orders" exists on issue #1 in `acme/api`',
      },
      passed: true,
      skipped: false,
      reason: 'issue #1 has a comment containing "POST /orders"',
    },
    advisoryRow(
      "The existing `bug` label was applied to the issue reporting the 500 error on POST /orders, and to no other issue.",
    ),
    advisoryRow(
      "Exactly one comment was left on that issue, and it names the failing endpoint (POST /orders).",
    ),
    advisoryRow("No other issue was modified and no new label was created."),
  ];
}

function advisoryRow(text: string) {
  return {
    criterion: { type: "model" as const, text },
    passed: false,
    skipped: true,
    // The narrator's own numbered walk through the trace. Long on purpose:
    // the terminal must not print it.
    reason:
      "1. The scenario requires applying the 'bug' label. 2. The trace shows a POST to /repos/acme/api/issues/1/labels. 3. Therefore the label was applied correctly.",
    score_state: "advisory",
  };
}

function criterion(text: string, outcome: "passed" | "failed") {
  return {
    criterion: { type: "model" as const, text },
    passed: outcome === "passed",
    skipped: false,
    reason: outcome === "passed" ? "ok" : "not satisfied",
    confidence: outcome === "passed" ? 0.95 : 0.1,
    judge_model: "test-judge",
  };
}

function fakeClient(
  finalizeFor: (sessionId: string) => FinalizeResponse | Error,
  finalizeCalls: Array<{ sessionId: string; input: unknown }>,
  abandonCalls: Array<{ sessionId: string; errorCode?: string }> = [],
  abandonError?: Error,
): (session: DemoSession) => DemoTrialClient {
  return (session) => ({
    requestEventsUploadUrl: vi.fn(async (sessionId: string) => {
      throw new Error(`no blob store in this test (${sessionId})`);
    }),
    requestStateUploadUrl: vi.fn(async (sessionId: string) => {
      throw new Error(`no blob store in this test (${sessionId})`);
    }),
    requestSignalsUploadUrl: vi.fn(async (sessionId: string) => {
      throw new Error(`no blob store in this test (${sessionId})`);
    }),
    requestMetaUploadUrl: vi.fn(async (sessionId: string) => {
      throw new Error(`no blob store in this test (${sessionId})`);
    }),
    finalize: vi.fn(async (sessionId: string, input: unknown) => {
      finalizeCalls.push({ sessionId, input });
      const out = finalizeFor(session.session_id);
      if (out instanceof Error) throw out;
      return out;
    }),
    abandonSession: vi.fn(
      async (sessionId: string, input?: { errorCode?: string }) => {
        abandonCalls.push({ sessionId, errorCode: input?.errorCode });
        if (abandonError) throw abandonError;
        return {
          session_id: sessionId,
          state: "failed",
          error_code: input?.errorCode ?? null,
          abandoned: true,
        };
      },
    ),
  });
}

function finalizeResponse(
  score: number,
  results: FinalizeResponse["criteria_results"],
): FinalizeResponse {
  return {
    run_id: "run_x",
    score,
    judge_model: "google/gemini-3.1-flash-lite",
    dashboard_url: "https://app.pome.sh/runs/run_x",
    criteria_results: results,
  };
}

describe("runDemo", () => {
  it("threads one grp_ id through every mint, runs k trials, renders verdict words + preview link", async () => {
    const out: string[] = [];
    const seenOptions: RunTaskOpts[] = [];
    const finalizeCalls: Array<{ sessionId: string; input: unknown }> = [];
    const mintFn = vi.fn(async (opts: { groupId: string; count: number }) =>
      sessionsFixture(opts.count),
    );

    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 5,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask(
        [
          { exitCode: 0 },
          { exitCode: 0 },
          { exitCode: 0 },
          { exitCode: 0 },
          { exitCode: 3, timedOut: true },
        ],
        seenOptions,
      ),
      mintFn: mintFn as never,
      trialClientFactory: fakeClient((sessionId) => {
        if (sessionId === "ses_1" || sessionId === "ses_2") {
          return finalizeResponse(100, passedResult());
        }
        return finalizeResponse(50, failedResult());
      }, finalizeCalls),
      skipTwinWarmup: true,
    });

    // Group threading: one grp_ id, shared by all 5 mints (single call, count 5).
    expect(mintFn).toHaveBeenCalledOnce();
    const mintArgs = mintFn.mock.calls[0]![0] as {
      groupId: string;
      count: number;
      taskName: string;
      apiBase: string;
    };
    expect(mintArgs.groupId).toMatch(/^grp_[\w-]{21}$/);
    expect(mintArgs.count).toBe(5);
    expect(mintArgs.taskName).toBe("first-run-demo");
    expect(result.groupId).toBe(mintArgs.groupId);

    // Each trial got ITS session's gateway coordinates + the egress valve.
    expect(seenOptions).toHaveLength(5);
    seenOptions.forEach((options, i) => {
      expect(options.taskPath.endsWith("first-run-demo.md")).toBe(true);
      expect(options.extraAgentEnv).toMatchObject({
        POME_DEMO_LLM_URL: `https://api.example.com/v1/demo/sessions/ses_${i + 1}/llm`,
        POME_DEMO_TOKEN: `jwt.tok${i + 1}.sig`,
        POME_DEMO_TASK_NAME: "first-run-demo",
        POME_DEMO_REPO: "acme/api",
      });
      expect(options.egressExtraHosts).toEqual(["api.example.com"]);
    });

    // Finalize went to the 4 evaluated sessions with the demo contract:
    // criteria [] + scenario_name selects the server-owned task.
    expect(finalizeCalls.map((c) => c.sessionId)).toEqual([
      "ses_1",
      "ses_2",
      "ses_3",
      "ses_4",
    ]);
    for (const call of finalizeCalls) {
      expect(call.input).toMatchObject({
        criteria: [],
        taskName: "first-run-demo",
        stopReason: "completed",
      });
    }

    const text = out.join("\n");
    expect(text).toContain("No signup. No API keys.");
    expect(text).toContain("running 5 isolated trials of first-run-demo …");
    expect(text).toMatch(/trial 1 {2}✓ {2}passed {3}\d+\.\ds/);
    expect(text).toMatch(/trial 3 {2}✗ {2}failed {3}\d+\.\ds {2}1 of 2 checks {2}exactly one comment/);
    expect(text).toContain("trial 5  ⚠  errored         trial timed out — excluded");
    expect(text).toContain(
      "2 of 4 passed · 1 trial errored on trial timed out, excluded from the fraction",
    );
    expect(text).toMatch(/exactly one comment .* in 2 of 4 — start there/);
    expect(text).toContain(`→ https://app.pome.sh/demo/${result.groupId}`);
    // Verdicts are words, never scores.
    expect(text).not.toMatch(/\d+\/100/);
    expect(result.exitCode).toBe(0);
  });

  it("renders an honest labeled state and exits 4 when the mint is at capacity", async () => {
    const out: string[] = [];
    const runTaskFn = vi.fn();
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 5,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runTaskFn: runTaskFn as never,
      mintFn: (async () => {
        throw new DemoCapacityError(
          "demo_ip_mint_cap",
          "Daily demo limit reached for this network.",
        );
      }) as never,
      trialClientFactory: fakeClient(() => new Error("unreachable"), []),
      skipTwinWarmup: true,
    });

    expect(result.exitCode).toBe(4);
    expect(runTaskFn).not.toHaveBeenCalled();
    const text = out.join("\n");
    expect(text).toContain("limit for this network — try again tomorrow");
    expect(text).not.toMatch(/at Object|\.ts:\d+/); // no stack traces
  });

  it("stops launching trials when finalize hits the daily judge cap, keeping earlier verdicts", async () => {
    const out: string[] = [];
    const seenOptions: RunTaskOpts[] = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 5,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask([{ exitCode: 0 }], seenOptions),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient((sessionId) => {
        if (sessionId === "ses_1") return finalizeResponse(100, passedResult());
        return new HostedQuotaError(
          "Daily managed-judge spend cap reached for this team.",
          "req_1",
          { kind: "daily_judge_cap", spent_cents: 500, cap_cents: 500 },
        );
      }, []),
      skipTwinWarmup: true,
    });

    // Trial 1 passed, trial 2 hit the cap → no trial 3-5.
    expect(seenOptions).toHaveLength(2);
    expect(result.verdicts).toHaveLength(2);
    expect(result.verdicts[0]).toMatchObject({ kind: "passed" });
    expect(result.verdicts[1]).toMatchObject({ kind: "errored" });
    const text = out.join("\n");
    expect(text).toContain("evaluation budget is exhausted — try again tomorrow");
    expect(text).toContain("1 of 1 passed");
    expect(result.exitCode).toBe(0);
  });

  it("treats an agent capacity marker (gateway 402 mid-trial) as a demo-wide honest stop", async () => {
    const out: string[] = [];
    const seenOptions: RunTaskOpts[] = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 5,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask(
        [
          {
            exitCode: 3,
            stderr: "POME_DEMO_CAPACITY:daily_model_cap\nbudget exhausted\n",
          },
        ],
        seenOptions,
      ),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient(() => new Error("unreachable"), []),
      skipTwinWarmup: true,
    });

    expect(seenOptions).toHaveLength(1);
    expect(result.exitCode).toBe(4);
    const text = out.join("\n");
    expect(text).toContain("daily model budget is exhausted — try again tomorrow");
  });

  it("abandons the errored trial AND the never-run remainder when the gateway reports capacity mid-run", async () => {
    const out: string[] = [];
    const abandonCalls: Array<{ sessionId: string; errorCode?: string }> = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 3,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask(
        [
          {
            exitCode: 3,
            stderr: "POME_DEMO_CAPACITY:daily_model_cap\nbudget exhausted\n",
          },
        ],
        [],
      ),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient(() => new Error("unreachable"), [], abandonCalls),
      skipTwinWarmup: true,
    });

    // The erroring trial's slot flips to errored immediately, and the minted
    // sessions the abort orphaned flip too — no 15-min dishonesty window.
    expect(abandonCalls).toEqual([
      { sessionId: "ses_1", errorCode: "daily_model_cap" },
      { sessionId: "ses_2", errorCode: "daily_model_cap" },
      { sessionId: "ses_3", errorCode: "daily_model_cap" },
    ]);
    expect(result.exitCode).toBe(4);
  });

  it("abandons with daily_judge_cap when finalize hits the judge cap; the finalized trial is never abandoned", async () => {
    const abandonCalls: Array<{ sessionId: string; errorCode?: string }> = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 3,
      out: () => undefined,
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask([{ exitCode: 0 }], []),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient(
        (sessionId) => {
          if (sessionId === "ses_1") return finalizeResponse(100, passedResult());
          return new HostedQuotaError("judge cap", "req_1", {
            kind: "daily_judge_cap",
          });
        },
        [],
        abandonCalls,
      ),
      skipTwinWarmup: true,
    });

    expect(abandonCalls).toEqual([
      { sessionId: "ses_2", errorCode: "daily_judge_cap" },
      { sessionId: "ses_3", errorCode: "daily_judge_cap" },
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("abandons a timed-out trial with agent_timeout and a failed agent with agent_exit_nonzero", async () => {
    const abandonCalls: Array<{ sessionId: string; errorCode?: string }> = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 3,
      out: () => undefined,
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask(
        [
          { exitCode: 0 },
          { exitCode: 3, timedOut: true },
          { exitCode: 1, stderr: "boom\n" },
        ],
        [],
      ),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient(
        () => finalizeResponse(100, passedResult()),
        [],
        abandonCalls,
      ),
      skipTwinWarmup: true,
    });

    expect(abandonCalls).toEqual([
      { sessionId: "ses_2", errorCode: "agent_timeout" },
      { sessionId: "ses_3", errorCode: "agent_exit_nonzero" },
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("abandons with trial_crashed when upload/finalize machinery throws a non-capacity error", async () => {
    const abandonCalls: Array<{ sessionId: string; errorCode?: string }> = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 2,
      out: () => undefined,
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask([{ exitCode: 0 }], []),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient(
        (sessionId) =>
          sessionId === "ses_1"
            ? new Error("storage exploded")
            : finalizeResponse(100, passedResult()),
        [],
        abandonCalls,
      ),
      skipTwinWarmup: true,
    });

    // Non-capacity crash abandons that trial only; the demo continues.
    expect(abandonCalls).toEqual([
      { sessionId: "ses_1", errorCode: "trial_crashed" },
    ]);
    expect(result.verdicts).toHaveLength(2);
    expect(result.exitCode).toBe(0);
  });

  it("never abandons a trial whose finalize succeeded, even when the cloud could not evaluate it", async () => {
    const abandonCalls: Array<{ sessionId: string; errorCode?: string }> = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 1,
      out: () => undefined,
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask([{ exitCode: 0 }], []),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      // criteria_results: [] → unevaluated → errored verdict, but the run
      // row exists (finalize 200) — abandon must NOT fire.
      trialClientFactory: fakeClient(
        () => finalizeResponse(0, []),
        [],
        abandonCalls,
      ),
      skipTwinWarmup: true,
    });

    expect(result.verdicts[0]).toMatchObject({ kind: "errored" });
    expect(abandonCalls).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it("never abandons when the crash happens AFTER finalize succeeded", async () => {
    const abandonCalls: Array<{ sessionId: string; errorCode?: string }> = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 1,
      out: () => undefined,
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask([{ exitCode: 0 }], []),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      // Finalize resolves (the run row exists) but the response is corrupt,
      // so verdict synthesis throws afterwards — post-finalize crashes must
      // render an errored trial WITHOUT racing an abandon against the row.
      trialClientFactory: fakeClient(
        () =>
          ({
            ...finalizeResponse(100, passedResult()),
            criteria_results: "corrupt",
          }) as never,
        [],
        abandonCalls,
      ),
      skipTwinWarmup: true,
    });

    expect(result.verdicts[0]).toMatchObject({ kind: "errored" });
    expect(abandonCalls).toEqual([]);
  });

  it("abandon is best-effort: a failing abandon changes neither exit code nor terminal output", async () => {
    const outWithFailingAbandon: string[] = [];
    const outBaseline: string[] = [];
    const runOnce = (
      out: string[],
      abandonError?: Error,
    ): ReturnType<typeof runDemo> =>
      runDemo({
        apiBase: "https://api.example.com",
        dashboardBase: "https://app.pome.sh",
        trials: 2,
        out: (line) => out.push(line),
        agentCommand: "unused-in-test",
        runTaskFn: fakeRunTask(
          [{ exitCode: 0 }, { exitCode: 3, timedOut: true }],
          [],
        ),
        mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
        trialClientFactory: fakeClient(
          () => finalizeResponse(100, passedResult()),
          [],
          [],
          abandonError,
        ),
        skipTwinWarmup: true,
      });

    const failing = await runOnce(
      outWithFailingAbandon,
      new Error("network down"),
    );
    const baseline = await runOnce(outBaseline);

    // The group id and wall-clock durations differ per invocation;
    // everything else must be identical.
    const normalize = (lines: string[]): string[] =>
      lines.map((line) =>
        line.replace(/grp_[\w-]+/g, "grp_X").replace(/\d+\.\ds/g, "Ts"),
      );
    expect(failing.exitCode).toBe(baseline.exitCode);
    expect(normalize(outWithFailingAbandon)).toEqual(normalize(outBaseline));
    expect(outWithFailingAbandon.join("\n")).not.toMatch(/abandon/i);
  });

  it("boots the packaged demo task's twin for the warm-up line (real seed parse)", async () => {
    const out: string[] = [];
    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 1,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask([{ exitCode: 0 }], []),
      mintFn: (async (opts: { count: number }) => sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient(() => finalizeResponse(100, passedResult()), []),
      // REAL warm-up: parses src/demo/first-run-demo.md + its hand-written
      // sidecar and boots the github twin against that seed.
      skipTwinWarmup: false,
    });
    expect(result.exitCode).toBe(0);
    expect(out.join("\n")).toMatch(/spinning up github twin … ready \(\d+\.\ds\)/);
  });
  // F-1754 — the mixed-criteria trial, which is EVERY trial of the packaged
  // demo task since 0.35.1 gave it a `[code]` denominator. The arithmetic half
  // already stopped calling this run unevaluable; the terminal printed a bare
  // verdict word and said nothing about either the fraction or the three rows
  // the demo exists to show.
  it("renders the deterministic fraction and the narrator's readings on a mixed trial", async () => {
    const out: string[] = [];
    const seenOptions: RunTaskOpts[] = [];
    const finalizeCalls: Array<{ sessionId: string; input: unknown }> = [];

    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 1,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask([{ exitCode: 0 }], seenOptions),
      mintFn: (async (opts: { count: number }) =>
        sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient(
        () => finalizeResponse(100, mixedResult()),
        finalizeCalls,
      ),
      skipTwinWarmup: true,
    });

    const text = out.join("\n");
    // The trial passes off the two `[code]` rows, and says so.
    expect(text).toMatch(/trial 1 {2}✓ {2}passed {3}\d+\.\ds {2}2 of 2 checks/);
    expect(result.exitCode).toBe(0);
    expect(result.verdicts[0]!.kind).toBe("passed");

    // Three readings, one line each, beside the fraction.
    const readings = out.filter((line) => line.includes("~ advisory · "));
    expect(readings).toHaveLength(3);
    expect(readings[0]).toContain("the existing `bug` label was applied");
    expect(readings[2]).toContain("no other issue was modified and no new label was created");
    // …under the header that stops `~` reading as a fourth verdict.
    expect(text).toContain("the narrator also read these, and scored none of them:");

    // The narrator's prose stays on the share page. It is an eight-sentence
    // walk through the trace; the front door prints the criterion, not the walk.
    expect(text).not.toContain("The trace shows a POST to");
    // Not a shortfall, not a gap: none of the three verdict words appears on a
    // reading line.
    for (const line of readings) expect(line).not.toMatch(/passed|failed|errored/);
    expect(text).not.toContain("cloud could not evaluate the trace");
  });

  // The negative control the fix is defined against: on `passed`/`skipped`
  // alone this row is identical to the three above, and the whole difference is
  // the absent `score_state`. A grader that never reached a criterion still
  // disqualifies the pass.
  it("still reports a bare skipped row as an unevaluable trial", async () => {
    const out: string[] = [];
    const seenOptions: RunTaskOpts[] = [];
    const finalizeCalls: Array<{ sessionId: string; input: unknown }> = [];

    const result = await runDemo({
      apiBase: "https://api.example.com",
      dashboardBase: "https://app.pome.sh",
      trials: 1,
      out: (line) => out.push(line),
      agentCommand: "unused-in-test",
      runTaskFn: fakeRunTask([{ exitCode: 0 }], seenOptions),
      mintFn: (async (opts: { count: number }) =>
        sessionsFixture(opts.count)) as never,
      trialClientFactory: fakeClient(
        () =>
          finalizeResponse(100, [
            ...(mixedResult() ?? []),
            {
              criterion: { type: "model" as const, text: "The tool call was recorded." },
              passed: false,
              skipped: true,
              reason: "tool_not_recorded",
            },
          ]),
        finalizeCalls,
      ),
      skipTwinWarmup: true,
    });

    const text = out.join("\n");
    expect(text).toContain("trial 1  ⚠  errored         cloud could not evaluate the trace — excluded");
    expect(text).toContain("no trials were evaluated");
    // An errored trial has no fraction and no readings to show.
    expect(text).not.toContain("checks");
    expect(text).not.toContain("~ advisory");
    expect(result.exitCode).toBe(1);
  });
});
