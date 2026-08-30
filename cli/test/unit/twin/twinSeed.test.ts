// SPDX-License-Identifier: Apache-2.0
// `pome twin seed <name...>` — the starter seed file, generated from the twin.
//
// The property that matters is the round trip, and it is asserted here rather
// than described: what this command prints, `--seed` accepts, and the twin's own
// `parseSeed` is the arbiter on both ends. A starter that cannot boot is the
// defect this command exists to make impossible, so "it parses" is the test.
//
// One shape per twin count — flat for one, the per-twin envelope for several —
// and BOTH doors are asserted for both counts: `seedFile.ts` for `--seed` and
// `sandbox create --seed`, `parseTaskFile` for a `<task>.seed.json` sidecar.
// Those are two independent parsers, and a generator that satisfies only one is
// the defect (`{ "github": … }` handed to a single-twin task fails hosted with
// `repositories: expected array, received undefined`).

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTaskFile } from "../../../src/task/parseTask.js";
import { TWIN_NAME_LIST, type TwinName } from "../../../src/twin/registry.js";
import { parseSeedFileText, seedForTwin } from "../../../src/twin/seedFile.js";
import { generateSeedFile, writeSeedFile } from "../../../src/twin/twinSeed.js";

/** A minimal task whose `## Config` names `twins`, written next to a sidecar. */
async function taskWith(twins: TwinName[], sidecar: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-twin-seed-sidecar-"));
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

describe("generateSeedFile", () => {
  it.each(TWIN_NAME_LIST)("%s: what it prints is a seed file --seed accepts", async (twin) => {
    const text = await generateSeedFile([twin]);
    const file = parseSeedFileText(text, `pome twin seed ${twin}`);
    // Flat: `twin start` was told which twin by its `<name>` argument.
    expect(file.shape).toBe("flat");
    await expect(seedForTwin(file, twin, "generated")).resolves.toBeTypeOf("object");
  });

  it.each(TWIN_NAME_LIST)("%s: one twin is FLAT — its own seed fields, no twin key", async (twin) => {
    const parsed = JSON.parse(await generateSeedFile([twin])) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain(twin);
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
  });

  it("writes one envelope for several twins, in the order they were asked for", async () => {
    const parsed = JSON.parse(await generateSeedFile(["slack", "github"])) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["slack", "github"]);
  });

  it("the several-twin envelope is a seed file --seed accepts", async () => {
    const file = parseSeedFileText(await generateSeedFile(["github", "slack"]), "generated");
    expect(file.shape).toBe("envelope");
    await expect(seedForTwin(file, "slack", "generated")).resolves.toBeTypeOf("object");
  });

  // The third door, for both counts. Two independent parsers read this file and
  // `parseTask` is the other one — it decides the shape from `config.twins`
  // alone, so flat-for-one is what a single-twin sidecar has to be.
  it.each(TWIN_NAME_LIST)("%s: the flat file parses as a single-twin sidecar", async (twin) => {
    const text = await generateSeedFile([twin]);
    const task = await parseTaskFile(await taskWith([twin], text));
    expect(Object.keys(task.seedState as object)).toEqual(Object.keys(JSON.parse(text) as object));
  });

  it("the envelope parses as a multi-twin sidecar", async () => {
    const text = await generateSeedFile(["github", "slack"]);
    const task = await parseTaskFile(await taskWith(["github", "slack"], text));
    expect(Object.keys(task.seedState as object).sort()).toEqual(["github", "slack"]);
  });

  // WHY FLAT-FOR-ONE IS MANDATORY, NOT TIDY. `parseTask` decides the shape from
  // `config.twins` alone, so a single-twin sidecar is flat and an envelope is a
  // loud error — and pome-cloud's two mirrored parsers (`apps/mcp/src/task/
  // parseTask.ts`, `apps/control-plane/src/lib/task-seed.ts`) do the same, with
  // no unwrap. A generator that emitted the envelope here would boot locally and
  // fail hosted. This is live `parseTask` behaviour a future "convenience"
  // unwrap can break by accident, which is why the assertion stays.
  it("an envelope is still refused as a single-twin sidecar", async () => {
    const envelope = `${JSON.stringify({ github: JSON.parse(await generateSeedFile(["github"])) }, null, 2)}\n`;
    await expect(parseTaskFile(await taskWith(["github"], envelope))).rejects.toThrow(
      /repositories/,
    );
  });

  it("carries no `_meta` — a generated starter is a seed file, not a compiled sidecar", async () => {
    expect(JSON.parse(await generateSeedFile(["github"])) as object).not.toHaveProperty("_meta");
    const envelope = JSON.parse(await generateSeedFile(["github", "slack"])) as Record<string, unknown>;
    expect(envelope).not.toHaveProperty("_meta");
    expect(envelope.github).not.toHaveProperty("_meta");
  });

  // F-1689 will make the twins' seed schemas refuse unknown keys. A starter
  // built from `parseSeed`'s own output declares only fields that schema
  // declares, so it survives that change by construction — asserted, because
  // "by construction" is exactly the kind of claim that stops being true.
  it.each(TWIN_NAME_LIST)("%s: re-parsing the generated seed is a fixed point", async (twin) => {
    const once = await generateSeedFile([twin]);
    const seed = await seedForTwin(parseSeedFileText(once, "generated"), twin, "generated");
    expect(`${JSON.stringify(seed, null, 2)}\n`).toBe(once);
  });

  it.each(TWIN_NAME_LIST)("%s: is byte-identical across calls", async (twin) => {
    expect(await generateSeedFile([twin])).toBe(await generateSeedFile([twin]));
  });

  it("ends with a newline, so `pome twin seed github > seed.json` is a well-formed file", async () => {
    expect(await generateSeedFile(["stripe"])).toMatch(/\n$/);
  });

  it("refuses an unknown twin by name and lists the ones that exist", async () => {
    await expect(generateSeedFile(["notion" as never])).rejects.toThrow(
      /Unknown twin 'notion'\. Supported: github, slack, stripe, gmail, linear\./,
    );
  });

  it("refuses the same twin twice rather than emitting a duplicate key", async () => {
    await expect(generateSeedFile(["github", "github"])).rejects.toThrow(/named twice: github/);
  });
});

describe("writeSeedFile", () => {
  it("writes the file and reports the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-twin-seed-"));
    const path = join(dir, "seed.json");
    await writeSeedFile(path, await generateSeedFile(["stripe", "gmail"]));
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["stripe", "gmail"]);
  });

  it("refuses to overwrite — a seed file is authored content once it exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-twin-seed-"));
    const path = join(dir, "seed.json");
    await writeFile(path, "{}");
    await expect(writeSeedFile(path, "{}\n")).rejects.toThrow(
      /already exists.*delete it or pass a different --out/s,
    );
  });
});
