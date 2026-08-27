import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";

const originalCwd = process.cwd();

describe("pome inspect command", () => {
  let tmp: string;
  let runDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "pome-inspect-cmd-"));
    runDir = join(tmp, "runs", "scenario-x", "run_abc");
    await mkdir(runDir, { recursive: true });
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  it("renders trace health + events on the green path", async () => {
    await writeFile(
      join(runDir, "meta.json"),
      JSON.stringify({ run_id: "run_abc", scenario: "scenario-x", twins: ["github"] }),
    );
    const events = [
      {
        kind: "LlmCallEvent",
        ts: "2026-05-26T00:00:00.500Z",
        event_id: "evt_llm_1",
        parent_id: null,
        host: "api.anthropic.com",
        port: 443,
        latency_ms: 800,
        bytes_in: 100,
        bytes_out: 200,
        url: null,
        method: null,
        status: null,
        model: null,
        prompt_tokens: null,
        completion_tokens: null,
        cost_usd: null,
      },
      {
        kind: "TwinHttpEvent",
        ts: "2026-05-26T00:00:01.000Z",
        event_id: "evt_twin_1",
        parent_id: null,
        run_id: "run_abc",
        twin: "github",
        request_id: "req_1",
        step_id: null,
        tool_call_id: null,
        method: "GET",
        path: "/repos/acme/api",
        request_body: null,
        status: 200,
        response_body: null,
        latency_ms: 5,
        fidelity: "semantic",
        state_mutation: false,
        state_delta: null,
        error: null,
      },
    ];
    await writeFile(
      join(runDir, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync(["node", "pome", "inspect", runDir]);

    // Inspect renders ONLY trace/audit content. It never prints a
    // verdict (there is no local score). Exit code stays unset (treated as 0).
    expect(process.exitCode).toBeUndefined();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("Trace health:");
    expect(out).toContain("proxy: 1/expected≥1");
    expect(out).toContain("twin: 1/expected≥1");
    expect(out).toContain("Events (2):");
    // No verdict rendered — capture-only.
    expect(out).not.toContain("Score");
    expect(out).not.toMatch(/\bPASS\b|\bFAIL\b|\bINCOMPLETE\b/);
  });

  it("shows only trace/audit content — never a verdict, even if a stray score.json exists", async () => {
    await writeFile(
      join(runDir, "meta.json"),
      JSON.stringify({ run_id: "run_abc", scenario: "scenario-x", twins: ["github"] }),
    );
    await writeFile(
      join(runDir, "events.jsonl"),
      JSON.stringify({
        kind: "TwinHttpEvent",
        ts: "2026-05-26T00:00:01.000Z",
        event_id: "evt_twin_1",
        parent_id: null,
        run_id: "run_abc",
        twin: "github",
        request_id: "req_1",
        step_id: null,
        tool_call_id: null,
        method: "GET",
        path: "/repos/acme/api",
        request_body: null,
        status: 200,
        response_body: null,
        latency_ms: 5,
        fidelity: "semantic",
        state_mutation: false,
        state_delta: null,
        error: null,
      }) + "\n",
    );
    // A stray score.json (e.g. left over from an older CLI) must be IGNORED —
    // inspect is trace/audit only; the verdict lives in the cloud.
    await writeFile(
      join(runDir, "score.json"),
      JSON.stringify({ satisfaction: 100, passed: 1, results: [] }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync(["node", "pome", "inspect", runDir]);

    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("Trace health:");
    expect(out).toContain("Events (1):");
    expect(out).not.toContain("Score");
    expect(out).not.toMatch(/\bPASS\b|\bFAIL\b|\bINCOMPLETE\b/);
  });
});
