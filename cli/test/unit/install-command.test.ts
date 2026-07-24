// SPDX-License-Identifier: Apache-2.0
// F-893 — `pome install` is retired to a redirect. It no longer resolves
// credentials, detects a coding agent, stages a diff, or runs doctor; it just
// prints the Gen-2 wiring path and exits 0. The command tolerates the old flags
// (`--interactive`, `--api-url …`) so stale invocations still land on the
// redirect instead of erroring on a removed option.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runInstall } from "../../src/cli/install.js";
import { createProgram } from "../../src/cli/main.js";

describe("pome install (F-893 redirect)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    errSpy.mockRestore();
    process.exitCode = undefined;
  });

  function captured(): string {
    return errSpy.mock.calls.map((c) => String(c[0])).join("\n");
  }

  it("prints the Gen-2 wiring path and exits 0", () => {
    runInstall();

    const out = captured();
    expect(out).toContain("retired");
    // Both Gen-2 install steps are named.
    expect(out).toContain("claude mcp add --transport http pome https://mcp.pome.sh/mcp");
    expect(out).toContain("npx skills add pome-sh/digital-twins");
    // Points at the intake / REST-launch preflight as the next step.
    expect(out).toContain("pome-intake");
    // A retired command lands the user on the right path — never a non-zero exit.
    expect(process.exitCode).toBeUndefined();
  });

  it("does not advertise the removed Gen-1 flow", () => {
    runInstall();
    const out = captured();
    expect(out).not.toContain("pome-setup");
    expect(out).not.toContain("headless");
    expect(out).not.toContain("approve the diff");
  });

  it("runs from the CLI and tolerates the old flags", async () => {
    const program = createProgram();
    program.exitOverride();
    // Old invocation with a now-removed flag must not throw on an unknown option.
    await expect(
      program.parseAsync(["install", "--interactive"], { from: "user" }),
    ).resolves.toBeDefined();
    expect(captured()).toContain("npx skills add pome-sh/digital-twins");
  });
});
