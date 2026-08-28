// SPDX-License-Identifier: Apache-2.0
// `pome --help` is the first thing a new user runs, and it is an index: it
// answers "which command do I want", nothing more. It grew to 76 lines because
// six commands described themselves in prose there — `run` alone took 6 lines,
// `demo` and `fix-prompt` 8 each — so the list did not fit on one screen.
//
// Commander prints `.summary()` in the parent's command list and `.description()`
// in the command's own `--help`. The assertions below hold that split: nothing in
// the index wraps, and no fact moved out of the index was deleted rather than
// relocated.

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/main.js";

/** A fixed help width, so the assertions do not depend on the terminal that
 *  runs them. 80 columns is Commander's own default when stdout is not a TTY,
 *  which is what CI reads. */
const HELP_WIDTH = 80;

/** Width of the description column at HELP_WIDTH: two spaces of indent, the
 *  longest command term, two spaces of gutter, then the text. A summary longer
 *  than this wraps onto a second line, which is the defect. */
function indexTextWidth(program: Command): number {
  const longestTerm = Math.max(
    ...visible(program).map((cmd) => `${cmd.name()} ${cmd.usage()}`.trim().length),
  );
  return HELP_WIDTH - (2 + longestTerm + 2);
}

function visible(program: Command): Command[] {
  return program.commands.filter(
    (cmd) => !(cmd as unknown as { _hidden?: boolean })._hidden && cmd.name() !== "help",
  );
}

function help(cmd: Command): string {
  cmd.configureHelp({ helpWidth: HELP_WIDTH });
  return cmd.helpInformation();
}

/** The lines of the `Commands:` block, which is the index itself. */
function indexLines(program: Command): string[] {
  const lines = help(program).split("\n");
  const start = lines.findIndex((line) => line === "Commands:");
  expect(start, "root --help no longer prints a Commands: block").toBeGreaterThan(-1);
  return lines.slice(start + 1).filter((line) => line.trim().length > 0);
}

describe("pome --help is a one-screen index", () => {
  it("gives each command exactly one line", () => {
    const program = createProgram();
    // Commander appends its own `help` entry, which is part of the index.
    const names = [...visible(program).map((cmd) => cmd.name()), "help"];
    // A wrapped entry shows up as a line that starts past the term column and
    // names no command, so counting entry lines against commands catches it
    // without parsing the padding.
    const entries = indexLines(program).filter((line) =>
      names.some((name) => line.trimStart().startsWith(name)),
    );
    const wrapped = indexLines(program).length - entries.length;

    expect(wrapped, `${wrapped} index line(s) wrapped onto a second line`).toBe(0);
    expect(entries).toHaveLength(names.length);
  });

  it("fits on one screen", () => {
    // 40 lines is a conservative floor for a default terminal. The number is a
    // budget, not a measurement: it fails when the index grows prose again.
    expect(help(createProgram()).split("\n").length).toBeLessThanOrEqual(40);
  });

  it("keeps every index entry short enough not to wrap", () => {
    const program = createProgram();
    const limit = indexTextWidth(program);

    for (const cmd of visible(program)) {
      const text = cmd.summary() || cmd.description();
      expect(text, `${cmd.name()} has no index text`).not.toBe("");
      expect(text.length, `${cmd.name()}'s index text is ${text.length} chars, over ${limit}`)
        .toBeLessThanOrEqual(limit);
      expect(text, `${cmd.name()}'s index text spans lines`).not.toContain("\n");
    }
  });

  it("keeps caveats and cross-references out of the index", () => {
    for (const cmd of visible(createProgram())) {
      const text = cmd.summary() || cmd.description();
      expect(text, `${cmd.name()}'s index text carries a parenthetical`).not.toMatch(/[()]/);
      expect(text, `${cmd.name()}'s index text points at another command`).not.toMatch(/`pome /);
    }
  });

  it("keeps a fuller description behind every shortened entry", () => {
    // A summary earns its place only where the description does not fit the
    // index. Where one exists, the long form must still be there one level
    // down: without this, "shorten the index" and "delete the prose" pass the
    // same assertions.
    const summarised = visible(createProgram()).filter((cmd) => cmd.summary() !== "");

    expect(summarised.length).toBeGreaterThan(0);
    for (const cmd of summarised) {
      expect(cmd.description(), `${cmd.name()} has a summary but no description`).not.toBe("");
      expect(cmd.summary(), `${cmd.name()}'s summary only repeats its description`).not.toBe(
        cmd.description(),
      );
      expect(help(cmd), `${cmd.name()} --help does not print its description`).toContain(
        cmd.description().split("\n")[0]!.slice(0, 30),
      );
    }
  });
});
