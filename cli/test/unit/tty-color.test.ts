// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

import { runChecksCommand } from "../../src/cli/checks.js";
import { runDocsCommand } from "../../src/cli/docs.js";
import { runTasksCommand } from "../../src/cli/tasks.js";
import { bold, dim, useColor } from "../../src/cli/tty-color.js";

const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

function setTty(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  value: boolean | undefined,
): void {
  Object.defineProperty(stream, "isTTY", {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function restoreTty(): void {
  if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
}

function captureConsole(): { log: string[]; error: string[] } {
  const captured = { log: [] as string[], error: [] as string[] };
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.log.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    captured.error.push(args.map(String).join(" "));
  });
  return captured;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  restoreTty();
});

describe("tty-color", () => {
  it("wraps dim and bold only on a TTY when NO_COLOR is unset", () => {
    setTty(process.stdout, true);
    vi.stubEnv("NO_COLOR", "");

    expect(useColor()).toBe(true);
    expect(dim("hint")).toBe("\x1b[2mhint\x1b[0m");
    expect(bold("title")).toBe("\x1b[1mtitle\x1b[0m");
  });

  it("stays plain when stdout is not a TTY", () => {
    setTty(process.stdout, false);
    vi.stubEnv("NO_COLOR", "");

    expect(useColor()).toBe(false);
    expect(dim("hint")).toBe("hint");
    expect(bold("title")).toBe("title");
  });

  it("stays plain on a TTY when NO_COLOR is set", () => {
    setTty(process.stdout, true);
    vi.stubEnv("NO_COLOR", "1");

    expect(useColor()).toBe(false);
    expect(dim("hint")).toBe("hint");
    expect(bold("title")).toBe("title");
  });
});

describe("listing commands keep the same TTY / NO_COLOR output", () => {
  it("pome tasks colors the index on a TTY and stays plain under NO_COLOR", async () => {
    setTty(process.stdout, true);
    vi.stubEnv("NO_COLOR", "");
    const colored = captureConsole();
    await runTasksCommand(undefined, {});
    expect(colored.log[0]).toBe("\x1b[1mPome tasks\x1b[0m");
    expect(colored.log[1]).toBe("\x1b[2mBundled task library, grouped by twin.\x1b[0m");

    vi.restoreAllMocks();
    vi.stubEnv("NO_COLOR", "1");
    const plain = captureConsole();
    await runTasksCommand(undefined, {});
    expect(plain.log[0]).toBe("Pome tasks");
    expect(plain.log[1]).toBe("Bundled task library, grouped by twin.");
    expect(plain.log.join("\n")).not.toMatch(/\x1b\[/);
  });

  it("pome checks colors the index on a TTY and stays plain under NO_COLOR", async () => {
    setTty(process.stdout, true);
    vi.stubEnv("NO_COLOR", "");
    const colored = captureConsole();
    await runChecksCommand(undefined, {});
    expect(colored.log[0]).toBe("\x1b[1mPome checks\x1b[0m");
    expect(colored.log[1]).toBe("\x1b[2mTwins that declare an assertable vocabulary.\x1b[0m");

    vi.restoreAllMocks();
    vi.stubEnv("NO_COLOR", "1");
    const plain = captureConsole();
    await runChecksCommand(undefined, {});
    expect(plain.log[0]).toBe("Pome checks");
    expect(plain.log[1]).toBe("Twins that declare an assertable vocabulary.");
    expect(plain.log.join("\n")).not.toMatch(/\x1b\[/);
  });

  it("pome docs colors the index on a TTY and stays plain under NO_COLOR", async () => {
    // stdout TTY + stdin not TTY is the non-interactive listing, which still
    // wraps titles. Both TTYs would enter the readline loop.
    setTty(process.stdout, true);
    setTty(process.stdin, false);
    vi.stubEnv("NO_COLOR", "");
    const colored = captureConsole();
    await runDocsCommand(undefined, {});
    expect(colored.log[0]).toBe("\x1b[1mPome docs\x1b[0m");
    expect(colored.log[1]).toContain("\x1b[2m");

    vi.restoreAllMocks();
    vi.stubEnv("NO_COLOR", "1");
    const plain = captureConsole();
    await runDocsCommand(undefined, {});
    expect(plain.log[0]).toBe("Pome docs");
    expect(plain.log.join("\n")).not.toMatch(/\x1b\[/);
  });
});
