// SPDX-License-Identifier: Apache-2.0
// `pome run --help` is a reference card: someone reading it is checking a
// spelling, not learning how trial groups bill. It had grown to 44 lines, of
// which `-n/--trials` alone was a 90-word paragraph covering the 1 to 20 range,
// the plan quota, slot reuse, the verdict table and three exit codes.
//
// Those facts are not deleted, they live on the `pome run` reference page, which
// the command description points at by topic id. So the assertions below hold
// both halves: the card stays short, and the pointer off it resolves.

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/main.js";
import { DOCS_TOPICS } from "../../src/cli/docs-topics.js";

const HELP_WIDTH = 80;
/** The card fits a short terminal, counting every rendered line so the number
 *  is the one a reader sees. A budget, not a measurement: it fails when prose
 *  moves back into the help. */
const MAX_LINES = 26;
/** Rendered height of the description above `Arguments:`. Capped too, because
 *  the per-flag cap below cannot see prose that lands there instead. */
const MAX_DESCRIPTION_LINES = 4;
/** Two rendered lines is the ceiling for one flag. A third means the text is
 *  explaining rather than naming. */
const MAX_LINES_PER_OPTION = 2;

function runCommand(): Command {
  const cmd = createProgram().commands.find((c) => c.name() === "run");
  if (!cmd) throw new Error("`pome run` is no longer in the command tree");
  cmd.configureHelp({ helpWidth: HELP_WIDTH });
  return cmd;
}

/** The lines as printed: `helpInformation()` ends with a newline, which split
 *  turns into a trailing empty element that no reader ever sees. */
function helpLines(): string[] {
  const lines = runCommand().helpInformation().split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Rendered height of each entry in the Options block, keyed by its flags
 *  string. An entry line is indented two spaces and starts with the flag; a
 *  continuation line is indented past the flag column. */
function optionHeights(): Map<string, number> {
  const flags = runCommand().options.map((opt) => opt.flags);
  const lines = helpLines();
  const start = lines.indexOf("Options:");
  expect(start, "run --help no longer prints an Options: block").toBeGreaterThan(-1);

  const heights = new Map<string, number>();
  let current: string | undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0) continue;
    if (/^ {2}\S/.test(line)) {
      // Match the whole flags string, not its first token: `--agent` is a prefix
      // of `--agent-model`, and a prefix match silently folds one into the other.
      current = flags.find((flag) => line.startsWith(`  ${flag}`));
      if (current) heights.set(current, 1);
      continue;
    }
    if (current) heights.set(current, heights.get(current)! + 1);
  }
  return heights;
}

describe("pome run --help is a reference card", () => {
  it("fits in a short terminal", () => {
    const lines = helpLines();
    expect(lines.length, `run --help is ${lines.length} lines, over ${MAX_LINES}`)
      .toBeLessThanOrEqual(MAX_LINES);
  });

  it("keeps the description above the flag list short too", () => {
    const lines = helpLines();
    const described = lines.slice(2, lines.indexOf("Arguments:")).filter((l) => l.trim() !== "");
    expect(
      described.length,
      `run's description renders ${described.length} lines, over ${MAX_DESCRIPTION_LINES}`,
    ).toBeLessThanOrEqual(MAX_DESCRIPTION_LINES);
  });

  it("keeps every flag to two lines at most", () => {
    const heights = optionHeights();
    expect(heights.size).toBe(runCommand().options.length);

    for (const [flag, height] of heights) {
      expect(height, `${flag} renders ${height} lines`).toBeLessThanOrEqual(MAX_LINES_PER_OPTION);
    }
  });

  it("still names what -n takes and where its default comes from", () => {
    // Short is not the goal on its own: the two facts a reader needs at the
    // flag list are the accepted range and what happens if they omit it.
    const trials = runCommand().options.find((opt) => opt.long === "--trials");
    expect(trials).toBeDefined();
    expect(trials!.description).toMatch(/1 to 20/);
    expect(trials!.description).toMatch(/`runs` field/);
  });

  it("points at a docs topic that exists", () => {
    // The long form moved to the reference page. A pointer at a topic id the
    // CLI cannot resolve would strand it there.
    const referenced = [...runCommand().description().matchAll(/`pome docs ([a-z0-9-]+)`/g)].map(
      (match) => match[1]!,
    );

    expect(referenced.length, "run's description points at no docs topic").toBeGreaterThan(0);
    for (const id of referenced) {
      expect(
        DOCS_TOPICS.some((topic) => topic.id === id),
        `\`pome docs ${id}\` names no topic in DOCS_TOPICS`,
      ).toBe(true);
    }
  });
});
