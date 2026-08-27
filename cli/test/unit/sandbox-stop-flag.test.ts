// SPDX-License-Identifier: Apache-2.0
// Pins `pome sandbox stop`'s `--discard` flag wiring in cli/src/cli/main.ts.

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
import { HostedDiscardRefusedError } from "../../src/hosted/errors.js";

describe("pome sandbox stop --discard wiring", () => {
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
    await createProgram().parseAsync(["node", "pome", "sandbox", "stop", ...args]);
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

  it("a refused discard is a usage error, not a twin failure", async () => {
    // Exit 5, not 2. Nothing is broken when the CLI refuses: the invocation was
    // missing `--discard`. Exit 2 means "twin or runner error" in the documented
    // table, and a CI job branching on $? would go looking for an outage.
    mocks.runSessionStop.mockRejectedValueOnce(
      new HostedDiscardRefusedError("refused", "ses_a", "running", "my-task", 42, "tok"),
    );

    await run("ses_a");

    expect(process.exitCode).toBe(5);
  });
});
