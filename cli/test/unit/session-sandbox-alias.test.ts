// SPDX-License-Identifier: Apache-2.0
// `pome sandbox` is an ALIAS of `pome session`, never a second command tree.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";

const mocks = vi.hoisted(() => ({
  runSessionCreate: vi.fn(async () => {}),
  runSessionList: vi.fn(async () => {}),
  runSessionStop: vi.fn(async () => {}),
}));

vi.mock("../../src/cli/session.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/cli/session.js")>();
  return {
    ...actual,
    runSessionCreate: mocks.runSessionCreate,
    runSessionList: mocks.runSessionList,
    runSessionStop: mocks.runSessionStop,
  };
});

import { createProgram } from "../../src/cli/main.js";

/**
 * An unknown command and `--help` both call `process.exit()`, which would take
 * the vitest worker down instead of failing the assertion. `exitOverride()`
 * only reaches the commands that existed when it was called, so walk the tree
 * the program already built.
 */
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
    // `--help` exits through exitOverride once the text is already written.
    if ((err as { code?: string }).code !== "commander.helpDisplayed") throw err;
  }
  return chunks.join("");
}

type Runner = keyof typeof mocks;

/** The arguments `spelling` handed the runner — proof of which code path ran. */
async function dispatch(
  spelling: string,
  runner: Runner,
  argv: string[],
): Promise<unknown[]> {
  mocks[runner].mockClear();
  await program().parseAsync(["node", "pome", spelling, ...argv]);
  expect(mocks[runner]).toHaveBeenCalledTimes(1);
  return mocks[runner].mock.calls[0]!;
}

describe("`pome sandbox` aliases `pome session`", () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockClear();
      mock.mockResolvedValue(undefined);
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  // Flags are carried on every case so a spelling that reached a *different*
  // parser — its own command tree with drifted defaults — shows up as an
  // argument diff rather than passing on the bare form.
  const CASES: Array<{ name: string; runner: Runner; argv: string[] }> = [
    {
      name: "create",
      runner: "runSessionCreate",
      argv: [
        "create",
        "--twin",
        "github",
        "--twin",
        "gmail",
        "--format",
        "json",
        "--api-url",
        "https://api.example.test",
      ],
    },
    {
      name: "list",
      runner: "runSessionList",
      argv: ["list", "--state", "all", "--limit", "5", "--format", "json"],
    },
    {
      name: "stop",
      runner: "runSessionStop",
      argv: ["stop", "ses_a", "--discard"],
    },
    // The `stop` → `kill` alias nests under the outer one; both spellings of
    // both levels have to compose.
    {
      name: "stop's own `kill` alias",
      runner: "runSessionStop",
      argv: ["kill", "ses_a", "--discard"],
    },
  ];

  for (const { name, runner, argv } of CASES) {
    it(`sandbox ${name} calls the same runner with the same arguments as session ${name}`, async () => {
      const viaSandbox = await dispatch("sandbox", runner, argv);
      const viaSession = await dispatch("session", runner, argv);

      expect(viaSandbox).toEqual(viaSession);
      expect(process.exitCode).toBeUndefined();
    });
  }

  it("is one command object, not a second tree", () => {
    const answering = program().commands.filter(
      (cmd) =>
        [cmd.name(), ...cmd.aliases()].includes("session") ||
        [cmd.name(), ...cmd.aliases()].includes("sandbox"),
    );

    expect(answering).toHaveLength(1);
    expect(answering[0]!.name()).toBe("session");
    expect(answering[0]!.aliases()).toContain("sandbox");
  });

  it("`pome --help` lists the sandbox spelling", () => {
    expect(helpFor("--help")).toContain("session|sandbox");
  });

  it("`pome sandbox --help` lists it, and is byte-identical to `pome session --help`", () => {
    const viaSandbox = helpFor("sandbox", "--help");

    expect(viaSandbox).toContain("session|sandbox");
    expect(viaSandbox).toBe(helpFor("session", "--help"));
    // Every subcommand is reachable under the alias, not just the ones the
    // dispatch cases above happen to name.
    for (const sub of ["create", "list", "stop"]) {
      expect(viaSandbox).toContain(sub);
    }
  });
});
