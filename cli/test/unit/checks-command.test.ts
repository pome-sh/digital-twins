// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";

interface CapturedConsole {
  log: string[];
  error: string[];
}

function captureConsole(): CapturedConsole {
  const captured: CapturedConsole = { log: [], error: [] };
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.log.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    captured.error.push(args.map(String).join(" "));
  });
  return captured;
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("pome checks", () => {
  it("lists a twin's declared checks with what each one actually compares", async () => {
    const captured = captureConsole();
    await createProgram().parseAsync(["node", "pome", "checks", "github"]);
    const out = captured.log.join("\n");
    expect(out).toContain("github.no-new-labels");
    // The slot is displayed by NAME, derived from the template — no title field
    // has to exist for a listing to be readable.
    expect(out).toContain("No new labels were created in `<repo>`");
    // The description is the whole reason the declaration gained one.
    expect(out).toContain("DEFINITIONS");
    // Discovery hands over the command instead of describing it.
    expect(out).toContain("--check github.no-new-labels --arg repo=acme/api");
    expect(process.exitCode).toBeUndefined();
  });

  it("indexes the twins that declare checks when none is given", async () => {
    const captured = captureConsole();
    await createProgram().parseAsync(["node", "pome", "checks"]);
    expect(captured.log.join("\n")).toContain("github");
  });

  it("says plainly that a real twin has no declared checks yet", async () => {
    const captured = captureConsole();
    await createProgram().parseAsync(["node", "pome", "checks", "slack"]);
    expect(captured.log.join("\n").toLowerCase()).toContain("no declared checks");
    expect(process.exitCode).toBeUndefined();
  });

  it("errors with a hint on an unknown twin", async () => {
    const captured = captureConsole();
    await createProgram().parseAsync(["node", "pome", "checks", "gitbub"]);
    expect(process.exitCode).toBe(2);
    expect(captured.error.join("\n")).toContain("github");
  });

  it("--json emits the declaration plus a digest, for skills and agents", async () => {
    const captured = captureConsole();
    await createProgram().parseAsync(["node", "pome", "checks", "github", "--json"]);
    const body = JSON.parse(captured.log.join("\n")) as {
      twin: string;
      digest: string;
      checks: Array<{ id: string; description: string; params: Array<{ example: string }> }>;
    };
    expect(body.twin).toBe("github");
    expect(body.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.checks[0]!.params[0]!.example).toBe("acme/api");
    expect(body.checks[0]!.description.length).toBeGreaterThan(0);
  });
});
