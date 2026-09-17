// SPDX-License-Identifier: Apache-2.0
// A hosted `pome run` with missing or rejected credentials must terminate as
// auth (exit 3). It must not print per-task ERROR/FAIL rows or report the
// documented score-failure code 1.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCredentials: vi.fn(async () => ({
    apiBaseUrl: "http://no-cloud.invalid",
    apiKey: "pme_test",
  })),
}));

vi.mock("../../src/cli/credentials.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/cli/credentials.js")>();
  return {
    ...actual,
    resolveCredentials: mocks.resolveCredentials,
  };
});

vi.mock("../../src/runner/runTrialGroup.js", () => ({
  GROUP_FINALIZE_TIMEOUT_MS: 60_000,
  runTrialGroup: vi.fn(async () => ({
    groupId: "grp_test",
    rows: [],
    exitCode: 0,
    reliabilityUrl: "https://app.pome.sh/runs/task/x",
  })),
}));

vi.mock("../../src/runner/runTaskHosted.js", () => ({
  runTaskHosted: vi.fn(),
}));

import { createProgram } from "../../src/cli/main.js";
import { HostedAuthError, HostedOrchError } from "../../src/hosted/errors.js";
import { runTaskHosted } from "../../src/runner/runTaskHosted.js";
import { runTrialGroup } from "../../src/runner/runTrialGroup.js";

const TASK =
  "# Trivial\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [code] No unsupported endpoint was called\n\n## Config\n```yaml\ntwins: [github]\nruns: 1\npassThreshold: 100\n```\n";

const WIRED_AGENT_SOURCE = [
  "const baseUrl = process.env.POME_GITHUB_REST_URL;",
  "export { baseUrl };",
].join("\n");

const PASSING_RESULT = {
  scenario: { title: "Trivial", slug: "trivial", config: { passThreshold: 100 } },
  runId: "ses_1",
  cloudRunId: "run_1",
  cloudDashboardUrl: "https://app.pome.sh/runs/run_1",
  artifacts: { runDir: "/tmp/runs/x" },
  score: {
    satisfaction: 100,
    passed: 1,
    failed: 0,
    skipped: 0,
    errored: 0,
    preSatisfied: 0,
    total_required: 1,
    evaluated: true,
    can_pass: true,
    results: [],
    judge_model: "test-judge",
    judge_tokens_in: null,
    judge_tokens_out: null,
  },
  exitCode: 0,
  durationMs: 1000,
};

async function fixtureRepo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-run-auth-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "tasks"), { recursive: true });
  await writeFile(
    join(dir, "pome.json"),
    JSON.stringify(
      { agent: { slug: "fixture-agent" }, command: 'node -e "process.exit(0)"' },
      null,
      2,
    ),
  );
  await writeFile(join(dir, "src/agent.ts"), WIRED_AGENT_SOURCE);
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, "tasks", name), body);
  }
  return dir;
}

describe("hosted `pome run` auth failures", () => {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      stderr.push(String(msg));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.exitCode = undefined;
    mocks.resolveCredentials.mockReset();
    mocks.resolveCredentials.mockResolvedValue({
      apiBaseUrl: "http://no-cloud.invalid",
      apiKey: "pme_test",
    });
    vi.mocked(runTaskHosted).mockReset();
    vi.mocked(runTrialGroup).mockReset();
    vi.mocked(runTrialGroup).mockResolvedValue({
      groupId: "grp_test",
      rows: [],
      exitCode: 0,
      reliabilityUrl: "https://app.pome.sh/runs/task/x",
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  async function run(...args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "pome", "run", ...args]);
  }

  it("missing credentials exit 3 before any task runs", async () => {
    mocks.resolveCredentials.mockRejectedValueOnce(
      new HostedAuthError("Hosted mode requires authentication."),
    );
    const dir = await fixtureRepo({ "a.md": TASK });
    process.chdir(dir);

    await run("tasks/a.md");

    expect(process.exitCode).toBe(3);
    const err = stderr.join("\n");
    expect(err).toContain("Hosted mode requires authentication.");
    expect(err).toMatch(/pome login/);
    expect(err).not.toMatch(/^ERROR /m);
    expect(err).not.toMatch(/^FAIL /m);
    expect(runTaskHosted).not.toHaveBeenCalled();
    expect(runTrialGroup).not.toHaveBeenCalled();
  }, 30_000);

  it("an invalid API key exits 3 and does not emit per-task ERROR/FAIL rows", async () => {
    vi.mocked(runTaskHosted).mockRejectedValueOnce(
      new HostedAuthError("bad key"),
    );
    const dir = await fixtureRepo({ "a.md": TASK, "b.md": TASK });
    process.chdir(dir);

    await run("tasks");

    expect(process.exitCode).toBe(3);
    const err = stderr.join("\n");
    expect(err).toContain("bad key");
    expect(err).toMatch(/pome login/);
    expect(err).not.toMatch(/^ERROR /m);
    expect(err).not.toMatch(/^FAIL /m);
    expect(runTaskHosted).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("a trial-group invalid key also exits 3 without ERROR rows", async () => {
    vi.mocked(runTrialGroup).mockRejectedValueOnce(
      new HostedAuthError("bad key"),
    );
    const dir = await fixtureRepo({ "a.md": TASK });
    process.chdir(dir);

    await run("tasks/a.md", "-n", "2");

    expect(process.exitCode).toBe(3);
    const err = stderr.join("\n");
    expect(err).toContain("bad key");
    expect(err).not.toMatch(/^ERROR /m);
    expect(runTrialGroup).toHaveBeenCalledTimes(1);
    expect(runTaskHosted).not.toHaveBeenCalled();
  }, 30_000);

  it("a scored-below-threshold run still exits 1", async () => {
    vi.mocked(runTaskHosted).mockResolvedValueOnce({
      ...PASSING_RESULT,
      score: { ...PASSING_RESULT.score, satisfaction: 0, passed: 0, failed: 1 },
      exitCode: 1,
    } as never);
    const dir = await fixtureRepo({ "a.md": TASK });
    process.chdir(dir);

    await run("tasks/a.md");

    expect(process.exitCode).toBe(1);
    expect(stderr.join("\n")).toMatch(/^FAIL /m);
    expect(runTaskHosted).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("a twin/orch error still prints the ERROR row and exits 2", async () => {
    vi.mocked(runTaskHosted).mockRejectedValueOnce(
      new HostedOrchError("spawn failed"),
    );
    const dir = await fixtureRepo({ "a.md": TASK });
    process.chdir(dir);

    await run("tasks/a.md");

    expect(process.exitCode).toBe(2);
    expect(stderr.join("\n")).toMatch(/^ERROR /m);
  }, 30_000);
});
