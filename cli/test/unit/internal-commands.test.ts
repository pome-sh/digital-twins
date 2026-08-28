// SPDX-License-Identifier: Apache-2.0
// Root `--help` offered `pome health` as "Run an in-process smoke check". What
// it does is boot the GitHub twin, hardcoded, and print that twin's raw health
// JSON. So a reader debugging slack ran it, read `"ok":true`, and concluded the
// problem was elsewhere. `pome doctor` is the command that checks a user's
// wiring, in prose, with a named cause and a fix.
//
// `health` is a liveness probe for CI and for a contributor checking that an
// install can boot a twin at all, so it stays registered and hidden, next to
// `demo-agent`. The rule below is derived rather than a list of two names: a
// command that calls itself internal must not be in the index.

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/main.js";

function isHidden(cmd: Command): boolean {
  return Boolean((cmd as unknown as { _hidden?: boolean })._hidden);
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

describe("internal commands stay out of the index", () => {
  it("hides every command that calls itself internal", () => {
    const internal = createProgram().commands.filter((cmd) =>
      cmd.description().startsWith("Internal:"),
    );

    expect(internal.length, "no command declares itself internal any more").toBeGreaterThan(0);
    for (const cmd of internal) {
      expect(isHidden(cmd), `${cmd.name()} says it is internal but is listed in --help`).toBe(true);
    }
  });

  it("keeps `health` registered, so CI and a contributor can still run it", () => {
    // Hidden, not deleted: this is the one command that answers "can this
    // install boot a twin at all" without a project, a manifest or an account.
    expect(isHidden(command("health"))).toBe(true);
  });

  it("names the one twin `health` speaks for", () => {
    // The old description implied it covered whatever a reader was debugging.
    expect(command("health").description()).toMatch(/github/i);
  });

  it("lists neither internal command in root --help", () => {
    const lines = rootHelp().split("\n");
    for (const name of ["health", "demo-agent"]) {
      expect(
        lines.filter((line) => line.trimStart().startsWith(name)),
        `${name} is listed in root --help`,
      ).toHaveLength(0);
    }
  });
});
