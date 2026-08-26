// SPDX-License-Identifier: Apache-2.0
// The one seed-file door, in isolation: what shape a file is, which twin each
// part belongs to, and what it says when the file names a twin the command was
// not asked for.
//
// The rule under test is DECLARED, not sniffed at the value level: a file is a
// per-twin envelope iff its top-level keys are twin ids. `noTwinFieldIsNamedAfterATwin`
// below is what makes that rule safe, and it derives both sides from the twins.

import { describe, expect, it } from "vitest";
import {
  parseSeedFileText,
  seedFieldsFor,
  seedForTwin,
  soleTwinOf,
  twinsNamedBy,
} from "../../../src/twin/seedFile.js";
import { TWIN_NAME_LIST } from "../../../src/twin/registry.js";

const GITHUB_FLAT = {
  users: [{ login: "vakoi", type: "Organization", name: "Vakoi" }],
  repositories: [{ owner: "vakoi", name: "billing" }],
};
const SLACK_FLAT = {
  channels: [{ id: "C_ENG", name: "eng-alerts", members: [] }],
};

describe("parseSeedFileText — which shape is this file", () => {
  it("reads a flat single-twin seed as flat", () => {
    const file = parseSeedFileText(JSON.stringify(GITHUB_FLAT), "--seed w.json");
    expect(file.shape).toBe("flat");
    expect(twinsNamedBy(file)).toEqual([]);
  });

  it("reads a per-twin envelope as an envelope, in file order", () => {
    const file = parseSeedFileText(
      JSON.stringify({ github: GITHUB_FLAT, slack: SLACK_FLAT }),
      "--seed w.json",
    );
    expect(file.shape).toBe("envelope");
    expect(twinsNamedBy(file)).toEqual(["github", "slack"]);
  });

  it("reads YAML, because JSON is a YAML subset and one parser is the contract", () => {
    const file = parseSeedFileText(
      ["github:", "  repositories:", "    - owner: vakoi", "      name: billing", ""].join("\n"),
      "--seed w.yaml",
    );
    expect(file.shape).toBe("envelope");
    expect(twinsNamedBy(file)).toEqual(["github"]);
  });

  it("strips the `_meta` provenance block a compiled sidecar carries, on BOTH shapes", () => {
    const flat = parseSeedFileText(
      JSON.stringify({ _meta: { source_hash: "abc" }, ...GITHUB_FLAT }),
      "--seed w.json",
    );
    if (flat.shape !== "flat") throw new Error(`expected a flat file, got ${flat.shape}`);
    expect(Object.keys(flat.seed as object)).not.toContain("_meta");

    const enveloped = parseSeedFileText(
      JSON.stringify({ _meta: { source_hash: "abc" }, github: GITHUB_FLAT }),
      "--seed w.json",
    );
    expect(enveloped.shape).toBe("envelope");
    expect(twinsNamedBy(enveloped)).toEqual(["github"]);
  });

  it("treats an empty object as flat — a slack or stripe seed may legitimately be `{}`", () => {
    expect(parseSeedFileText("{}", "--seed w.json").shape).toBe("flat");
  });

  it("refuses a file that mixes twin ids with flat seed fields", () => {
    expect(() =>
      parseSeedFileText(
        JSON.stringify({ github: GITHUB_FLAT, repositories: [] }),
        "--seed w.json",
      ),
    ).toThrow(/mixes twin ids \(github\) with other keys \(repositories\)/);
  });

  it("names the file and the parser's own complaint when the text is not JSON or YAML", () => {
    expect(() => parseSeedFileText("{ nope", "--seed w.json")).toThrow(
      /--seed w\.json is not valid JSON or YAML/,
    );
  });

  it("refuses a top-level array — a seed file declares a world, not a list", () => {
    expect(() => parseSeedFileText("[]", "--seed w.json")).toThrow(
      /--seed w\.json is not a seed file: its top level is an array/,
    );
  });
});

