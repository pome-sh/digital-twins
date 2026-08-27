// SPDX-License-Identifier: Apache-2.0
// `pome twin seed <name...> --for-task` — the same generated seed, in the shape
// a `<task>.seed.json` sidecar takes.
//
// WHY A SECOND SHAPE IS NOT A SECOND RULE. A seed file written for a DOOR
// (`twin start --seed`, `sandbox create --seed`) is always the per-twin
// envelope: it is handed around on its own, so it has to say which twin it is
// for, and it must not change shape when its author adds a second twin
// ([DECISION] on F-1685, 2026-08-26). A sidecar never travels alone — the
// `<task>.md` beside it names its twins in `## Config` — so it follows the rule
// `parseTask` has had since 2026-05-12: flat for one twin, envelope for more.
//
// `--for-task` therefore picks a DESTINATION, not a shape. The shape follows
// from the destination plus the twin count, by the rule that already exists.
//
// THE HOLE THIS CLOSES. `pome compile-seeds` only emits a sidecar for a
// single-twin GITHUB task (`compile-seeds.ts` skips everything else by design,
// because compiling a multi-twin task would drop the other twin's half). So for
// slack, stripe, gmail and linear there has been no sidecar generator at all,
// and every task seed for those twins was hand-written — the same standing
// invitation to drift that left three doc examples unable to boot.
//
// The assertion is the real consumer: `parseTaskFile`, on a real task file.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTaskFile } from "../../../src/task/parseTask.js";
import { TWIN_NAME_LIST, type TwinName } from "../../../src/twin/registry.js";
import { generateSeedFile } from "../../../src/twin/twinSeed.js";

/** A minimal task whose `## Config` names `twins`, written next to a sidecar. */
async function taskWith(twins: TwinName[], sidecar: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-for-task-"));
  const taskPath = join(dir, "probe.md");
  await writeFile(
    taskPath,
    [
      "# Probe",
      "",
      "## Prompt",
      "",
      "Do the thing.",
      "",
      "## Success Criteria",
      "",
      // A multi-twin task requires the twin tag on a `[code]` criterion —
      // parseTask has to know which twin's state to check it against.
      `- [code${twins.length > 1 ? `:${twins[0]}` : ""}] The thing was done`,
      "",
      "## Config",
      "",
      "```yaml",
      `twins: [${twins.join(", ")}]`,
      "class: conformance",
      "timeout: 120",
      "runs: 1",
      "passThreshold: 100",
      "```",
      "",
    ].join("\n"),
  );
  await writeFile(taskPath.replace(/\.md$/, ".seed.json"), sidecar);
  return taskPath;
}

describe("generateSeedFile({ forTask: true }) — the sidecar shape", () => {
  it.each(TWIN_NAME_LIST)("%s: one twin is FLAT, and parseTask accepts it", async (twin) => {
    const text = await generateSeedFile([twin], { forTask: true });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // Flat: the twin's own fields at the top level, no envelope key.
    expect(Object.keys(parsed)).not.toContain(twin);
    expect(Object.keys(parsed).length).toBeGreaterThan(0);

    const task = await parseTaskFile(await taskWith([twin], text));
    expect(Object.keys(task.seedState as object)).toEqual(Object.keys(parsed));
  });

  it("two twins are the ENVELOPE, and parseTask accepts that too", async () => {
    const text = await generateSeedFile(["github", "slack"], { forTask: true });
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["github", "slack"]);

    const task = await parseTaskFile(await taskWith(["github", "slack"], text));
    expect(Object.keys(task.seedState as object).sort()).toEqual(["github", "slack"]);
  });

  it("is byte-identical to the door file once there is more than one twin", async () => {
    // The two shapes only differ for a single twin. Asserting the convergence
    // keeps `--for-task` from quietly becoming a second format.
    expect(await generateSeedFile(["github", "slack"], { forTask: true })).toBe(
      await generateSeedFile(["github", "slack"]),
    );
  });

  it("without the flag, one twin is still the envelope — the door shape", async () => {
    expect(Object.keys(JSON.parse(await generateSeedFile(["github"])) as object)).toEqual([
      "github",
    ]);
  });

  it("carries no `_meta`, so `compile-seeds` treats it as authored and leaves it alone", async () => {
    const parsed = JSON.parse(await generateSeedFile(["github"], { forTask: true })) as object;
    expect(parsed).not.toHaveProperty("_meta");
  });

  // The regression that produced `--for-task` in the first place: the DOOR
  // shape is not a sidecar, and a reader who drops one next to a single-twin
  // task should find that out from the parser, not from an empty world.
  it("the door shape is still refused as a single-twin sidecar", async () => {
    const doorFile = await generateSeedFile(["github"]);
    await expect(parseTaskFile(await taskWith(["github"], doorFile))).rejects.toThrow(
      /repositories/,
    );
  });
});
