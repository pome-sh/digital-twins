// SPDX-License-Identifier: Apache-2.0
// `pome --help` is an index: one line per command, answering only "which of
// these do I want". It had grown to 76 lines because 14 of 21 commands
// described themselves in prose there.
//
// Commander prints `.summary()` in the parent's command list and
// `.description()` in the command's own `--help`, so the property worth holding
// is that nothing in the list wraps: a command added later with a paragraph for
// a summary regresses this silently, and nobody re-reads `--help` to notice.

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/main.js";

/** Commander's default when stdout is not a TTY, which is what CI reads. Fixed
 *  here so the assertion does not depend on the terminal running it. */
const HELP_WIDTH = 80;

/** `[entries, named]` from the root's Commands: block: every non-blank line,
 *  and the subset that starts with a command name. A wrapped entry is a line
 *  indented past the command column that names no command, so counting entries
 *  against commands finds it without parsing the padding. */
function indexBlock(program: Command): { entries: string[]; named: string[]; names: string[] } {
  program.configureHelp({ helpWidth: HELP_WIDTH });
  const help = program.createHelp();
  // `visibleCommands` already includes Commander's own `help` entry.
  const names = help.visibleCommands(program).map((cmd: Command) => cmd.name());

  const lines = program.helpInformation().split("\n");
  const start = lines.indexOf("Commands:");
  expect(start, "root --help no longer prints a Commands: block").toBeGreaterThan(-1);
  const entries = lines.slice(start + 1).filter((line) => line.trim().length > 0);
  const named = entries.filter((line) => names.some((name) => line.trimStart().startsWith(name)));
  return { entries, named, names };
}

describe("pome --help", () => {
  it("gives every command exactly one line", () => {
    const { entries, named, names } = indexBlock(createProgram());
    const wrapped = entries.length - named.length;

    expect(wrapped, `${wrapped} index line(s) wrapped onto a second line`).toBe(0);
    expect(named).toHaveLength(names.length);
  });

  // Green on today's tree proves nothing: a 26th command with a paragraph for a
  // summary has to fail, and this is the proof, without mutating main.ts.
  it("fails on a command whose summary is a paragraph", () => {
    const program = new Command("pome");
    program
      .command("verbose")
      .summary(
        "Does a thing, and then explains at length what the thing was, why it was done that way, and what to read next.",
      );
    const { entries, named } = indexBlock(program);
    expect(entries.length - named.length).toBeGreaterThan(0);
  });
});
