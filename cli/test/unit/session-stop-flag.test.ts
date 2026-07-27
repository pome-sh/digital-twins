// SPDX-License-Identifier: Apache-2.0
// F-983 — pins `pome session stop`'s `--discard` flag wiring in
// cli/src/cli/main.ts. If the option name ever drifted, the user's only
// escape hatch from the ungraded-session guard would die silently (a bare
// `pome session stop <id>` would forever look identical to a confirmed
// discard). Same build-the-program-and-parseAsync pattern as
// run-n-flag.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runSessionStop: vi.fn(async () => {}),
}));

vi.mock("../../src/cli/session.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/cli/session.js")>();
  return {
    ...actual,
    runSessionStop: mocks.runSessionStop,
  };
});

import { createProgram } from "../../src/cli/main.js";

describe("pome session stop --discard wiring (F-983)", () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    mocks.runSessionStop.mockClear();
    mocks.runSessionStop.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  async function run(...args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "pome", "session", "stop", ...args]);
  }

  it("defaults discard to false", async () => {
    await run("ses_a");
    expect(mocks.runSessionStop).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_a", discard: false }),
    );
  });

  it("--discard passes discard: true", async () => {
    await run("ses_a", "--discard");
    expect(mocks.runSessionStop).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_a", discard: true }),
    );
  });

  it("the `kill` alias also wires --discard through", async () => {
    await createProgram().parseAsync([
      "node",
      "pome",
      "session",
      "kill",
      "ses_a",
      "--discard",
    ]);
    expect(mocks.runSessionStop).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_a", discard: true }),
    );
  });
});
