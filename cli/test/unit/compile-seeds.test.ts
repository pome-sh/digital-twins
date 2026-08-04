// SPDX-License-Identifier: Apache-2.0
/**
 * `pome compile-seeds` must never destroy a seed it did not author.
 *
 * The starter library ships adversarial seeds (a backdoored PR, a green-but-
 * fabricated CI status, an exfiltration lure) that were written by hand
 * precisely because a compiler cannot be trusted to reproduce them. Those files
 * mark themselves with a `hand-authored` sentinel in `_meta`. Recompiling one
 * changes what the exam tests while the run still reports normally, so the
 * corruption is silent — hence these tests assert byte-identity, not just
 * "looks about right".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Keep COMPILER_MODEL real — the cache contract compares against it, so a
// hardcoded copy here would silently rot if the pinned model changes.
vi.mock("../../src/task/seed-compiler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/task/seed-compiler.js")>();
  return {
    ...actual,
    compileSeed: vi.fn(async () => ({
      seed: {
        repositories: [
          {
            owner: "acme",
            name: "api",
            labels: [{ name: "bug" }],
            collaborators: ["alice"],
            issues: [{ number: 1, title: "recompiled", body: "recompiled", labels: [], assignee: null }],
          },
        ],
      },
      model: COMPILER_MODEL,
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 30,
    })),
  };
});

import { runCompileSeeds } from "../../src/cli/compile-seeds.js";
import { compileSeed, COMPILER_MODEL } from "../../src/task/seed-compiler.js";

const OPTS = { force: false, hosted: false, apiBaseUrl: "https://api.pome.sh" };

function taskMarkdown(prose: string, twins = "[github]"): string {
  return `# Fixture task

## Prompt

Triage issue #1.

## Success Criteria

- [code] Stub criterion

## Seed State

${prose}

## Config

\`\`\`yaml
twins: ${twins}
passThreshold: 100
\`\`\`
`;
}

const HAND_AUTHORED_SIDECAR = JSON.stringify(
  {
    _meta: {
      version: 1,
      source_hash: "sha256:hand-authored",
      model: "hand-authored",
      compiled_at: "2026-06-02T00:00:00.000Z",
    },
    repositories: [
      {
        owner: "acme",
        name: "api",
        labels: [{ name: "bug" }],
        collaborators: ["alice"],
        issues: [
          { number: 1, title: "carefully staged", body: "adversarial setup", labels: [], assignee: null },
        ],
      },
    ],
  },
  null,
  2,
) + "\n";

/** Writes a task + sidecar pair into a fresh tmpdir and returns their paths. */
async function fixture(sidecar: string, prose = "One repo, acme/api, with a single open bug.", twins = "[github]") {
  const dir = await mkdtemp(join(tmpdir(), "pome-compile-seeds-"));
  const mdPath = join(dir, "task.md");
  const sidecarPath = join(dir, "task.seed.json");
  await writeFile(mdPath, taskMarkdown(prose, twins));
  await writeFile(sidecarPath, sidecar);
  return { dir, mdPath, sidecarPath };
}

describe("compile-seeds hand-authored protection", () => {
  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    });
    vi.mocked(compileSeed).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves a hand-authored sidecar byte-identical", async () => {
    const { dir, sidecarPath } = await fixture(HAND_AUTHORED_SIDECAR);

    const code = await runCompileSeeds(dir, OPTS);

    expect(code).toBe(0);
    expect(await readFile(sidecarPath, "utf8")).toBe(HAND_AUTHORED_SIDECAR);
  });

  it("does not invoke the compiler for a hand-authored sidecar", async () => {
    const { dir } = await fixture(HAND_AUTHORED_SIDECAR);

    await runCompileSeeds(dir, OPTS);

    expect(compileSeed).not.toHaveBeenCalled();
  });

  it("reports hand-authored as its own status, not a generic cache skip", async () => {
    const { dir } = await fixture(HAND_AUTHORED_SIDECAR);

    await runCompileSeeds(dir, OPTS);

    expect(stderr.join("\n")).toMatch(/hand-authored/);
  });

  it("still refuses to overwrite a hand-authored sidecar under --force", async () => {
    const { dir, sidecarPath } = await fixture(HAND_AUTHORED_SIDECAR);

    await runCompileSeeds(dir, { ...OPTS, force: true });

    expect(await readFile(sidecarPath, "utf8")).toBe(HAND_AUTHORED_SIDECAR);
    expect(compileSeed).not.toHaveBeenCalled();
  });

  it("treats a partial _meta carrying the sentinel as hand-authored", async () => {
    // A hand-edited sidecar may omit `version`/`compiled_at`; the sentinel is
    // still an unambiguous statement of provenance and must be honoured.
    const partial = JSON.stringify({ _meta: { model: "hand-authored" }, repositories: [] }, null, 2) + "\n";
    const { dir, sidecarPath } = await fixture(partial);

    await runCompileSeeds(dir, OPTS);

    expect(await readFile(sidecarPath, "utf8")).toBe(partial);
    expect(compileSeed).not.toHaveBeenCalled();
  });

  it("skips a task needing twins beyond github rather than flattening its envelope", async () => {
    // Multi-twin tasks carry a per-twin envelope ({github: {...}, linear: {...}}).
    // The v1 compiler only emits a flat github seed, so compiling one would
    // silently drop the other twin's half.
    const envelope = JSON.stringify({ github: { repositories: [] }, linear: { teams: [] } }, null, 2) + "\n";
    const { dir, sidecarPath } = await fixture(envelope, "A github repo and a linear team.", '["github", "linear"]');

    await runCompileSeeds(dir, OPTS);

    expect(await readFile(sidecarPath, "utf8")).toBe(envelope);
    expect(compileSeed).not.toHaveBeenCalled();
  });
});

describe("compile-seeds cache behaviour is preserved", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(compileSeed).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips a genuinely compiler-authored sidecar whose prose is unchanged", async () => {
    const { dir, sidecarPath } = await fixture("(placeholder — overwritten by the first run)");

    // First run writes real compiler provenance...
    await runCompileSeeds(dir, { ...OPTS, force: true });
    expect(compileSeed).toHaveBeenCalledTimes(1);
    const compiled = await readFile(sidecarPath, "utf8");
    expect(compiled).toContain(`"model": "${COMPILER_MODEL}"`);

    // ...and the second run hits the cache instead of recompiling.
    await runCompileSeeds(dir, OPTS);

    expect(compileSeed).toHaveBeenCalledTimes(1);
    expect(await readFile(sidecarPath, "utf8")).toBe(compiled);
  });

  it("recompiles a compiler-authored sidecar when the prose changes", async () => {
    const { dir, mdPath } = await fixture("(placeholder — overwritten by the first run)");
    await runCompileSeeds(dir, { ...OPTS, force: true });
    expect(compileSeed).toHaveBeenCalledTimes(1);

    await writeFile(mdPath, taskMarkdown("Two repos now, acme/api and acme/web."));
    await runCompileSeeds(dir, OPTS);

    expect(compileSeed).toHaveBeenCalledTimes(2);
  });
});
