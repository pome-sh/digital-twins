// SPDX-License-Identifier: Apache-2.0
// `pome --help` is an index: one line per command, answering only "which of
// these do I want". It had grown to 76 lines because 14 of 21 commands
// described themselves in prose there.
//
// Commander prints `.summary()` in the parent's command list and
// `.description()` in the command's own `--help`, so the property worth holding
// is that nothing in the list wraps: a command added later with a paragraph for
// a summary regresses this silently, and nobody re-reads `--help` to notice.

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/main.js";

/** Commander's default when stdout is not a TTY, which is what CI reads. Fixed
 *  here so the assertion does not depend on the terminal running it. */
const HELP_WIDTH = 80;

describe("pome --help", () => {
  it("gives every command exactly one line", () => {
    const program = createProgram();
    program.configureHelp({ helpWidth: HELP_WIDTH });
    const help = program.createHelp();
    // `visibleCommands` already includes Commander's own `help` entry.
    const names = help.visibleCommands(program).map((cmd: Command) => cmd.name());

    const lines = program.helpInformation().split("\n");
    const start = lines.indexOf("Commands:");
    expect(start, "root --help no longer prints a Commands: block").toBeGreaterThan(-1);
    const entries = lines.slice(start + 1).filter((line) => line.trim().length > 0);

    // A wrapped entry is a line indented past the command column that names no
    // command, so counting entries against commands finds it without parsing
    // the padding.
    const named = entries.filter((line) =>
      names.some((name) => line.trimStart().startsWith(name)),
    );
    const wrapped = entries.length - named.length;

    expect(wrapped, `${wrapped} index line(s) wrapped onto a second line`).toBe(0);
    expect(named).toHaveLength(names.length);
  });
});
