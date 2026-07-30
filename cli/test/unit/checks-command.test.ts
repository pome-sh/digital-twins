// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOUNTED_TWINS } from "@pome-sh/shared-types";
import { createProgram } from "../../src/cli/main.js";
import { checksFor, twinsWithoutChecks } from "../../src/cli/checks.js";

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

  // A3's completion invariant, and the replacement for the case that used to
  // live here (F-1129).
  //
  // That case ran `pome checks <a twin with no vocabulary>` and asserted the
  // "no declared checks yet" line. It cannot run any more, and the reason is
  // the milestone succeeding rather than the test rotting: the branch needs a
  // twin id that `isKnownTwin` accepts and `checksFor` returns nothing for, and
  // once every MOUNTED twin declares, no id satisfies both. A synthetic id
  // takes the "no such twin" path instead — a different assertion wearing the
  // same shape, which is worse than no assertion because it looks like one.
  //
  // So assert the fact directly. This goes red the day someone mounts a twin
  // without declaring its vocabulary, which is exactly when the dormant
  // `checksFor(twin).length === 0` branch becomes reachable again and whoever
  // did it needs pointing at it.
  it("leaves no mounted twin without a declared vocabulary", () => {
    expect(twinsWithoutChecks()).toEqual([]);
    for (const twin of MOUNTED_TWINS) {
      expect(checksFor(twin).length, `${twin} declares no checks`).toBeGreaterThan(0);
    }
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
    // Look the check up by id rather than by index. `checks[0]` was
    // `no-new-labels` only while it was the sole declaration; F-1075 made the
    // set eleven, and A3 widens it again. An index assertion over a growing
    // closed set pins its size, which is not what this test is about.
    const noNewLabels = body.checks.find((check) => check.id === "github.no-new-labels")!;
    expect(noNewLabels.params[0]!.example).toBe("acme/api");
    // Every declaration must carry a description an authoring surface can show
    // (F-1074), so assert it of ALL of them rather than of whichever sorts first.
    for (const check of body.checks) {
      expect(check.description.length, `${check.id} declares no description`).toBeGreaterThan(0);
    }
  });
});