describe("seedForTwin — which part of the file belongs to this twin", () => {
  it("hands a flat file straight to the named twin", async () => {
    const file = parseSeedFileText(JSON.stringify(GITHUB_FLAT), "--seed w.json");
    await expect(seedForTwin(file, "github", "--seed w.json")).resolves.toMatchObject({
      repositories: [expect.objectContaining({ owner: "vakoi", name: "billing" })],
    });
  });

  it("unwraps the envelope entry for the twin asked for", async () => {
    const file = parseSeedFileText(
      JSON.stringify({ github: GITHUB_FLAT, slack: SLACK_FLAT }),
      "--seed w.json",
    );
    const seed = (await seedForTwin(file, "github", "--seed w.json")) as {
      repositories: { name: string }[];
    };
    expect(seed.repositories.map((r) => r.name)).toEqual(["billing"]);
  });

  it("refuses BY NAME an envelope entry for a twin this command was not asked for", async () => {
    const file = parseSeedFileText(
      JSON.stringify({ github: GITHUB_FLAT, slack: SLACK_FLAT }),
      "--seed w.json",
    );
    await expect(
      seedForTwin(file, "github", "--seed w.json", { asked: ["github"] }),
    ).rejects.toThrow(/names slack, which this command was not asked for/);
  });

  it("refuses BY NAME a key that is not a Pome twin at all", () => {
    expect(() =>
      parseSeedFileText(JSON.stringify({ github: GITHUB_FLAT, notion: {} }), "--seed w.json"),
    ).toThrow(/mixes twin ids \(github\) with other keys \(notion\)/);
  });

  it("is a loud error, not a silent skip, when the envelope has no entry for the twin", async () => {
    const file = parseSeedFileText(JSON.stringify({ slack: SLACK_FLAT }), "--seed w.json");
    await expect(seedForTwin(file, "github", "--seed w.json")).rejects.toThrow(
      /declares no github seed \(it names slack\)/,
    );
  });

  it("refuses a flat file the twin's own parseSeed rejects, quoting the twin's field", async () => {
    const file = parseSeedFileText(JSON.stringify({ repositories: [{ owner: "acme" }] }), "--seed w.json");
    await expect(seedForTwin(file, "github", "--seed w.json")).rejects.toThrow(
      /--seed w\.json is not a seed this twin can boot[\s\S]*name/,
    );
  });

  // The regression this whole module exists for: slack's and stripe's seed
  // schemas are non-strict, so before the envelope was declared they ACCEPTED a
  // `{github, slack}` file and served an EMPTY world while the boot line said
  // the seed had landed. Twelve of the twenty sidecars in agent-examples/ are
  // that shape.
  it("does not let a non-strict twin silently accept an envelope as its own flat seed", async () => {
    const file = parseSeedFileText(
      JSON.stringify({ github: GITHUB_FLAT, slack: SLACK_FLAT }),
      "--seed w.json",
    );
    const seed = (await seedForTwin(file, "slack", "--seed w.json")) as {
      channels: { name: string }[];
    };
    expect(seed.channels.map((c) => c.name)).toEqual(["eng-alerts"]);
  });

  it("tells a reader their keys are not seed fields when a flat parse fails on all of them", async () => {
    const file = parseSeedFileText(JSON.stringify({ notion: { pages: [] } }), "--seed w.json");
    await expect(seedForTwin(file, "github", "--seed w.json")).rejects.toThrow(
      /None of its top-level keys \(notion\) is a field of the github seed/,
    );
  });
});

describe("soleTwinOf — when the file makes `--twin` unnecessary", () => {
  it("returns the one twin an envelope names", () => {
    const file = parseSeedFileText(JSON.stringify({ linear: {} }), "--seed w.json");
    expect(soleTwinOf(file)).toBe("linear");
  });

  it("returns undefined for an envelope naming more than one", () => {
    const file = parseSeedFileText(
      JSON.stringify({ github: GITHUB_FLAT, slack: SLACK_FLAT }),
      "--seed w.json",
    );
    expect(soleTwinOf(file)).toBeUndefined();
  });

  it("returns undefined for a flat file — a flat seed names no twin", () => {
    const file = parseSeedFileText(JSON.stringify(GITHUB_FLAT), "--seed w.json");
    expect(soleTwinOf(file)).toBeUndefined();
  });
});

// The safety proof for the detection rule above. Both sides are derived: the
// twin ids from the registry, the field names from each twin's own zod schema.
// If a twin ever declares a top-level seed field named after a twin, "keys are
// twin ids" stops telling an envelope from a flat seed, and this goes red before
// anyone finds out from a silently-empty world.
describe("no twin's seed field is named after a twin", () => {
  it.each(TWIN_NAME_LIST)("%s", async (twin) => {
    const fields = await seedFieldsFor(twin);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.filter((f) => (TWIN_NAME_LIST as readonly string[]).includes(f))).toEqual([]);
  });
});
