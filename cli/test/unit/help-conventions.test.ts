// SPDX-License-Identifier: Apache-2.0
// One help convention this milestone established, as a gate.
//
// Machine-readable output is `--json`, boolean. `pome sandbox create` and
// `sandbox list` took `--format text|json`, and create had a third mode, `env`,
// that printed nothing at all. Deleting `--format` cost a release; nothing
// stopped it, or the next spelling of it, coming back.
//
// This asserts SHAPE, never truth: a gate cannot know whether a help string is
// accurate. `--twin`'s help omitted `linear` while the code allowed it, and no
// rule here would have caught that — it stays a human review.
//
// The arm is a pure function over a Command, so the self-test can build a
// deliberately-violating program in memory and prove it goes RED. Green on
// today's tree proves nothing.

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/main.js";

/** Every command in the tree, including subcommands and hidden ones. */
function allCommands(root: Command): Command[] {
  return [root, ...root.commands.flatMap((cmd) => allCommands(cmd))];
}

function path(cmd: Command): string {
  const names: string[] = [];
  for (let node: Command | null = cmd; node; node = node.parent) names.unshift(node.name());
  return names.join(" ");
}

/**
 * No option asks for machine-readable output by any name but `--json`, and
 * `--json` never takes an argument — a `--json <mode>` would smuggle the
 * `--format` enum back in under the surviving name.
 */
function machineOutputSpellings(root: Command): string[] {
  const violations: string[] = [];
  for (const cmd of allCommands(root)) {
    for (const opt of cmd.options) {
      // Not `=== "--format"`: the defect class is an output mode spelled some
      // other way, and `--output-format` is the obvious next spelling.
      if (opt.long && (/format/.test(opt.long) || opt.long === "--fmt")) {
        violations.push(`${path(cmd)} ${opt.flags}: machine-readable output is --json`);
      }
      if (opt.long === "--json" && (opt.required || opt.optional)) {
        violations.push(`${path(cmd)} ${opt.flags}: --json takes no argument`);
      }
    }
  }
  return violations;
}

describe("machine-readable output is spelled one way", () => {
  it("holds for every option in the command tree", () => {
    expect(machineOutputSpellings(createProgram())).toEqual([]);
  });

  it("fails on every other spelling, and on a --json that takes an argument", () => {
    const program = new Command("pome")
      .option("--format <fmt>", "Output format")
      .option("--output-format <fmt>", "Output format")
      .option("--fmt <fmt>", "Output format")
      .option("--json <mode>", "How much JSON");
    expect(machineOutputSpellings(program)).toHaveLength(4);
  });

  it("finds a violation on a nested subcommand, not just the root", () => {
    const program = new Command("pome");
    program.command("twin").command("status").option("--format <fmt>", "Output format");
    expect(machineOutputSpellings(program)).toEqual([
      "pome twin status --format <fmt>: machine-readable output is --json",
    ]);
  });
});
