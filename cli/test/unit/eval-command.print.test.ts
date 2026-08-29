// SPDX-License-Identifier: Apache-2.0
// `pome eval` prints the CLOUD verdict (label + score line + dashboard URL) to the
// terminal and writes NO score.json.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_SESSION_ID = "ses_print_test";
const FAKE_RUN_ID = "run_print_test";
const DASHBOARD_URL = `https://dashboard.example.com/runs/${FAKE_RUN_ID}`;

// Hoisted stub so the vi.mock factories (which are hoisted above imports) can
// reference it.
const stub = vi.hoisted(() => {
  return {
    finalizeScore: 100 as number,
    criteriaResults: undefined as unknown[] | undefined,
    client: {
      async createEvalSession(input: { agent: string; taskName: string }) {
        void input;
        return {
          session_id: FAKE_SESSION_ID,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        };
      },
      async requestEventsUploadUrl() {
        return { url: "https://signed.example/events", key: "k/events.jsonl" };
      },
      async requestStateUploadUrl() {
        return {
          state_initial: { url: "https://signed.example/si", key: "k/si.json" },
          state_final: { url: "https://signed.example/sf", key: "k/sf.json" },
        };
      },
      async requestSignalsUploadUrl() {
        return { url: "https://signed.example/sig", key: "k/sig.jsonl" };
      },
      async requestMetaUploadUrl() {
        return { url: "https://signed.example/meta", key: "k/meta.json" };
      },
      async finalize() {
        return {
          run_id: FAKE_RUN_ID,
          score: stub.finalizeScore,
          judge_model: "test-judge",
          dashboard_url: DASHBOARD_URL,
          criteria_results: stub.criteriaResults,
        };
      },
    },
  };
});

vi.mock("../../src/cli/credentials.js", () => ({
  resolveCredentials: vi.fn(async () => ({
    apiBaseUrl: "http://no-cloud.invalid",
    apiKey: "pme_test",
  })),
}));

vi.mock("../../src/hosted/client.js", () => ({
  createHostedClient: () => stub.client,
}));

import { runEvalCommand } from "../../src/cli/eval.js";

const META = {
  run_id: "ses_orig",
  scenario: "01-bug-happy-path",
  title: "Bug happy path",
  started_at: "2026-06-30T10:00:00.000Z",
  completed_at: "2026-06-30T10:00:30.000Z",
  exit_code: 0,
  twins: ["github"],
};

const EVENT_LINE = JSON.stringify({
  kind: "TwinHttpEvent",
  event_id: "req_1",
  parent_id: null,
  ts: "2026-06-30T10:00:02.000Z",
  run_id: "ses_orig",
  twin: "github",
  request_id: "req_1",
  method: "GET",
  path: "/repos/acme/api",
  status: 200,
});

async function writeRunDir(root: string): Promise<string> {
  const runDir = join(root, "runs", "01-bug-happy-path", "ses_orig");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "meta.json"), JSON.stringify(META, null, 2));
  await writeFile(join(runDir, "events.jsonl"), `${EVENT_LINE}\n`);
  await writeFile(join(runDir, "state_initial.json"), '{"repositories": []}\n');
  await writeFile(join(runDir, "state_final.json"), '{"repositories": []}\n');
  return runDir;
}

