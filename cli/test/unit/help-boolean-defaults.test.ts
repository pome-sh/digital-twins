// SPDX-License-Identifier: Apache-2.0
// An explicit `false` on a boolean flag makes Commander print
// `(default: false)` and wrap the help line. The off state is the absent
// flag; the annotation names something nobody would guess otherwise.
//
// Tree-wide because the defect is a class, not one command's leftover
// third argument. The self-test builds a violating program in memory so
// green on today's tree is not the only evidence the predicate works.

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runTwinTapeCommand: vi.fn(async () => {}),
  runChecksCommand: vi.fn(async () => {}),
  runCompileSeeds: vi.fn(async () => 0),
  runSessionCreate: vi.fn(async () => {}),
  runSessionList: vi.fn(async () => {}),
}));

vi.mock("../../src/twin/twinTape.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/twin/twinTape.js")>();
  return { ...actual, runTwinTapeCommand: mocks.runTwinTapeCommand };
});

vi.mock("../../src/cli/checks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/checks.js")>();
  return { ...actual, runChecksCommand: mocks.runChecksCommand };
});

vi.mock("../../src/cli/compile-seeds.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/compile-seeds.js")>();
  return { ...actual, runCompileSeeds: mocks.runCompileSeeds };
});

vi.mock("../../src/cli/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/session.js")>();
  return {
    ...actual,
    runSessionCreate: mocks.runSessionCreate,
    runSessionList: mocks.runSessionList,
  };
});

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

/** Boolean options that carry an explicit false default — the class that
 *  burns a help line on `(default: false)`. */
function booleanFalseDefaults(root: Command): string[] {
  const violations: string[] = [];
  for (const cmd of allCommands(root)) {
    for (const opt of cmd.options) {
      if (opt.isBoolean() && opt.defaultValue === false) {
        violations.push(`${path(cmd)} ${opt.flags} carries default false`);
      }
    }
  }
  return violations;
}

function program(): Command {
  const root = createProgram();
  const walk = (cmd: Command) => {
    cmd.exitOverride();
    cmd.commands.forEach(walk);
  };
  walk(root);
  return root;
}

function helpFor(...argv: string[]): string {
  const chunks: string[] = [];
  const root = program();
  const walk = (cmd: Command) => {
    cmd.configureOutput({
      writeOut: (s) => void chunks.push(s),
      writeErr: (s) => void chunks.push(s),
    });
    cmd.commands.forEach(walk);
  };
  walk(root);
  try {
    root.parse(["node", "pome", ...argv]);
  } catch (err) {
    if ((err as { code?: string }).code !== "commander.helpDisplayed") throw err;
  }
  return chunks.join("");
}

describe("boolean flags do not render (default: false)", () => {
  it("holds for every boolean option in the command tree", () => {
    expect(booleanFalseDefaults(createProgram())).toEqual([]);
  });

  it("fails on a boolean option that carries false", () => {
    const violating = new Command("pome").option("--json", "as JSON", false);
    expect(booleanFalseDefaults(violating)).toEqual([
      "pome --json carries default false",
    ]);
  });

  it.each([
    { argv: ["twin", "tape"], flag: "--json" },
    { argv: ["checks"], flag: "--json" },
    { argv: ["compile-seeds"], flag: "--force" },
    { argv: ["sandbox", "create"], flag: "--json" },
    { argv: ["sandbox", "list"], flag: "--json" },
  ])("$argv help does not annotate a false default", ({ argv, flag }) => {
    const help = helpFor(...argv, "--help");
    expect(help).toContain(flag);
    expect(help).not.toContain("(default: false)");
  });
});

describe("omitted boolean flags stay false", () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  it("pome twin tape without --json/--diff keeps both off", async () => {
    await program().parseAsync(["node", "pome", "twin", "tape"]);
    expect(mocks.runTwinTapeCommand).toHaveBeenCalledWith(undefined, {
      diff: false,
      json: false,
    });
  });

  it("pome twin tape --json --diff turns both on", async () => {
    await program().parseAsync(["node", "pome", "twin", "tape", "--json", "--diff"]);
    expect(mocks.runTwinTapeCommand).toHaveBeenCalledWith(undefined, {
      diff: true,
      json: true,
    });
  });

  it("pome checks without --json keeps json off", async () => {
    await program().parseAsync(["node", "pome", "checks", "github"]);
    expect(mocks.runChecksCommand).toHaveBeenCalledWith("github", { json: false });
  });

  it("pome checks --json turns json on", async () => {
    await program().parseAsync(["node", "pome", "checks", "github", "--json"]);
    expect(mocks.runChecksCommand).toHaveBeenCalledWith("github", { json: true });
  });

  it("pome compile-seeds without --force keeps force off", async () => {
    await program().parseAsync(["node", "pome", "compile-seeds"]);
    expect(mocks.runCompileSeeds).toHaveBeenCalledWith(undefined, { force: false });
  });

  it("pome compile-seeds --force turns force on", async () => {
    await program().parseAsync(["node", "pome", "compile-seeds", "--force"]);
    expect(mocks.runCompileSeeds).toHaveBeenCalledWith(undefined, { force: true });
  });

  it("pome sandbox create without --json keeps json off", async () => {
    await program().parseAsync(["node", "pome", "sandbox", "create", "--twin", "github"]);
    expect(mocks.runSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ json: false, twins: ["github"] }),
    );
  });

  it("pome sandbox list without --json keeps json off", async () => {
    await program().parseAsync(["node", "pome", "sandbox", "list"]);
    expect(mocks.runSessionList).toHaveBeenCalledWith(expect.objectContaining({ json: false }));
  });
});
