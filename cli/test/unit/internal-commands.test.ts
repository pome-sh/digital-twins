// SPDX-License-Identifier: Apache-2.0
// Root `--help` offered `pome health` as "Run an in-process smoke check". What
// it does is boot the GitHub twin, hardcoded, and print that twin's raw health
// JSON, so a reader debugging Slack ran it, read `"ok":true`, and concluded the
// problem was elsewhere. `pome doctor` is the command that checks a user's
// wiring, in prose, with a named cause and a fix.
//
// `health` stays registered and hidden, next to `demo-agent`, because it is the
// one check that runs with no project, manifest or account. The rule below is
// derived rather than a list of two names: a command that calls itself internal
// must not be in root `--help`.

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/main.js";

const INTERNAL_PREFIX = "Internal:";

/** Commander's own answer to "what does `--help` list", rather than reading the
 *  private `_hidden` field a minor upgrade could rename. */
function listedInHelp(program: Command): Command[] {
  const help = program.createHelp();
  return help.visibleCommands(program) as Command[];
}

function rootHelp(): string {
  const program = createProgram();
  program.configureHelp({ helpWidth: 80 });
  return program.helpInformation();
}

function command(name: string): Command {
  const cmd = createProgram().commands.find((c) => c.name() === name);
  if (!cmd) throw new Error(`\`pome ${name}\` is no longer in the command tree`);
  return cmd;
}

describe("internal commands stay out of root --help", () => {
  it("lists no command that calls itself internal", () => {
    const program = createProgram();
    const internal = program.commands.filter((cmd) =>
      cmd.description().startsWith(INTERNAL_PREFIX),
    );
    const listed = new Set(listedInHelp(program).map((cmd) => cmd.name()));

    expect(internal.length, "no command declares itself internal any more").toBeGreaterThan(0);
    for (const cmd of internal) {
      expect(listed.has(cmd.name()), `${cmd.name()} says it is internal but --help lists it`).toBe(
        false,
      );
    }
  });

  it("keeps both internal commands registered", () => {
    // Hidden, not deleted. `health` is the only way to ask "can this install
    // boot a twin at all" with no project, manifest or account, which is why it
    // is not folded into `pome doctor`, and `demo-agent` is the child `pome
    // demo` spawns. A later cleanup should not quietly drop either.
    for (const name of ["health", "demo-agent"]) {
      expect(command(name).description()).toContain(INTERNAL_PREFIX);
    }
  });

  it("names the one twin `health` speaks for", () => {
    // The old description implied it covered whatever a reader was debugging.
    expect(command("health").description()).toMatch(/github/i);
  });

  it("prints neither in the rendered root help", () => {
    // The rendered text, not the model: this is what a reader sees.
    const lines = rootHelp().split("\n");
    for (const name of ["health", "demo-agent"]) {
      expect(
        lines.filter((line) => line.trimStart().startsWith(name)),
        `${name} is listed in root --help`,
      ).toHaveLength(0);
    }
  });
});
