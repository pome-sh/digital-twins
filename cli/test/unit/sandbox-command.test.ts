// SPDX-License-Identifier: Apache-2.0
// `pome sandbox` is the ONLY spelling of this command tree, and `stop` is the
// only spelling of its third subcommand.
//
// Two halves, both load-bearing. The dispatch cases prove every subcommand still
// reaches its runner with each flag intact. The absence cases pin that no command
// anywhere answers to `session` or `kill`, because a command alias is the kind of
// convenience that gets re-added by a reviewer being helpful, and
// VOCABULARY.md bans user-facing `session` outright.
//
// `session_id`, `/v1/sessions` and the `ses_` prefix are the WIRE, and are a
// different thing from a command name a human types.

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

describe("`pome sandbox` is the only spelling", () => {
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

  // Flags are carried on every case so a subcommand that lost one shows up as an
  // argument diff rather than passing on the bare form.
  const CASES: Array<{ name: string; runner: Runner; argv: string[]; expect: unknown[] }> = [
    {
      name: "create",
      runner: "runSessionCreate",
      argv: [
        "create",
        "--twin",
        "github",
        "--twin",
        "gmail",
        "--json",
        "--api-url",
        "https://api.example.test",
      ],
      expect: [
        expect.objectContaining({
          twins: ["github", "gmail"],
          json: true,
          apiBaseUrl: "https://api.example.test",
        }),
      ],
    },
    {
      name: "list",
      runner: "runSessionList",
      argv: ["list", "--state", "all", "--limit", "5", "--json"],
      expect: [expect.objectContaining({ state: "all", limit: 5, json: true })],
    },
    {
      name: "stop",
      runner: "runSessionStop",
      argv: ["stop", "ses_a", "--discard"],
      expect: [expect.objectContaining({ sessionId: "ses_a", discard: true })],
    },
  ];

  for (const { name, runner, argv, expect: expected } of CASES) {
    it(`sandbox ${name} reaches its runner with every flag intact`, async () => {
      const call = await dispatch("sandbox", runner, argv);
      expect(call).toMatchObject(expected);
      expect(process.exitCode).toBeUndefined();
    });
  }

  it("is one command, named for the product noun", () => {
    const answering = program().commands.filter((cmd) =>
      [cmd.name(), ...cmd.aliases()].includes("sandbox"),
    );

    expect(answering).toHaveLength(1);
    expect(answering[0]!.name()).toBe("sandbox");
    expect(answering[0]!.aliases()).toEqual([]);
  });

  it("no command anywhere answers to `session` or `kill`", () => {
    const spellings: string[] = [];
    const walk = (cmd: Command): void => {
      for (const sub of cmd.commands) {
        spellings.push(sub.name(), ...sub.aliases());
        walk(sub);
      }
    };
    walk(program());

    expect(spellings).not.toContain("session");
    expect(spellings).not.toContain("kill");
  });

  it("`pome --help` shows one spelling, not two", () => {
    const help = helpFor("--help");

    expect(help).toContain("sandbox");
    expect(help).not.toContain("session|sandbox");
  });

  it("`pome sandbox --help` reaches every subcommand", () => {
    const help = helpFor("sandbox", "--help");

    for (const sub of ["create", "list", "stop"]) {
      expect(help).toContain(sub);
    }
    expect(help).not.toContain("kill");
  });
});
