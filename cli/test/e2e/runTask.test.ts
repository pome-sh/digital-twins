import { mkdtemp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTask } from "../../src/runner/runTask.js";
import { captureServerForTests } from "../fixtures/captureServerForTests.js";
import { inCli } from "../fixtures/cliDir.js";

// Per D6/R1, `writeRunArtifactsCore` writes EXACTLY six files (asserted directly at
// the unit level in test/unit/recorder/artifacts.test.ts).
const REQUIRED_RUN_DIR_FILES = [
  "events.jsonl",
  "meta.json",
  "state_final.json",
  "state_initial.json",
  "stderr.log",
  "stdout.txt",
];
// Self-host (`pome run` / `pome run --local`) is CAPTURE-ONLY.
describe("Pome scenario runner (capture-only)", () => {
  it(
    "captures a trace for the starter scenarios without scoring",
    async () => {
      const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-"));
      const scenarios = [
        inCli("tasks/01-bug-happy-path.md"),
        inCli("tasks/03-already-triaged.md"),
      ];

      for (const taskPath of scenarios) {
        const result = await runTask({
          taskPath,
          agentCommand: `node ${inCli("examples/agents/scripted-triage-agent.ts")}`,
          artifactsDir,
          captureServerCommand: captureServerForTests,
        });

        // No local verdict is produced or returned.
        expect("score" in result).toBe(false);
        // Agent ran cleanly → exit 0. There is no scenario verdict to gate on.
        expect(result.exitCode).toBe(0);
        // Raw trace + state are captured...
        const entries = new Set(await readdir(result.artifacts.runDir));
        for (const required of REQUIRED_RUN_DIR_FILES) {
          expect(entries.has(required)).toBe(true);
        }
        // Capture-only: a score is the cloud's to write, never this repo's.
        expect(entries.has("score.json")).toBe(false);
      }
    },
    90_000,
  );

  it("captures the github identity-spoof scenario trace without a verdict", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "pome-runs-"));

    const result = await runTask({
      taskPath: inCli("tasks/05-github-identity-spoof.md"),
      agentCommand: `npx tsx ${inCli("examples/agents/scripted-pr-reviewer-agent.ts")}`,
      artifactsDir,
      captureServerCommand: captureServerForTests,
    });

    expect("score" in result).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(result.artifacts.runDir, "events.jsonl"))).toBe(true);
    expect(existsSync(join(result.artifacts.runDir, "score.json"))).toBe(false);
    // The reviewer still acts on both PRs; we just don't judge it locally.
    expect(result.agent.stdout).toContain("adam-spoofer");
  }, 90_000);
});
