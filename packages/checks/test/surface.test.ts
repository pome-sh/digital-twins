// SPDX-License-Identifier: Apache-2.0
//
// The published surface is a CONTRACT with a cross-repo consumer, and the way it
// breaks is not a build error. pome-cloud resolves a criterion to a declaration
// by id; a renamed or dropped check id compiles fine on both sides and simply
// stops binding, and a criterion that stops binding scores nothing. So this file
// pins the surface by name rather than trusting `export *`.
//
// It deliberately does NOT snapshot every check id — `checks-contract.test.ts`
// in each twin already owns the per-twin vocabulary, and duplicating 46 ids here
// would be a second registration seam to drift. What it pins is the shape
// pome-cloud reaches for: the five arrays, the seed trio per twin, and the DSL
// symbols its 13 `@pome-sh/sdk/checks` import sites use.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import * as barrel from "../src/index.js";
import * as dsl from "../src/dsl.js";
import * as github from "../src/github.js";
import * as gmail from "../src/gmail.js";
import * as linear from "../src/linear.js";
import * as slack from "../src/slack.js";
import * as stripe from "../src/stripe.js";

const CANONICAL_TWINS: readonly string[] = JSON.parse(
  readFileSync(new URL("../../../config/first-party-twins.json", import.meta.url), "utf8"),
).twins;

describe("barrel", () => {
  it("exports one non-empty vocabulary per twin", () => {
    for (const [twin, checks] of Object.entries(barrel.TWIN_CHECKS)) {
      expect(Array.isArray(checks), twin).toBe(true);
      expect(checks.length, twin).toBeGreaterThan(0);
    }
  });

  // The twin list is derived from `config/first-party-twins.json` everywhere else
  // in this repo (`check-first-party-twin-registration.mjs` is the gate). A sixth
  // twin whose vocabulary never reached this package would otherwise be a
  // criterion that silently never binds — the exact failure this ticket exists
  // to stop.
  it("covers exactly the canonical first-party twins", () => {
    expect([...barrel.CHECKS_TWIN_NAMES].sort()).toEqual([...CANONICAL_TWINS].sort());
    expect(Object.keys(barrel.TWIN_CHECKS).sort()).toEqual([...CANONICAL_TWINS].sort());
  });

  it("prefixes the seed helpers by twin, since all five share three names", () => {
    for (const name of [
      "parseGitHubSeed",
      "parseGmailSeed",
      "parseLinearSeed",
      "parseSlackSeed",
      "parseStripeSeed",
      "githubSeedSchema",
      "gmailSeedSchema",
      "linearSeedSchema",
      "slackSeedSchema",
      "stripeSeedSchema",
      "defaultGitHubSeed",
      "defaultGmailSeed",
      "defaultLinearSeed",
      "defaultSlackSeed",
      "defaultStripeSeed",
    ]) {
      expect(barrel, name).toHaveProperty(name);
    }
  });

  // Runtime behaviour, not just presence: a default seed that throws on its own
  // schema would pass a name check and fail every grading run.
  it("round-trips each twin's default seed through its own schema", () => {
    const pairs = [
      ["github", barrel.defaultGitHubSeed, barrel.parseGitHubSeed],
      ["gmail", barrel.defaultGmailSeed, barrel.parseGmailSeed],
      ["linear", barrel.defaultLinearSeed, barrel.parseLinearSeed],
      ["slack", barrel.defaultSlackSeed, barrel.parseSlackSeed],
      ["stripe", barrel.defaultStripeSeed, barrel.parseStripeSeed],
    ] as const;
    for (const [twin, makeSeed, parse] of pairs) {
      expect(() => parse(makeSeed() as unknown), twin).not.toThrow();
    }
  });
});

