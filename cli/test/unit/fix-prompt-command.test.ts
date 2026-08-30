// SPDX-License-Identifier: Apache-2.0
// `pome fix-prompt` command surface: - legacy 2-arg form (<events.jsonl> <task.md>) is
// unchanged; - an events.jsonl target without a task file is a usage.

import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";
import {
  VERDICT_ARTIFACT_VERSION,
  writeVerdictArtifact,
  type VerdictArtifact,
} from "../../src/hosted/evalResultCache.js";

const TASK_MD =
  "# scn\n\n## Prompt\nTriage the bug.\n\n## Success Criteria\n- [model] Severity is set correctly\n";

const EVENT =
  '{"twin":"github","method":"POST","path":"/repos/acme/api/issues/1/labels","status":200,"latency_ms":10,"request_body":{"labels":["bug"]},"response_body":null,"state_delta":null}\n';

function verdict(over: Partial<VerdictArtifact>): VerdictArtifact {
  return {
    version: VERDICT_ARTIFACT_VERSION,
    source: "cloud-finalize",
    task_name: "scn",
    task_path: "tasks/scn.md",
    group_id: "grp_cmd",
    session_id: "ses_1",
    cloud_run_id: "run_1",
    cloud_dashboard_url: "https://app.pome.sh/runs/run_1",
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

async function writeTrial(
  root: string,
  sid: string,
  over: Partial<VerdictArtifact>,
): Promise<void> {
  const runDir = join(root, "runs", "scn", sid);
  await mkdir(runDir, { recursive: true });
  await writeVerdictArtifact(runDir, verdict({ session_id: sid, ...over }));
  await writeFile(join(runDir, "events.jsonl"), EVENT, "utf8");
}

describe("pome fix-prompt command", () => {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      stdout.push(String(msg));
    });
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      stderr.push(String(msg));
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  async function run(...args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "pome", "fix-prompt", ...args]);
  }

  it("legacy 2-arg form is unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-legacy-"));
    await writeFile(join(dir, "events.jsonl"), EVENT, "utf8");
    await writeFile(join(dir, "scn.md"), TASK_MD, "utf8");
    await run(join(dir, "events.jsonl"), join(dir, "scn.md"));

    expect(process.exitCode ?? 0).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain("## Trace (HTTP calls the agent made)");
    expect(text).toContain("Severity is set correctly");
  });

  it("an events.jsonl target without a task file is a usage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-usage-"));
    await writeFile(join(dir, "events.jsonl"), EVENT, "utf8");
    await run(join(dir, "events.jsonl"));
    expect(process.exitCode).toBe(5);
    expect(stderr.join("\n")).toContain("needs the task file");
  });

  it("a second argument with a dir target is a usage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-usage2-"));
    await run(dir, "whatever.md");
    expect(process.exitCode).toBe(5);
    expect(stderr.join("\n")).toContain("only applies to the events.jsonl form");
  });

  it("0-arg emits the latest FAILED run set as one grouped prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-group-"));
    await writeTrial(dir, "ses_1", {
      passed: true,
      finalized_at: "2026-07-06T00:01:00.000Z",
    });
    await writeTrial(dir, "ses_2", {
      passed: false,
      state: "fail",
      score: 50,
      finalized_at: "2026-07-06T00:02:00.000Z",
      criteria_results: [
        {
          criterion: { type: "model", text: "Severity is set correctly" },
          passed: false,
          skipped: false,
          reason: "under-rated",
        },
      ],
    });
    await mkdir(join(dir, "tasks"), { recursive: true });
    await writeFile(join(dir, "tasks", "scn.md"), TASK_MD, "utf8");
    process.chdir(dir);

    await run();
    expect(process.exitCode ?? 0).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain("## Grouped failure signatures (from the cloud judge)");
    expect(text).toContain("under-rated");
    expect(text).toContain("1 of 2 completed trials passed");
    expect(text).toContain("## Variance note");
    // The on-disk task file must match the verdict's `task_path`, or this
    // whole test silently exercises the degraded (file-missing) branch.
    expect(text).not.toContain("task file not found");
  });

  it("all-green roots print nothing-to-fix (exit 0)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-green-"));
    await writeTrial(dir, "ses_1", { passed: true });
    process.chdir(dir);

    await run();
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout.join("\n")).toBe("");
    expect(stderr.join("\n")).toContain("Nothing to fix");
  });

  // The ticket's own reproduction: a root whose only non-passing run set is INCOMPLETE
  // (a criterion was never graded, nothing genuinely failed).
  it("an incomplete-only root names the gap distinctly (exit 1, no prompt, not 'all passed')", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-incomplete-"));
    await writeTrial(dir, "ses_1", {
      passed: false,
      state: "incomplete",
      score: 0,
      evaluated: 0,
      not_evaluated: 1,
      total: 1,
      criteria_results: [
        {
          criterion: { type: "model", text: "Severity is set correctly" },
          passed: false,
          skipped: true,
          reason: "tool_not_recorded",
        },
      ],
    });
    process.chdir(dir);

    await run();
    // Not routed to an agent: no prompt is printed at all.
    expect(stdout.join("\n")).toBe("");
    const err = stderr.join("\n");
    // Distinct from the "all passed" wording — the reversed defect a naive
    // `state === "fail"` flip (with no third message) would produce here.
    expect(err).not.toContain("all passed");
    expect(err).not.toContain("Nothing to fix:");
    // Names the gap by kind and what to do about it, without blaming the
    // agent's prompt.
    expect(err).toContain("INCOMPLETE");
    expect(err).toContain("never graded");
    expect(err).toContain("not an agent defect");
    expect(err).toContain("Re-run");
    // Non-zero: there is something worth acting on, even though it isn't a
    // fix-prompt-worthy failure.
    expect(process.exitCode).toBe(1);
    // Names WHICH set, and does not call it "the latest run set" — the
    // newest set may have passed; this one is the newest NON-PASSING one.
    expect(err).toContain("most recent non-passing");
    expect(err).toContain("task scn");
  });

  // The understating twin of the original defect.
  it("an incomplete set holding GRADED failures says so instead of calling it only a grading gap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-incomplete-failed-"));
    await writeTrial(dir, "ses_1", {
      passed: false,
      state: "incomplete",
      score: 0,
      evaluated: 2,
      not_evaluated: 1,
      total: 3,
      criteria_results: [
        {
          criterion: { type: "model", text: "Severity is set correctly" },
          passed: false,
          skipped: false,
          reason: "under-rated",
        },
        {
          criterion: { type: "model", text: "An assignee is set" },
          passed: false,
          skipped: false,
          reason: "never set",
        },
        {
          criterion: { type: "model", text: "Exactly one comment" },
          passed: false,
          skipped: true,
          reason: "tool_not_recorded",
        },
      ],
    });
    process.chdir(dir);

    await run();
    const err = stderr.join("\n");
    // Still not routed (no trial was graded end to end), still exit 1, still
    // never "all passed".
    expect(stdout.join("\n")).toBe("");
    expect(process.exitCode).toBe(1);
    expect(err).not.toContain("all passed");
    // But it must NOT absolve the agent: two criteria were graded and failed.
    expect(err).not.toContain("not an agent defect");
    expect(err).toContain("2 criterion result(s)");
    expect(err).toContain("WERE graded and did fail");
    // And it names the escape hatch that DOES build a prompt from what was
    // graded — the trial-dir form, which targets its set whatever the outcome.
    expect(err).toContain("pome fix-prompt");
    expect(err).toContain(join("runs", "scn", "ses_1"));
  });

  it("an empty root is a usage error naming what to do", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-empty-"));
    process.chdir(dir);
    await run();
    expect(process.exitCode).toBe(5);
    expect(stderr.join("\n")).toContain("No finalized run sets");
  });

  // A verdict.json this CLI can't read must never render as an absence — a
  // prior-version file lands in the unreadable line like any other.
  describe("a verdict.json an older CLI wrote is a named skip", () => {
    async function writeStaleTrial(root: string, sid: string): Promise<void> {
      const runDir = join(root, "runs", "scn", sid);
      await mkdir(runDir, { recursive: true });
      const {
        state: _s,
        evaluated: _e,
        not_evaluated: _n,
        pre_satisfied: _p,
        total: _t,
        ...v1
      } = verdict({ session_id: sid });
      await writeFile(
        join(runDir, "verdict.json"),
        JSON.stringify({ ...v1, version: 1 }),
        "utf8",
      );
      await writeFile(join(runDir, "events.jsonl"), EVENT, "utf8");
    }

    it("a root holding only prior-version trials names the skip, not 'no runs'", async () => {
      const dir = await mkdtemp(join(tmpdir(), "fixcmd-stale-only-"));
      await writeStaleTrial(dir, "ses_v1");
      process.chdir(dir);

      await run();
      expect(process.exitCode).toBe(5);
      const err = stderr.join("\n");
      expect(err).toContain("1 verdict.json file(s)");
      expect(err).toContain("written by an older CLI");
      // The distinct-state requirement: this must NOT be the message a truly
      // empty runs/ gets.
      expect(err).not.toContain("No finalized run sets");
    });

    it("a root holding prior-version trials beside readable ones still names the skip AND prints the prompt", async () => {
      const dir = await mkdtemp(join(tmpdir(), "fixcmd-stale-mixed-"));
      await writeStaleTrial(dir, "ses_v1");
      await writeTrial(dir, "ses_2", {
        passed: false,
        state: "fail",
        score: 50,
        criteria_results: [
          {
            criterion: { type: "model", text: "Severity is set correctly" },
            passed: false,
            skipped: false,
            reason: "under-rated",
          },
        ],
      });
      process.chdir(dir);

      await run();
      expect(process.exitCode ?? 0).toBe(0);
      expect(stdout.join("\n")).toContain("## Grouped failure signatures");
      expect(stderr.join("\n")).toContain("1 verdict.json file(s)");
    });
  });

  // A verdict.json that EXISTS but is damaged (truncated, hand-edited, or an
  // unexpected `state`) is named with its path, not just counted.
  describe("a corrupt current-version verdict.json is a named skip that points at the path", () => {
    async function writeCorruptTrial(root: string, sid: string): Promise<string> {
      const runDir = join(root, "runs", "scn", sid);
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "verdict.json"),
        JSON.stringify(verdict({ session_id: sid, state: "bogus" as never })),
        "utf8",
      );
      return runDir;
    }

    it("a root holding only a corrupt trial names the path, not 'no runs'", async () => {
      const dir = await mkdtemp(join(tmpdir(), "fixcmd-unreadable-only-"));
      const runDir = await writeCorruptTrial(dir, "ses_bad");
      process.chdir(dir);

      await run();
      expect(process.exitCode).toBe(5);
      const err = stderr.join("\n");
      expect(err).toContain("1 verdict.json file(s)");
      expect(err).toContain("could not be read");
      expect(err).toContain(runDir);
      expect(err).not.toContain("No finalized run sets");
    });

    it("a root holding a corrupt trial beside a readable failed one still names the corrupt path AND prints the prompt", async () => {
      const dir = await mkdtemp(join(tmpdir(), "fixcmd-unreadable-mixed-"));
      const runDir = await writeCorruptTrial(dir, "ses_bad");
      await writeTrial(dir, "ses_2", {
        passed: false,
        state: "fail",
        score: 50,
        criteria_results: [
          {
            criterion: { type: "model", text: "Severity is set correctly" },
            passed: false,
            skipped: false,
            reason: "under-rated",
          },
        ],
      });
      process.chdir(dir);

      await run();
      expect(process.exitCode ?? 0).toBe(0);
      expect(stdout.join("\n")).toContain("## Grouped failure signatures");
      const err = stderr.join("\n");
      expect(err).toContain("1 verdict.json file(s)");
      expect(err).toContain("could not be read");
      expect(err).toContain(runDir);
    });

    // The trim is the one part of this output with arithmetic in it, and it
    // only fires past five paths — untested, an off-by-one (or a tail line
    // that never prints) is invisible to CI. Five is the last count that
    // prints every path; six is the first that omits one.
    it("names every path up to five, and trims with a count past that", async () => {
      const five = await mkdtemp(join(tmpdir(), "fixcmd-unreadable-five-"));
      const fiveDirs: string[] = [];
      for (let i = 1; i <= 5; i += 1) {
        fiveDirs.push(await writeCorruptTrial(five, `ses_bad_${i}`));
      }
      process.chdir(five);
      await run();
      const fiveErr = stderr.join("\n");
      expect(fiveErr).toContain("5 verdict.json file(s)");
      for (const d of fiveDirs) expect(fiveErr).toContain(d);
      expect(fiveErr).not.toContain("more omitted");

      stderr = [];
      const six = await mkdtemp(join(tmpdir(), "fixcmd-unreadable-six-"));
      const sixDirs: string[] = [];
      for (let i = 1; i <= 6; i += 1) {
        sixDirs.push(await writeCorruptTrial(six, `ses_bad_${i}`));
      }
      process.chdir(six);
      await run();
      const sixErr = stderr.join("\n");
      expect(sixErr).toContain("6 verdict.json file(s)");
      expect(sixErr).toContain("(1 more omitted — kept first 5)");
      // WHICH five survive the trim is pinned, not just how many: the scan
      // sorts `unreadablePaths` so this holds on ext4 (hash-ordered readdir)
      // as well as APFS. Asserting only the count would let that sort rot.
      const listed = sixErr
        .split("\n")
        .filter((l) => l.startsWith("  - "))
        .map((l) => l.slice(4));
      // Compared against the REALPATH of the tmp root: discovery resolves the
      // root against `process.cwd()`, which on macOS reports
      // /private/var/... for a /var/... tmpdir. The `toContain` assertions
      // elsewhere in this describe survive that by substring luck; an
      // order-sensitive equality cannot.
      const sixRoot = await realpath(six);
      expect(listed).toEqual(
        sixDirs
          .map((d) => join(sixRoot, relative(six, d)))
          .sort()
          .slice(0, 5),
      );
    });

    it("a trial dir pointed straight at a corrupt verdict.json names it as unreadable, not as an empty root", async () => {
      const dir = await mkdtemp(join(tmpdir(), "fixcmd-unreadable-trialdir-"));
      const runDir = await writeCorruptTrial(dir, "ses_bad");

      await run(runDir);
      expect(process.exitCode).toBe(5);
      const err = stderr.join("\n");
      expect(err).toContain("1 verdict.json file(s)");
      expect(err).toContain("could not be read");
      expect(err).toContain(runDir);
    });
  });

  it("a trial run dir targets that trial's set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixcmd-trial-"));
    await writeTrial(dir, "ses_1", {
      passed: false,
      criteria_results: [
        {
          criterion: { type: "model", text: "Severity is set correctly" },
          passed: false,
          skipped: false,
          reason: "under-rated",
        },
      ],
    });
    process.chdir(dir);

    await run(join(dir, "runs", "scn", "ses_1"));
    expect(process.exitCode ?? 0).toBe(0);
    expect(stdout.join("\n")).toContain("## Grouped failure signatures");
  });
});
