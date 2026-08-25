// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPattern, templateSlots } from "@pome-sh/sdk/checks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handshake, runChecksAddCommand } from "../../src/cli/checks-add.js";
import { checksFor, localDigest, pinnedVersion } from "../../src/cli/checks.js";
import { twinWithoutChecks } from "./_noVocabularyTwin.js";

// The menu position of the check these tests pick.
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

/** Everything `GET /v1/checks` publishes, mirrored from this CLI's own pin — the
 *  compiled `pattern` and the parameter patterns included, because prod serves
 *  both. Derived rather than written out: the vocabulary is a closed set that
 *  grows, so a literal fixture would assert its size, not the behaviour. */
function mirrorOfLocal(twin: string) {
  return checksFor(twin).map((def) => ({
    id: def.id,
    template: def.template,
    substrate: def.substrate,
    pattern: checkPattern(def).source,
    params: templateSlots(def.template).params.map((name) => ({
      name,
      pattern: def.params[name]!.pattern,
    })),
  }));
}

/** The bullet list the refusal renders. The defect was that this came back
 *  empty while the refusal claimed to name what moved. */
function bulletsIn(message: string): string[] {
  return message
    .split("\n")
    .filter((line) => line.trimStart().startsWith("- "))
    .map((line) => line.replace(/^\s*-\s*/, ""));
}

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
    const path = await taskFile(TASK.replace("twins: [github]", "twins: [github, stripe]"));
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

  // The bullet list has to name the same fields `checksDigest` hashes — `id`,
  // `substrate` and the COMPILED pattern — or a substrate-only move reads as an
  // unexplained digest mismatch.
  it("names the check and both substrates when only the substrate moved", async () => {
    const result = await handshake("github", async (twin) => ({
      twin,
      digest: "sha256:the-cloud-hashed-a-different-substrate",
      checks: mirrorOfLocal("github").map((check, index) =>
        index === 0 ? { ...check, substrate: "tape" } : check,
      ),
    }));

    expect(result.kind).toBe("skew");
    if (result.kind !== "skew") throw new Error("unreachable");
    const first = checksFor("github")[0]!;
    expect(result.message).toContain(first.id);
    expect(result.message).toContain(first.substrate);
    expect(result.message).toContain("tape");
    expect(bulletsIn(result.message).length).toBeGreaterThan(0);
  });

  it("names the sdk generator when only the compiled pattern moved", async () => {
    const result = await handshake("github", async (twin) => ({
      twin,
      digest: "sha256:a-different-sdk-compiled-these",
      // Every field the cloud publishes is byte-identical to ours EXCEPT the
      // compiled pattern — what a `buildPattern` change looks like on the wire.
      checks: mirrorOfLocal("github").map((check) => ({
        ...check,
        pattern: check.pattern!.replace("^", "^(?:)"),
      })),
    }));

    expect(result.kind).toBe("skew");
    if (result.kind !== "skew") throw new Error("unreachable");
    expect(result.message).toContain("buildPattern");
    expect(result.message).toContain(`@pome-sh/sdk ${pinnedVersion("@pome-sh/sdk")}`);
    expect(bulletsIn(result.message).length).toBeGreaterThan(0);
  });

  it("still names a class when the cloud publishes nothing this CLI can diff", async () => {
    const result = await handshake("github", async (twin) => ({
      twin,
      digest: "sha256:a-control-plane-that-publishes-no-pattern",
      checks: checksFor("github").map((def) => ({
        id: def.id,
        template: def.template,
        substrate: def.substrate,
      })),
    }));

    expect(result.kind).toBe("skew");
    if (result.kind !== "skew") throw new Error("unreachable");
    const bullets = bulletsIn(result.message);
    expect(bullets.length).toBeGreaterThan(0);
    for (const bullet of bullets) expect(bullet).not.toBe("");
    expect(result.message).toContain("buildPattern");
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

// The write path is the only place a local-only author is standing when the file is in
// front of them, so it is where the whole block gets audited.
describe("pome checks add — auditing the block it writes into", () => {
  const HAND_EDITED = "No new labels were ever created in `acme/api`";

  /** The ticket's transcript: a rendered criterion, one word off. */
  const withBrokenLine = TASK.replace(
    "- [code] Issue #1 is still assigned to `alice`",
    `- [code] ${HAND_EDITED}`,
  );

  async function addTo(body: string) {
    const path = await taskFile(body);
    await runChecksAddCommand(path, {
      check: "github.issue-has-label",
      arg: ["issue=1", "repo=acme/api", "label=bug"],
      stdinIsTTY: false,
      fetchRemote: agreeing,
    });
    return path;
  }

  it("names the broken line sitting above the one it just appended", async () => {
    await addTo(withBrokenLine);
    expect(captured.error.join("\n")).toContain(HAND_EDITED);
  });

  it("says the broken line will not be graded", async () => {
    await addTo(withBrokenLine);
    expect(captured.error.join("\n")).toMatch(/not be graded/);
  });

  it("points at the closed set the sentence could have come from", async () => {
    await addTo(withBrokenLine);
    expect(captured.error.join("\n")).toContain("pome checks github");
  });

  it("still writes, and still exits 0 — a pre-existing line is not a refusal", async () => {
    const path = await addTo(withBrokenLine);
    expect(process.exitCode).toBeUndefined();
    expect(await readFile(path, "utf8")).toContain(
      "- [code] Issue #1 in `acme/api` has the `bug` label applied",
    );
  });

  it("says nothing when every [code] criterion in the block binds", async () => {
    await addTo(
      TASK.replace(
        "- [code] Issue #1 is still assigned to `alice`",
        "- [code] Issue #1 in `acme/api` is assigned to `alice`",
      ),
    );
    expect(captured.error.join("\n")).toBe("");
  });

  it("cannot warn about the sentence it rendered itself", async () => {
    // An empty block, so the only [code] criterion afterwards is the written one.
    await addTo(TASK.replace("- [code] Issue #1 is still assigned to `alice`\n", ""));
    expect(captured.error.join("\n")).toBe("");
  });

  it("names the check and the offending slot for a corrupted instance", async () => {
    await addTo(
      TASK.replace(
        "- [code] Issue #1 is still assigned to `alice`",
        // GitHub numbers issues from 1, so `#0` names nothing.
        "- [code] Issue #0 in `acme/api` has the `bug` label applied",
      ),
    );
    const err = captured.error.join("\n");
    expect(err).toContain("github.issue-has-label");
    expect(err).toContain("issue");
  });

  it("says nothing about a criterion whose twin declares no vocabulary yet", async () => {
    const twin = twinWithoutChecks();
    const path = await taskFile(
      TASK.replace("twins: [github]", `twins: [github, ${twin}]`).replace(
        "- [code] Issue #1 is still assigned to `alice`",
        `- [code:${twin}] Something happened`,
      ),
    );
    await runChecksAddCommand(path, {
      check: "github.no-new-labels",
      arg: ["repo=acme/api"],
      stdinIsTTY: false,
      fetchRemote: agreeing,
    });
    expect(captured.error.join("\n")).toBe("");
  });
});
