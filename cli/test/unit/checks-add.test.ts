// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handshake, runChecksAddCommand } from "../../src/cli/checks-add.js";
import { checksFor, localDigest } from "../../src/cli/checks.js";

// The menu position of the check these tests pick. Derived, never hard-coded:
// the vocabulary is a CLOSED SET THAT GROWS — F-1075 took github from 1 check
// to 11 and A3 will widen the other twins — so a literal "1" here asserts the
// size of the set rather than the behaviour of the picker.
const PICK = String(
  checksFor("github").findIndex((check) => check.id === "github.no-new-labels") + 1,
);

const tempDirs: string[] = [];
const captured = { log: [] as string[], error: [] as string[] };
const savedCi = process.env.CI;

const TASK = `# Task 03 — Already triaged

## Prompt

Triage issue #1 in acme/api.

## Success Criteria

- [code] Issue #1 is still assigned to \`alice\`

## Config

\`\`\`yaml
twins: [github]
\`\`\`
`;

async function taskFile(body = TASK): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-checks-"));
  tempDirs.push(dir);
  const path = join(dir, "03.md");
  await writeFile(path, body, "utf8");
  return path;
}

/** The cloud agrees with this CLI. */
const agreeing = async (twin: string) => ({
  twin,
  digest: localDigest(twin),
  checks: [],
});

beforeEach(() => {
  process.exitCode = undefined;
  // The interactive path refuses under CI even on a TTY; these tests drive it
  // through injected seams, so unset it for the duration.
  delete process.env.CI;
  captured.log.length = 0;
  captured.error.length = 0;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    captured.log.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    captured.error.push(a.map(String).join(" "));
  });
});