describe("pome eval terminal output", () => {
  let tmp: string;
  const originalExitCode = process.exitCode;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-eval-print-"));
    stub.finalizeScore = 100;
    stub.criteriaResults = undefined;
    process.exitCode = undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if ((init as RequestInit | undefined)?.method === "PUT") {
        return new Response(null, { status: 200 });
      }
      throw new Error("unexpected non-PUT fetch");
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
    await rm(tmp, { recursive: true, force: true });
  });

  it("prints PASS + cloud score line + dashboard URL, writes no score.json", async () => {
    const runDir = await writeRunDir(tmp);
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await runEvalCommand(runDir, {
      artifactsDir: "runs",
      apiUrl: "http://no-cloud.invalid",
      agent: "triage-bot",
    });

    const out = lines.join("\n");
    expect(out).toMatch(/PASS 01-bug-happy-path/);
    expect(out).toMatch(/score: 100\/100/);
    expect(out).toContain(`cloud: ${DASHBOARD_URL}`);
    // Ephemeral verdict — nothing persisted next to the trace.
    expect(existsSync(join(runDir, "score.json"))).toBe(false);
    // But the idempotency marker IS persisted.
    expect(existsSync(join(runDir, "eval-session.json"))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it("sub-threshold cloud score → FAIL label + exit 1", async () => {
    const runDir = await writeRunDir(tmp);
    stub.finalizeScore = 40;
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await runEvalCommand(runDir, {
      artifactsDir: "runs",
      apiUrl: "http://no-cloud.invalid",
      agent: "triage-bot",
    });

    const out = lines.join("\n");
    expect(out).toMatch(/FAIL 01-bug-happy-path/);
    expect(out).toContain(`cloud: ${DASHBOARD_URL}`);
    expect(existsSync(join(runDir, "score.json"))).toBe(false);
    expect(process.exitCode).toBe(1);
  });
  // F-1754 — the mixed-criteria run: `[code]` rows carry the fraction, the
  // narrator's `[model]` rows ride beside it. The arithmetic already stopped
  // counting them as abstentions; the row list had not.
  it("renders the narrator's rows as narrative beside a passing fraction", async () => {
    const runDir = await writeRunDir(tmp);
    stub.criteriaResults = [
      {
        criterion: { type: "code", text: "Issue #1 has exactly one label, and it is `bug`" },
        passed: true,
        skipped: false,
        reason: 'issue #1 has exactly one label ("bug")',
      },
      {
        criterion: { type: "model", text: "The `bug` label went to the 500-error issue and no other." },
        passed: false,
        skipped: true,
        reason: "the trace shows one POST to /issues/1/labels",
        score_state: "advisory",
      },
      {
        criterion: { type: "model", text: "The refund was explained to the customer." },
        passed: false,
        skipped: true,
        reason: "no refund was requested in this run",
        score_state: "abstained",
      },
    ];
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await runEvalCommand(runDir, {
      artifactsDir: "runs",
      apiUrl: "http://no-cloud.invalid",
      agent: "triage-bot",
    });

    const out = lines.join("\n");
    // One `[code]` row passed and nothing failed, so the run has a denominator
    // and clears it. The three narrator rows do not make it incomplete.
    expect(out).toMatch(/PASS 01-bug-happy-path/);
    expect(out).toMatch(/score: 100\/100/);
    expect(process.exitCode).toBe(0);

    // The narrated rows read as narrative: the narrator's marker, and a clause
    // that says which state and what it means.
    expect(out).toMatch(/~ \[model\] The `bug` label went to the 500-error issue and no other\. — advisory: read by the narrator, never scored/);
    expect(out).toMatch(/~ \[model\] The refund was explained to the customer\. — abstained: nothing in this run to read/);
    // Never the pass/fail markers — a row nobody scored is not a verdict…
    expect(out).not.toMatch(/[✓✗] \[model\]/);
    // …and never the instrument-gap glyph either, which is the claim this
    // whole state exists to stop making about a `[model]` row.
    expect(out).not.toMatch(/- \[model\]/);
    // The scored row keeps its verdict marker.
    expect(out).toMatch(/✓ \[code\] Issue #1 has exactly one label/);
  });

  // The negative control. Identical on `passed`/`skipped` to the two rows
  // above; the whole difference is the absent `score_state`.
  it("keeps a bare skipped row an instrument gap — marker, verdict and all", async () => {
    const runDir = await writeRunDir(tmp);
    stub.criteriaResults = [
      {
        criterion: { type: "code", text: "Issue #1 has exactly one label, and it is `bug`" },
        passed: true,
        skipped: false,
        reason: 'issue #1 has exactly one label ("bug")',
      },
      {
        criterion: { type: "model", text: "The tool call was recorded." },
        passed: false,
        skipped: true,
        reason: "tool_not_recorded",
      },
    ];
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await runEvalCommand(runDir, {
      artifactsDir: "runs",
      apiUrl: "http://no-cloud.invalid",
      agent: "triage-bot",
    });

    const out = lines.join("\n");
    expect(out).toMatch(/INCOMPLETE 01-bug-happy-path/);
    expect(out).toMatch(/1 of 2 criteria not evaluated/);
    expect(out).toMatch(/- \[model\] The tool call was recorded\./);
    expect(out).not.toContain("advisory");
    expect(out).not.toContain("~ [model]");
    expect(process.exitCode).toBe(1);
  });
});
