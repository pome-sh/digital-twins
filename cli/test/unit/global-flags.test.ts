// SPDX-License-Identifier: Apache-2.0
// `--api-url` and `--artifacts-dir` were declared 13 times across 10 commands,
// which is how one of them ended up with an extra env var (POME_API_BASE) at
// higher precedence than POME_API_URL. They are program-level now.
//
// Tree-walking on purpose: the next command to be added is covered the day it
// is added, and a hand-picked list of "control-plane talkers" is the same
// hand-maintained list this deletes.

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

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

const GLOBAL_FLAGS = ["--api-url", "--artifacts-dir"];

/** Every command in the tree that declares `flag` itself. */
function declaredBy(root: Command, flag: string): string[] {
  return allCommands(root)
    .filter((cmd) => cmd.options.some((opt) => opt.long === flag))
    .map(path);
}

describe("program-level flags", () => {
  const saved = process.env.POME_API_URL;

  afterEach(() => {
    if (saved === undefined) delete process.env.POME_API_URL;
    else process.env.POME_API_URL = saved;
  });

  it.each(GLOBAL_FLAGS)("%s is declared exactly once, on the root", (flag) => {
    expect(declaredBy(createProgram(), flag)).toEqual(["pome"]);
  });

  // Green on today's tree proves nothing: the defect this gate exists for is a
  // subcommand re-declaring the flag, so declare one and see it named.
  it.each(GLOBAL_FLAGS)("%s: a subcommand re-declaring it is caught", (flag) => {
    const program = new Command("pome").option(`${flag} <value>`, "Root copy");
    program.command("run").option(`${flag} <value>`, "Second copy");
    expect(declaredBy(program, flag)).toEqual(["pome", "pome run"]);
  });

  // `program.configureHelp({ showGlobalOptions: true })` is the only reason these
  // stay discoverable once they are declared on the root alone. Commander's
  // `configureHelp` REPLACES its configuration rather than merging, so a second
  // call anywhere in `createProgram()` would silently drop both flags out of
  // every subcommand's help with nothing else failing.
  it.each(GLOBAL_FLAGS)("%s still renders on a subcommand's --help", (flag) => {
    const program = createProgram();
    const run = program.commands.find((cmd) => cmd.name() === "run");
    expect(run, "pome run is no longer registered").toBeDefined();
    expect(run!.helpInformation()).toContain(flag);
  });

  it("honours POME_API_URL on every command at every depth", () => {
    process.env.POME_API_URL = "https://api.test.invalid";
    for (const cmd of allCommands(createProgram())) {
      const opts = cmd.optsWithGlobals();
      expect(opts.apiUrl, `${path(cmd)} apiUrl`).toBe("https://api.test.invalid");
      expect(opts.artifactsDir, `${path(cmd)} artifactsDir`).toBe("runs");
    }
  });
});
