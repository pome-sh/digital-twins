// SPDX-License-Identifier: Apache-2.0
// `pome twin seed <name...>` — the starter seed file, generated from the twin.
//
// The property that matters is the round trip, and it is asserted here rather
// than described: what this command prints, `--seed` accepts, and the twin's own
// `parseSeed` is the arbiter on both ends. A starter that cannot boot is the
// defect this command exists to make impossible, so "it parses" is the test.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TWIN_NAME_LIST } from "../../../src/twin/registry.js";
import { parseSeedFileText, seedForTwin } from "../../../src/twin/seedFile.js";
import { generateSeedFile, writeSeedFile } from "../../../src/twin/twinSeed.js";

describe("generateSeedFile", () => {
  it.each(TWIN_NAME_LIST)("%s: what it prints is a seed file --seed accepts", async (twin) => {
    const text = await generateSeedFile([twin]);
    const file = parseSeedFileText(text, `pome twin seed ${twin}`);
    expect(file.shape).toBe("envelope");
    await expect(seedForTwin(file, twin, "generated")).resolves.toBeTypeOf("object");
  });

  it.each(TWIN_NAME_LIST)("%s: is the envelope shape, one twin or five", async (twin) => {
    const parsed = JSON.parse(await generateSeedFile([twin])) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([twin]);
  });

  it("writes one envelope for several twins, in the order they were asked for", async () => {
    const parsed = JSON.parse(await generateSeedFile(["slack", "github"])) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["slack", "github"]);
  });

  it("carries no `_meta` — a generated starter is a seed file, not a compiled sidecar", async () => {
    const parsed = JSON.parse(await generateSeedFile(["github"])) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("_meta");
    expect(parsed.github).not.toHaveProperty("_meta");
  });

  // F-1689 will make the twins' seed schemas refuse unknown keys. A starter
  // built from `parseSeed`'s own output declares only fields that schema
  // declares, so it survives that change by construction — asserted, because
  // "by construction" is exactly the kind of claim that stops being true.
  it.each(TWIN_NAME_LIST)("%s: re-parsing the generated seed is a fixed point", async (twin) => {
    const once = await generateSeedFile([twin]);
    const seed = await seedForTwin(parseSeedFileText(once, "generated"), twin, "generated");
    const twice = JSON.stringify({ [twin]: seed }, null, 2);
    expect(`${twice}\n`).toBe(once);
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
    await writeSeedFile(path, await generateSeedFile(["stripe"]));
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["stripe"]);
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
