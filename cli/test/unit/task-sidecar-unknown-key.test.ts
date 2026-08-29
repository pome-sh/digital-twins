// SPDX-License-Identifier: Apache-2.0
//
// `parseTask`'s half of F-1689. Two properties, one per direction:
//
//   a key no seed field matches  → refused, naming the key
//   the `_meta` provenance block → accepted, at EITHER placement
//
// The second is the one with a live pattern behind it. `pome compile-seeds`
// writes `_meta` at the top, which `stripSidecarMeta` has always removed — but
// twelve of the twenty sidecars in `agent-examples/` are envelopes carrying it
// INSIDE the twin's arm (`{ github: { _meta, … }, slack: { … } }`), and that is
// the file a reader copies when they hand-author their own. github survived
// because its arm goes through the twin's `parseSeed`; the other four arms parse
// with a schema directly, so each envelope arm strips its own.

import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTaskFile } from "../../src/task/parseTask.js";

const META = {
  version: 1,
  source_hash: "sha256:hand-authored",
  model: "hand-authored",
  compiled_at: "2026-08-29T00:00:00.000Z",
};

function task(twins: string[]): string {
  return [
    "# Test task",
    "",
    "## Prompt",
    "",
    "Triage issue #1.",
    "",
    "## Success Criteria",
    "",
    // A multi-twin task requires the twin tag; a single-twin one must not carry
    // a tag naming a twin it does not have.
    twins.length > 1 ? `- [code:${twins[0]}] Stub criterion` : "- [code] Stub criterion",
    "",
    "## Seed State",
    "",
    "(the sidecar wins)",
    "",
    "## Config",
    "",
    "```yaml",
    `twins: [${twins.join(", ")}]`,
    "```",
    "",
  ].join("\n");
}

async function parseWithSidecar(twins: string[], seed: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "pome-strict-"));
  const mdPath = join(dir, "task.md");
  await writeFile(mdPath, task(twins));
  await writeFile(join(dir, "task.seed.json"), JSON.stringify(seed));
  return parseTaskFile(mdPath);
}

describe("a sidecar key no seed field matches is refused, naming the key", () => {
  it("github, single-twin", async () => {
    await expect(
      parseWithSidecar("github".split(","), {
        repositories: [{ owner: "zed", name: "quiet", isuses: [{ title: "dropped" }] }],
      }),
    ).rejects.toThrow(/isuses/);
  });

  it("github, inside a multi-twin envelope", async () => {
    await expect(
      parseWithSidecar(["github", "linear"], {
        github: { repositories: [{ owner: "zed", name: "quiet", isuses: [] }] },
        linear: { teams: [{ key: "ENG", name: "Engineering" }] },
      }),
    ).rejects.toThrow(/isuses/);
  });
});

describe("the `_meta` provenance block boots at either placement", () => {
  it("at the top of a single-twin sidecar", async () => {
    const parsed = await parseWithSidecar(["github"], {
      _meta: META,
      repositories: [{ owner: "zed", name: "quiet" }],
    });
    const seed = parsed.seedState as { repositories: unknown[] };
    expect(seed.repositories).toHaveLength(1);
    expect((parsed.seedState as Record<string, unknown>)._meta).toBeUndefined();
  });

  // `agent-examples/minimal-viktor/tasks/*.seed.json`, exactly.
  it("inside each arm of a multi-twin envelope", async () => {
    const parsed = await parseWithSidecar(["github", "slack"], {
      github: { _meta: META, repositories: [{ owner: "zed", name: "quiet" }] },
      slack: { _meta: META, channels: [{ name: "eng-alerts" }] },
    });
    const envelope = parsed.seedState as unknown as {
      github: { repositories: unknown[] };
      slack: { channels: unknown[] };
    };
    expect(envelope.github.repositories).toHaveLength(1);
    expect(envelope.slack.channels).toHaveLength(1);
  });

  it("inside a gmail and a linear arm, whose schemas were strict before this", async () => {
    const parsed = await parseWithSidecar(["gmail", "linear"], {
      gmail: { _meta: META, primaryMailbox: { email: "ops@vakoi.test" } },
      linear: { _meta: META, teams: [{ key: "ENG", name: "Engineering" }] },
    });
    const envelope = parsed.seedState as unknown as {
      gmail: { primaryMailbox: { email: string } };
      linear: { teams: unknown[] };
    };
    expect(envelope.gmail.primaryMailbox.email).toBe("ops@vakoi.test");
    expect(envelope.linear.teams).toHaveLength(1);
  });
});

// `githubSeedCompat` migrates the legacy singular `assignee` to `assignees[]`
// BEFORE the schema sees it. Strictness must not turn that compat layer into a
// wall: eight sidecars in the library still spell it the old way.
describe("the legacy `assignee` normalisation still passes", () => {
  it("a sidecar spelling it the old way parses, and lands in assignees[]", async () => {
    const parsed = await parseWithSidecar(["github"], {
      _meta: META,
      repositories: [
        { owner: "zed", name: "quiet", issues: [{ number: 1, title: "t", assignee: "alice" }] },
      ],
    });
    const seed = parsed.seedState as {
      repositories: Array<{ issues: Array<{ assignees: string[] }> }>;
    };
    expect(seed.repositories[0]!.issues[0]!.assignees).toEqual(["alice"]);
  });

  it("`assignee: null` still means nobody", async () => {
    const parsed = await parseWithSidecar(["github"], {
      repositories: [
        { owner: "zed", name: "quiet", issues: [{ number: 1, title: "t", assignee: null }] },
      ],
    });
    const seed = parsed.seedState as {
      repositories: Array<{ issues: Array<{ assignees: string[] }> }>;
    };
    expect(seed.repositories[0]!.issues[0]!.assignees).toEqual([]);
  });
});