// The invariant the whole packaging strategy exists to protect (F-942). zod is a
// `peerDependency` and tsup must never inline it: if it does, the seed schemas
// this package hands out are built from a DIFFERENT zod than the one the
// consumer imports, and nothing announces it — `.parse()` still returns an
// object, `instanceof` quietly stops holding, and a schema composed across the
// boundary throws somewhere unrelated.
//
// This is the source-level half; `scripts/ci/check-checks-tarball.mjs` asserts
// the same thing about the built tarball, where the bundler is what could break
// it. Both are needed: this one would pass on a bundle that inlined zod, and that
// one cannot see whether the schemas are zod at all.
describe("zod schema identity", () => {
  const schemas = [
    ["github", barrel.githubSeedSchema],
    ["gmail", barrel.gmailSeedSchema],
    ["linear", barrel.linearSeedSchema],
    ["slack", barrel.slackSeedSchema],
    ["stripe", barrel.stripeSeedSchema],
  ] as const;

  it("builds every seed schema from the zod THIS package resolves", () => {
    for (const [twin, schema] of schemas) {
      expect(schema, twin).toBeInstanceOf(z.ZodType);
    }
  });

  // Composition is the sharpest test: a schema from a foreign zod fails to
  // compose even when `instanceof` happens to pass.
  it("composes with a consumer-authored schema", () => {
    for (const [twin, schema] of schemas) {
      const wrapped = z.object({ seed: schema });
      expect(() => wrapped.parse({ seed: undefined }), twin).toThrow(z.ZodError);
    }
  });
});

describe("dsl", () => {
  // The symbols pome-cloud's 13 `@pome-sh/sdk/checks` import sites use. `export *`
  // means an ADDITION needs no edit here; this list is what makes a REMOVAL a
  // named failure in this repo instead of a TypeError in the consumer's.
  it("re-exports the check DSL pome-cloud imports", () => {
    for (const name of [
      "defineCheck",
      "parseCheck",
      "renderCheck",
      "checkPattern",
      "checkNearMissPattern",
      "checksDigest",
      "templateSlots",
      "statePath",
      "childStatePath",
      "resolveStatePath",
      "oneOf",
      "repoRef",
      "probeDiscrimination",
      "probeStateCitation",
      "VACUITY_SENTINEL",
      "VACUITY_SENTINEL_NUMBER",
      "VACUITY_SENTINEL_SNAKE",
    ]) {
      expect(dsl, name).toHaveProperty(name);
    }
  });

  it("is reachable from the barrel too", () => {
    expect(barrel.defineCheck).toBe(dsl.defineCheck);
    expect(barrel.VACUITY_SENTINEL).toBe(dsl.VACUITY_SENTINEL);
  });
});

describe("per-twin subpaths", () => {
  // Each subpath keeps the twin's OWN names, so a pome-cloud import site moves
  // by changing the specifier and nothing else.
  const modules = { github, gmail, linear, slack, stripe } as const;
  const arrays = {
    github: "GITHUB_CHECKS",
    gmail: "GMAIL_CHECKS",
    linear: "LINEAR_CHECKS",
    slack: "SLACK_CHECKS",
    stripe: "STRIPE_CHECKS",
  } as const;

  for (const [twin, module] of Object.entries(modules)) {
    it(`${twin} exposes its array, parseSeed and a schema under the twin's own names`, () => {
      expect(module).toHaveProperty(arrays[twin as keyof typeof arrays]);
      expect(module).toHaveProperty("parseSeed");
      const schemaNames = ["seedSchema", "gmailSeedSchema", "linearSeedSchema"];
      expect(schemaNames.some((name) => name in module), `${twin} seed schema`).toBe(true);
    });

    // `applySeed` writes SQLite rows and `loadSeedFromEnv` reads process.env.
    // Both are twin RUNTIME behaviour; this package is declarations only, and the
    // runtime channel stays GHCR (F-1308).
    it(`${twin} does not leak runtime seed helpers`, () => {
      expect(module).not.toHaveProperty("applySeed");
      expect(module).not.toHaveProperty("loadSeedFromEnv");
    });
  }

  it("hands the barrel and the subpath the same array object", () => {
    expect(github.GITHUB_CHECKS).toBe(barrel.GITHUB_CHECKS);
    expect(stripe.STRIPE_CHECKS).toBe(barrel.STRIPE_CHECKS);
  });
});
