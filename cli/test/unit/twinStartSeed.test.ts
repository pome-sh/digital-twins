// SPDX-License-Identifier: Apache-2.0
// Read side of the world contract in `pome twin start`: `--seed <path>` wins,
// else `POME_SEED_JSON` (the same channel the cloud sets on a pod), else the
// twin's default. The twin's own `parseSeed` is the arbiter in both authored
// cases, so a bad world is refused here rather than at boot.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStandaloneSeed } from "../../src/twin/twinStart.js";

const WORLD = {
  users: [{ login: "vakoi", type: "Organization", name: "Vakoi" }],
  repositories: [{ owner: "vakoi", name: "billing" }],
};

async function seedFile(contents: string, name = "world.json"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-twin-start-seed-"));
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

/** The one fact every case below turns on: `vakoi/billing` is not a repository
 *  the github twin's own `defaultSeedState()` has, and `acme/api` is. */
function repoNames(seedState: unknown): string[] {
  const seed = seedState as { repositories: { owner: string; name: string }[] };
  return seed.repositories.map((repo) => `${repo.owner}/${repo.name}`);
}

describe("resolveStandaloneSeed", () => {
  it("reads a JSON world from --seed and reports the path it came from", async () => {
    const path = await seedFile(JSON.stringify(WORLD));
    const resolved = await resolveStandaloneSeed("github", path, {});
    expect(resolved.source).toBe("file");
    expect(resolved.path).toBe(path);
    expect(repoNames(resolved.seedState)).toEqual(["vakoi/billing"]);
  });

  it("reads a YAML world from --seed (JSON is a YAML subset, so one parser)", async () => {
    const path = await seedFile(
      ["repositories:", "  - owner: vakoi", "    name: billing", ""].join("\n"),
      "world.yaml",
    );
    const resolved = await resolveStandaloneSeed("github", path, {});
    expect(repoNames(resolved.seedState)).toEqual(["vakoi/billing"]);
  });

  it("honors POME_SEED_JSON when --seed is absent", async () => {
    const resolved = await resolveStandaloneSeed("github", undefined, {
      POME_SEED_JSON: JSON.stringify(WORLD),
    });
    expect(resolved.source).toBe("env");
    expect(resolved.path).toBeUndefined();
    expect(repoNames(resolved.seedState)).toEqual(["vakoi/billing"]);
  });

  it("--seed wins over POME_SEED_JSON", async () => {
    const path = await seedFile(JSON.stringify(WORLD));
    const resolved = await resolveStandaloneSeed("github", path, {
      POME_SEED_JSON: JSON.stringify({ repositories: [{ owner: "env", name: "loser" }] }),
    });
    expect(resolved.source).toBe("file");
    expect(repoNames(resolved.seedState)).toEqual(["vakoi/billing"]);
  });

  it("falls back to the twin's default world when neither is set", async () => {
    const resolved = await resolveStandaloneSeed("github", undefined, {});
    expect(resolved.source).toBe("default");
    // github's entry defers to the twin's own defaultSeedState() inside `boot`.
    expect(resolved.seedState).toBeUndefined();
  });

  it("treats an empty POME_SEED_JSON as absent rather than as an empty world", async () => {
    const resolved = await resolveStandaloneSeed("github", undefined, { POME_SEED_JSON: "" });
    expect(resolved.source).toBe("default");
  });

  it("names the file when it cannot be read", async () => {
    await expect(
      resolveStandaloneSeed("github", "/nope/does-not-exist.json", {}),
    ).rejects.toThrow(/--seed: cannot read \/nope\/does-not-exist\.json/);
  });

  it("refuses an unparseable world, naming the flag", async () => {
    const path = await seedFile("{ not json ::: and not yaml");
    await expect(resolveStandaloneSeed("github", path, {})).rejects.toThrow(
      /is not valid JSON or YAML/,
    );
  });

  it("refuses a schema-invalid world through the twin's OWN parser", async () => {
    // A repository with no `name`. github's `boot` hands its seed to
    // `domain.seed()` unparsed, so without the registry's parseSeed entry this
    // reaches SQLite instead of the user.
    const path = await seedFile(JSON.stringify({ repositories: [{ owner: "acme" }] }));
    await expect(resolveStandaloneSeed("github", path, {})).rejects.toThrow(
      /is not a world this twin can boot/,
    );
  });

  it("refuses a schema-invalid world from POME_SEED_JSON too, naming the env var", async () => {
    await expect(
      resolveStandaloneSeed("github", undefined, {
        POME_SEED_JSON: JSON.stringify({ repositories: [{ owner: "acme" }] }),
      }),
    ).rejects.toThrow(/POME_SEED_JSON is not a world this twin can boot/);
  });

  it("accepts a compiled task sidecar as-is, provenance block and all", async () => {
    // `pome compile-seeds` emits `<task>.seed.json` with an `_meta` block, and
    // that file IS a world — every task in the bundled library is already one.
    // The strip is declared here rather than left to non-strict zod, so a
    // later move to strict schemas does not refuse the whole library.
    const path = await seedFile(
      JSON.stringify({
        _meta: { version: 1, source_hash: "sha256:abc", compiled_at: "2026-05-22T14:30:00.154Z" },
        ...WORLD,
      }),
    );
    const resolved = await resolveStandaloneSeed("github", path, {});
    expect(repoNames(resolved.seedState)).toEqual(["vakoi/billing"]);
    expect(resolved.seedState).not.toHaveProperty("_meta");
  });

  it("every twin resolves its own default without reaching for github's", async () => {
    for (const twin of ["slack", "stripe", "gmail", "linear"] as const) {
      const resolved = await resolveStandaloneSeed(twin, undefined, {});
      expect(resolved.source).toBe("default");
      expect(resolved.seedState).toBeTypeOf("object");
    }
  });
});
