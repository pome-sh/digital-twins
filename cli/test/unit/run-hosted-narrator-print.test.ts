// SPDX-License-Identifier: Apache-2.0
// F-1754 — a hosted `pome run` of a MIXED task prints its verdict off the
// `[code]` denominator and the narrator's `[model]` rows beside it.
//
// Both hosted shapes, because a bare `pome run` is k=5 and takes the trial-group
// path while `-n 1` stays on the single-run one: a surface that renders the
// readings on only one of the two is silent on the default.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../../src/cli/main.js";
import { runTaskHosted } from "../../src/runner/runTaskHosted.js";
import { scoreFromFinalizeResponse } from "../../src/hosted/uploadAndFinalize.js";
import { groupSummaryLines } from "../../src/runner/groupRender.js";
import type { CriterionResult } from "../../src/hosted/evalResultView.js";

const MIXED_RESULTS: CriterionResult[] = [
  {
    criterion: { type: "code", text: "Issue #1 has exactly one classification label, and it is `bug`" },
    passed: true,
    skipped: false,
    reason: 'issue #1 has exactly one label ("bug")',
  },
  {
    criterion: { type: "model", text: "The `bug` label was applied to the 500-error issue, and to no other issue." },
    passed: false,
    skipped: true,
    reason: "1. The trace shows one POST to /repos/acme/api/issues/1/labels. 2. Therefore …",
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

const MIXED_SCORE = scoreFromFinalizeResponse({
  run_id: "run_1",
  score: 100,
  judge_model: "test-judge",
  dashboard_url: "https://app.pome.sh/runs/run_1",
  criteria_results: MIXED_RESULTS,
});

vi.mock("../../src/runner/runTaskHosted.js", () => ({
  runTaskHosted: vi.fn(),
}));

vi.mock("../../src/cli/credentials.js", () => ({
  resolveCredentials: vi.fn(async () => ({
    apiBaseUrl: "http://no-cloud.invalid",
    apiKey: "pme_test",
  })),
}));

const TASK =
  "# Mixed\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n" +
  "- [code] Issue #1 has exactly one classification label, and it is `bug`\n" +
  "- [model] The `bug` label was applied to the 500-error issue, and to no other issue.\n" +
  "\n## Config\n```yaml\ntwins: [github]\nruns: 1\npassThreshold: 100\n```\n";

/** The wiring `pome doctor` demands before `pome run` will spawn an agent:
 *  a manifest and a source file that reads the twin's base URL from the env
 *  rather than hardcoding a production host. */
async function fixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-run-narrator-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "pome.json"),
    JSON.stringify(
      { agent: { slug: "fixture-agent" }, command: 'node -e "process.exit(0)"' },
      null,
      2,
    ),
  );
  await writeFile(
    join(dir, "src/agent.ts"),
    [
      'import { withPome } from "@pome-sh/adapter-claude-sdk";',
      "withPome();",
      "const baseUrl = process.env.POME_GITHUB_REST_URL;",
      "export { baseUrl };",
    ].join("\n"),
  );
  return dir;
}

describe("hosted `pome run` — a single run's verdict block", () => {
  let stderr: string[];
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      stderr.push(String(msg));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
    process.env.POME_API_KEY = "pme_test_env_key";
    vi.mocked(runTaskHosted).mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.POME_API_KEY;
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  it("passes off the `[code]` denominator and prints the narrator's rows beside it", async () => {
    const dir = await fixtureRepo();
    process.chdir(dir);
    const taskPath = join(dir, "mixed.md");
    await writeFile(taskPath, TASK);

    vi.mocked(runTaskHosted).mockResolvedValue({
      scenario: { title: "Mixed", slug: "mixed", config: { passThreshold: 100 } },
      runId: "ses_1",
      cloudRunId: "run_1",
      cloudDashboardUrl: "https://app.pome.sh/runs/run_1",
      artifacts: { runDir: join(dir, "runs", "x") },
      score: MIXED_SCORE,
      exitCode: 0,
      durationMs: 1000,
    } as never);

    await createProgram().parseAsync(["node", "pome", "run", taskPath]);

    const err = stderr.join("\n");
    // The verdict comes off the one `[code]` row; the two narrator rows do not
    // make the run incomplete.
    expect(err).toContain("PASS Mixed");
    expect(err).toContain("score: 100/100");
    expect(process.exitCode ?? 0).toBe(0);

    // …and they are visible rather than dropped, under a header that says what
    // they are, with the narrator's marker and never a verdict one.
    expect(err).toContain("the narrator also read these, and scored none of them:");
    expect(err).toContain(
      "  ~ advisory · the `bug` label was applied to the 500-error issue, and to no…",
    );
    expect(err).toContain("  ~ abstained · the refund was explained to the customer");
    expect(err).not.toMatch(/[✓✗] \[model\]/);
    expect(err).not.toMatch(/- \[model\]/);
    // The narrator's prose stays on the dashboard the next line links to.
    expect(err).not.toContain("The trace shows one POST");
    expect(err).toContain("cloud: https://app.pome.sh/runs/run_1");
  }, 30_000);
});

describe("hosted `pome run -n k` — the group summary's verdict block", () => {
  it("prints the readings once for the whole set, deduped across trials", () => {
    const lines = groupSummaryLines({
      rows: [
        { kind: "completed", score: 100, verdict: "pass", seconds: 1 },
        { kind: "completed", score: 100, verdict: "pass", seconds: 1 },
      ],
      // Two trials of one task: the same two criteria, twice.
      narrated: [...MIXED_RESULTS.slice(1), ...MIXED_RESULTS.slice(1)],
      reliabilityUrl: "https://app.pome.sh/runs/task/mixed",
    });
    const readings = lines.filter((line) => line.trimStart().startsWith("~ "));
    expect(readings).toHaveLength(2);
    expect(lines).toContain("the narrator also read these, and scored none of them:");
    expect(readings[1]).toBe("  ~ abstained · the refund was explained to the customer");
  });

  it("says nothing about the narrator on a set with no narrated rows", () => {
    const lines = groupSummaryLines({
      rows: [{ kind: "completed", score: 100, verdict: "pass", seconds: 1 }],
      reliabilityUrl: "https://app.pome.sh/runs/task/mixed",
    });
    expect(lines.join("\n")).not.toContain("narrator");
  });
});
