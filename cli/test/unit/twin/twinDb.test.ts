// SPDX-License-Identifier: Apache-2.0
//
// The two variables CONTRACT.md gives each twin for persistence, resolved for
// `pome twin start`: `*_DB` (the SQLite path) and `*_NO_SEED` (serve what is
// in it). Env is passed in, never read off `process.env`, so these are pure.
import { describe, expect, it } from "vitest";
import { renderStateLines, resolveStandaloneDb, resolveStandaloneDbs } from "../../../src/twin/twinDb.js";
import { TWIN_NAME_LIST, TWIN_REGISTRY } from "../../../src/twin/registry.js";

describe("resolveStandaloneDb", () => {
  it("is in memory for every twin when nothing is set", () => {
    for (const twin of TWIN_NAME_LIST) {
      expect(resolveStandaloneDb(twin, undefined, {}), twin).toMatchObject({
        dbPath: ":memory:",
        noSeed: false,
      });
    }
  });

  it("honours each twin's own *_DB and ignores every other twin's", () => {
    for (const twin of TWIN_NAME_LIST) {
      const { dbEnvName } = TWIN_REGISTRY[twin];
      const env: NodeJS.ProcessEnv = { [dbEnvName]: `.pome/${twin}.db` };
      expect(resolveStandaloneDb(twin, undefined, env).dbPath, twin).toBe(`.pome/${twin}.db`);
      for (const other of TWIN_NAME_LIST) {
        if (other === twin) continue;
        expect(resolveStandaloneDb(other, undefined, env).dbPath, `${other} read ${dbEnvName}`).toBe(
          ":memory:",
        );
      }
    }
  });

  it("treats an empty *_DB as unset rather than as a path", () => {
    expect(resolveStandaloneDb("stripe", undefined, { STRIPE_CLONE_DB: "" }).dbPath).toBe(":memory:");
  });

  it("reads *_NO_SEED the way the twin's own entry does — exactly '1'", () => {
    for (const twin of TWIN_NAME_LIST) {
      const { noSeedEnvName } = TWIN_REGISTRY[twin];
      expect(resolveStandaloneDb(twin, undefined, { [noSeedEnvName]: "1" }).noSeed, twin).toBe(true);
      // The container entry compares against "1" and nothing else, so neither
      // does this: a twin that skipped its seed on "true" here and applied it
      // in the pod is the divergence F-1758 exists to remove.
      for (const truthy of ["true", "yes", "0", ""]) {
        expect(
          resolveStandaloneDb(twin, undefined, { [noSeedEnvName]: truthy }).noSeed,
          `${twin} on ${noSeedEnvName}=${truthy}`,
        ).toBe(false);
      }
    }
  });

  it("refuses --seed together with the twin's no-seed variable, naming both", () => {
    expect(() =>
      resolveStandaloneDb("gmail", "seed.json", { GMAIL_TWIN_NO_SEED: "1" }),
    ).toThrowError(/--seed seed\.json and GMAIL_TWIN_NO_SEED=1 contradict each other/);
  });

  it("leaves POME_SEED_JSON to CONTRACT.md's precedence rule instead of refusing", () => {
    // "A provider-specific no-seed variable takes precedence over
    // POME_SEED_JSON and skips all boot seeding" — env against env is already
    // ruled on; only a `--seed` typed at this command is a contradiction.
    const resolved = resolveStandaloneDb("gmail", undefined, {
      GMAIL_TWIN_NO_SEED: "1",
      POME_SEED_JSON: '{"primaryMailbox":{"email":"a@b.test"}}',
    });
    expect(resolved.noSeed).toBe(true);
  });

  it("resolves one entry per twin, each with its own pair of variables", () => {
    const dbs = resolveStandaloneDbs(["stripe", "gmail"], undefined, {
      STRIPE_CLONE_DB: ".pome/stripe.db",
      GMAIL_TWIN_NO_SEED: "1",
    });
    expect(dbs.get("stripe")).toMatchObject({ dbPath: ".pome/stripe.db", noSeed: false });
    expect(dbs.get("gmail")).toMatchObject({ dbPath: ":memory:", noSeed: true });
  });
});

describe("renderStateLines", () => {
  const dbOf = (twin: "stripe", env: NodeJS.ProcessEnv) => resolveStandaloneDb(twin, undefined, env);

  it("says nothing survives Ctrl-C in memory, and names the variable that changes it", () => {
    const lines = renderStateLines("stripe", { source: "default" }, dbOf("stripe", {}));
    expect(lines).toContain("Seed: the stripe twin's default");
    expect(lines).toContain("State: in memory — nothing survives Ctrl-C (set STRIPE_CLONE_DB=<path>");
  });

  it("names the file, and that the seed still overwrites it on the next boot", () => {
    const lines = renderStateLines(
      "stripe",
      { source: "file", path: "world.json" },
      dbOf("stripe", { STRIPE_CLONE_DB: ".pome/stripe.db" }),
    );
    expect(lines).toContain("Seed: world.json (replaces the stripe twin's default).");
    expect(lines).toContain(
      "State: .pome/stripe.db (STRIPE_CLONE_DB), re-seeded on every boot — STRIPE_CLONE_NO_SEED=1 keeps what is there.",
    );
  });

  it("says the seed was not applied when the twin is serving a saved db", () => {
    const lines = renderStateLines(
      "stripe",
      { source: "default" },
      dbOf("stripe", { STRIPE_CLONE_DB: ".pome/stripe.db", STRIPE_CLONE_NO_SEED: "1" }),
    );
    expect(lines).toBe(
      "Seed: not applied (STRIPE_CLONE_NO_SEED=1).\n" +
        "State: .pome/stripe.db (STRIPE_CLONE_DB), served as it stands.",
    );
  });

  it("warns that a suppressed seed with no db path is simply an empty twin", () => {
    const lines = renderStateLines(
      "stripe",
      { source: "default" },
      dbOf("stripe", { STRIPE_CLONE_NO_SEED: "1" }),
    );
    expect(lines).toContain("State: in memory and unseeded, so this twin starts empty");
  });
});