afterEach(async () => {
  process.exitCode = undefined;
  if (savedCi === undefined) delete process.env.CI;
  else process.env.CI = savedCi;
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("pome checks add — the flags path", () => {
  it("writes the sentence the author never typed", async () => {
    const path = await taskFile();
    await runChecksAddCommand(path, {
      check: "github.no-new-labels",
      arg: ["repo=acme/api"],
      stdinIsTTY: false,
      fetchRemote: agreeing,
    });
    expect(process.exitCode).toBeUndefined();
    const after = await readFile(path, "utf8");
    expect(after).toContain("- [code] No new labels were created in `acme/api`");
    // North star: exactly one line differs.
    expect(after.replace("- [code] No new labels were created in `acme/api`\n", "")).toBe(TASK);
  });

  it("reports the declared polarity, so the author knows what a pass means", async () => {
    const path = await taskFile();
    await runChecksAddCommand(path, {
      check: "github.no-new-labels",
      arg: ["repo=acme/api"],
      stdinIsTTY: false,
      fetchRemote: agreeing,
    });
    expect(captured.log.join("\n")).toContain("negative");
  });

  it("tags the line when the task declares more than one twin", async () => {
    const path = await taskFile(TASK.replace("twins: [github]", "twins: [github, slack]"));
    await runChecksAddCommand(path, {
      check: "github.no-new-labels",
      arg: ["repo=acme/api"],
      stdinIsTTY: false,
      fetchRemote: agreeing,
    });
    expect(await readFile(path, "utf8")).toContain("[code:github]");
  });

  it("names the parameter and its example when an argument is invalid", async () => {
    const path = await taskFile();
    await runChecksAddCommand(path, {
      check: "github.no-new-labels",
      arg: ["repo=api"],
      stdinIsTTY: false,
      fetchRemote: agreeing,
    });
    expect(process.exitCode).toBe(2);
    const err = captured.error.join("\n");
    expect(err).toContain("repo");
    expect(err).toContain("acme/api");
    expect(await readFile(path, "utf8")).toBe(TASK);
  });

  it("names the parameter when an argument is missing", async () => {
    const path = await taskFile();
    await runChecksAddCommand(path, {
      check: "github.no-new-labels",
      arg: [],
      stdinIsTTY: false,
      fetchRemote: agreeing,
    });
    expect(process.exitCode).toBe(2);
    expect(captured.error.join("\n")).toContain("repo");
  });

  it("lists the declared ids when the check is unknown", async () => {
    const path = await taskFile();
    await runChecksAddCommand(path, {
      check: "github.nope",
      arg: [],
      stdinIsTTY: false,
      fetchRemote: agreeing,
    });
    expect(process.exitCode).toBe(2);
    expect(captured.error.join("\n")).toContain("github.no-new-labels");
  });

  it("refuses a file with no Success Criteria section, naming the file", async () => {
    const path = await taskFile(
      "# T\n\n## Prompt\n\ngo\n\n## Config\n\n```yaml\ntwins: [github]\n```\n",
    );
    await runChecksAddCommand(path, {
      check: "github.no-new-labels",
      arg: ["repo=acme/api"],
      stdinIsTTY: false,
      fetchRemote: agreeing,
    });
    expect(process.exitCode).toBe(2);
    expect(captured.error.join("\n")).toContain("Success Criteria");
  });
});

describe("the digest handshake", () => {
  it("passes silently when the pins agree", async () => {
    expect(await handshake("github", agreeing)).toEqual({ kind: "match" });
  });

  it("refuses and names what moved when the cloud grades a different sentence", async () => {
    const result = await handshake("github", async (twin) => ({
      twin,
      digest: "sha256:something-else",
      checks: [
        {
          id: "github.no-new-labels",
          template: "No labels were created in `{repo}`",
          substrate: "seed+final",
        },
      ],
    }));
    expect(result.kind).toBe("skew");
    if (result.kind !== "skew") throw new Error("unreachable");
    expect(result.message).toContain("github.no-new-labels");
    expect(result.message).toContain("No labels were created");
    expect(result.message).toContain("@pome-sh/cli@latest");
  });

  it("degrades with a NAMED note when the cloud is unreachable", async () => {
    const result = await handshake("github", async () => {
      throw new Error("getaddrinfo ENOTFOUND api.pome.sh");
    });
    expect(result.kind).toBe("unverified");
    if (result.kind !== "unverified") throw new Error("unreachable");
    expect(result.note).toContain("Not verified");
    expect(result.note).toContain("@pome-sh/twin-github");
  });

  it("does not write when the pins disagree", async () => {
    const path = await taskFile();
    await runChecksAddCommand(path, {
      check: "github.no-new-labels",
      arg: ["repo=acme/api"],
      stdinIsTTY: false,
      fetchRemote: async (twin) => ({ twin, digest: "sha256:different", checks: [] }),
    });
    expect(process.exitCode).toBe(2);
    expect(await readFile(path, "utf8")).toBe(TASK);
  });

  it("DOES write when the cloud is unreachable, and says it was not verified", async () => {
    const path = await taskFile();
    await runChecksAddCommand(path, {
      check: "github.no-new-labels",
      arg: ["repo=acme/api"],
      stdinIsTTY: false,
      fetchRemote: async () => {
        throw new Error("offline");
      },
    });
    expect(process.exitCode).toBeUndefined();
    expect(await readFile(path, "utf8")).toContain("No new labels were created in `acme/api`");
    expect(captured.error.join("\n")).toContain("Not verified");
  });
});

describe("pome checks add — interactive", () => {
  it("offers a numbered list carrying the description, then prompts per parameter", async () => {
    const path = await taskFile();
    const asked: string[] = [];
    await runChecksAddCommand(path, {
      arg: [],
      stdinIsTTY: true,
      ask: async (question: string) => {
        asked.push(question);
        return asked.length === 1 ? PICK : "acme/api";
      },
      confirm: async () => true,
      fetchRemote: agreeing,
    });
    const shown = captured.log.join("\n");
    expect(shown).toContain(`${PICK}) No new labels were created in `);
    expect(shown).toContain("DEFINITIONS");
    // The parameter prompt carries the declared example, not the regex.
    expect(asked[1]).toContain("acme/api");
    expect(asked[1]).not.toContain("[A-Za-z0-9");
    expect(await readFile(path, "utf8")).toContain("No new labels were created in `acme/api`");
  });

  it("shows the exact line and does not write when the confirmation is declined", async () => {
    const path = await taskFile();
    await runChecksAddCommand(path, {
      arg: [],
      stdinIsTTY: true,
      ask: async (q: string) => (q === "> " ? PICK : "acme/api"),
      confirm: async (question: string) => {
        expect(question).toContain("No new labels were created in `acme/api`");
        return false;
      },
      fetchRemote: agreeing,
    });
    expect(await readFile(path, "utf8")).toBe(TASK);
    expect(process.exitCode).toBeUndefined();
  });

  it("re-asks rather than failing when a parameter is typed wrong", async () => {
    const path = await taskFile();
    const answers = [PICK, "api", "acme/api"];
    let i = 0;
    await runChecksAddCommand(path, {
      arg: [],
      stdinIsTTY: true,
      ask: async () => answers[i++]!,
      confirm: async () => true,
      fetchRemote: agreeing,
    });
    expect(captured.error.join("\n")).toContain("acme/api");
    expect(await readFile(path, "utf8")).toContain("No new labels were created in `acme/api`");
  });

  it("refuses a nonsense selection instead of guessing", async () => {
    const path = await taskFile();
    await runChecksAddCommand(path, {
      arg: [],
      stdinIsTTY: true,
      ask: async () => String(checksFor("github").length + 1),
      confirm: async () => true,
      fetchRemote: agreeing,
    });
    expect(process.exitCode).toBe(2);
    expect(await readFile(path, "utf8")).toBe(TASK);
  });

  it("tells a non-TTY caller to pass --check rather than hanging on a prompt", async () => {
    const path = await taskFile();
    await runChecksAddCommand(path, { arg: [], stdinIsTTY: false, fetchRemote: agreeing });
    expect(process.exitCode).toBe(2);
    expect(captured.error.join("\n")).toContain("--check");
  });
});
