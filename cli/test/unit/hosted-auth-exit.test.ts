// SPDX-License-Identifier: Apache-2.0
// Hosted commands must map missing/rejected credentials through exitCodeFor
// (3), not a catch-all twin/orch 2. sandbox stop already does; create, list,
// and register agent now share that mapper.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runSessionCreate: vi.fn(async () => {}),
  runSessionList: vi.fn(async () => {}),
  runRegisterAgent: vi.fn(async () => {}),
}));

vi.mock("../../src/cli/session.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/cli/session.js")>();
  return {
    ...actual,
    runSessionCreate: mocks.runSessionCreate,
    runSessionList: mocks.runSessionList,
  };
});

vi.mock("../../src/cli/register.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/cli/register.js")>();
  return {
    ...actual,
    runRegisterAgent: mocks.runRegisterAgent,
  };
});

import { createProgram } from "../../src/cli/main.js";
import {
  HostedAuthError,
  HostedOrchError,
  HostedQuotaError,
} from "../../src/hosted/errors.js";

describe("hosted command auth exit codes", () => {
  const originalExitCode = process.exitCode;
  let stderr: string[];

  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockClear();
      mock.mockResolvedValue(undefined);
    }
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      stderr.push(String(msg));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  async function run(argv: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "pome", ...argv]);
  }

  const CASES: Array<{
    name: string;
    argv: string[];
    runner: keyof typeof mocks;
  }> = [
    {
      name: "sandbox create",
      argv: ["sandbox", "create", "--twin", "github"],
      runner: "runSessionCreate",
    },
    {
      name: "sandbox list",
      argv: ["sandbox", "list"],
      runner: "runSessionList",
    },
    {
      name: "register agent",
      argv: ["register", "agent", "triage-bot"],
      runner: "runRegisterAgent",
    },
  ];

  for (const { name, argv, runner } of CASES) {
    it(`${name}: missing credentials → exit 3 and the login remediation`, async () => {
      mocks[runner].mockRejectedValueOnce(
        new HostedAuthError(
          "Hosted mode requires authentication. Run `pome login`.",
        ),
      );

      await run(argv);

      expect(process.exitCode).toBe(3);
      const err = stderr.join("\n");
      expect(err).toMatch(/pome login/i);
      expect(err).toMatch(/POME_API_KEY/);
    });

    it(`${name}: rejected API key → exit 3 and the login remediation`, async () => {
      mocks[runner].mockRejectedValueOnce(new HostedAuthError("bad key"));

      await run(argv);

      expect(process.exitCode).toBe(3);
      const err = stderr.join("\n");
      expect(err).toContain("bad key");
      expect(err).toMatch(/pome login/i);
      expect(err).toMatch(/POME_API_KEY/);
    });

    it(`${name}: twin/orch error stays exit 2`, async () => {
      mocks[runner].mockRejectedValueOnce(new HostedOrchError("spawn failed"));

      await run(argv);

      expect(process.exitCode).toBe(2);
      expect(stderr.join("\n")).toContain("spawn failed");
    });
  }

  it("sandbox create: quota stays exit 4", async () => {
    mocks.runSessionCreate.mockRejectedValueOnce(
      new HostedQuotaError("over limit"),
    );

    await run(["sandbox", "create", "--twin", "github"]);

    expect(process.exitCode).toBe(4);
    expect(stderr.join("\n")).toMatch(/over limit/);
  });
});
