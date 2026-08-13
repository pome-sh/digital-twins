// SPDX-License-Identifier: Apache-2.0
//
// The published surface is a CONTRACT with a cross-repo consumer, and the way
// it breaks is not a build error. pome-cloud's `lib/twin-state.ts` boots these
// domains in-process; a renamed or dropped export compiles fine on both sides
// of this repo and dies as `undefined is not a constructor` on the grader — or
// worse, `checks-package-drift.test.ts` goes red with no legal move, which is
// the wall F-1524 exists to take down. So this file pins the surface by NAME
// rather than trusting `export *`.
//
// It deliberately does NOT re-assert every check id: each twin's own
// `checks-contract.test.ts` owns the per-twin vocabulary and
// `packages/checks/test/surface.test.ts` owns the vocabulary package's shape.
// What it pins is exactly F-1526's export spec — the table measured from
// pome-cloud's own imports — plus the one property that makes this package
// worth publishing at all: its `*_CHECKS` tuples are the SAME objects
// `@pome-sh/checks` serves, because both are cut from the same `main` commit.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import * as barrel from "../src/index.js";
import * as github from "../src/github.js";
import * as gmail from "../src/gmail.js";
import * as linear from "../src/linear.js";
import * as server from "../src/server.js";
import * as slack from "../src/slack.js";
import * as stripe from "../src/stripe.js";

const CANONICAL_TWINS: readonly string[] = JSON.parse(
  readFileSync(new URL("../../../config/first-party-twins.json", import.meta.url), "utf8"),
).twins;

/**
 * F-1526's export spec, verbatim. Measured 2026-08-13 from pome-cloud at
 * `287755c0`: `apps/control-plane/src/lib/twin-state.ts:58-84`,
 * `checks-package-drift.test.ts`, `lib/twin-tape-pull.ts`, and
 * `apps/mcp/src/lib/capture.ts`.
 *
 * `scripts/ci/check-sandbox-domains-tarball.mjs` asserts the same table against the
 * PACKED bytes. Both, on purpose: this one fails in the PR that breaks it with a
 * readable diff, that one fails before a broken tarball reaches the registry.
 */
const EXPORT_SPEC = {
  github: ["GitHubDomain", "openGitHubCloneDatabase", "parseSeed", "GITHUB_CHECKS"],
  gmail: ["GmailDomain", "openGmailTwinDatabase", "parseSeed", "GMAIL_CHECKS"],
  linear: ["LinearDomain", "openLinearTwinDatabase", "parseSeed", "LINEAR_CHECKS"],
  slack: ["SlackDomain", "openSlackTwinDatabase", "parseSeed", "SLACK_CHECKS"],
  stripe: [
    "StripeDomain",
    "openTwinStripeDatabase",
    "parseSeed",
    "applySeed",
    "STRIPE_CHECKS",
  ],
} as const;

const MODULES: Record<keyof typeof EXPORT_SPEC, Record<string, unknown>> = {
  github,
  gmail,
  linear,
  slack,
  stripe,
};

describe("the export spec measured from pome-cloud", () => {
  for (const [twin, symbols] of Object.entries(EXPORT_SPEC)) {
    it(`./${twin} exports every symbol pome-cloud imports`, () => {
      const module = MODULES[twin as keyof typeof EXPORT_SPEC];
      for (const symbol of symbols) {
        expect(module[symbol], `${twin}.${symbol}`).toBeDefined();
      }
    });
  }

  // The entry that retires the last frozen `@pome-sh/sdk@0.11.1` pin in BOTH
  // pome-cloud manifests (F-1527, step 2).
  it("./server exports toTwinHttpEventRow", () => {
    expect(typeof server.toTwinHttpEventRow).toBe("function");
  });

  it("toTwinHttpEventRow stamps the discriminator and the event id", () => {
    const row = server.toTwinHttpEventRow({ request_id: "req_1" } as never);
    expect(row.kind).toBe("TwinHttpEvent");
    expect(row.event_id).toBe("req_1");
    // Not a stub: the twin runs in its own process and cannot know the
    // agent-side event that caused the call. See the sdk's own doc comment.
    expect(row.parent_event_id).toBeNull();
  });
});

describe("the domain layer is a runtime, not a second declarations package", () => {
  for (const [twin, symbols] of Object.entries(EXPORT_SPEC)) {
    it(`./${twin}'s domain and opener are callable values`, () => {
      const module = MODULES[twin as keyof typeof EXPORT_SPEC];
      const [domain, opener] = symbols;
      expect(typeof module[domain], `${twin}.${domain}`).toBe("function");
      expect(typeof module[opener], `${twin}.${opener}`).toBe("function");
    });
  }

  // The property that makes this package the thing pome-cloud can actually
  // BOOT: an in-memory database opens and the domain constructs over it. A
  // package whose openers are present but non-functional passes every
  // name-shaped assertion above and fails on the grader.
  it("opens a real database and constructs a domain over it", () => {
    const db = github.openGitHubCloneDatabase(":memory:");
    expect(db).toBeTruthy();
    expect(new github.GitHubDomain(db)).toBeInstanceOf(github.GitHubDomain);
  });

  it("parses a seed through the shipped schema", () => {
    const parsed = github.parseSeed(github.defaultSeedState());
    expect(parsed).toBeTruthy();
  });
});

describe("barrel", () => {
  it("covers exactly the canonical first-party twins", () => {
    expect([...barrel.SANDBOX_DOMAIN_NAMES].sort()).toEqual([...CANONICAL_TWINS].sort());
    expect(Object.keys(barrel.SANDBOX_DOMAINS).sort()).toEqual([...CANONICAL_TWINS].sort());
  });

  it("gives every twin a domain constructor and a database opener", () => {
    for (const [twin, entry] of Object.entries(barrel.SANDBOX_DOMAINS)) {
      expect(typeof entry.Domain, `${twin}.Domain`).toBe("function");
      expect(typeof entry.openDatabase, `${twin}.openDatabase`).toBe("function");
    }
  });

  // The five twins all name their seed parser `parseSeed`, so the barrel has to
  // prefix them or four of the five silently lose. This is the assertion that a
  // future `export *` "simplification" would red.
  it("prefixes the colliding per-twin names", () => {
    for (const name of [
      "parseGitHubSeed",
      "parseGmailSeed",
      "parseLinearSeed",
      "parseSlackSeed",
      "parseStripeSeed",
    ]) {
      expect(typeof (barrel as Record<string, unknown>)[name], name).toBe("function");
    }
    // …and does not re-export the bare colliding name from the barrel at all.
    expect((barrel as Record<string, unknown>).parseSeed).toBeUndefined();
  });

  it("exposes one non-empty vocabulary per twin", () => {
    for (const [twin, checks] of Object.entries({
      github: barrel.GITHUB_CHECKS,
      gmail: barrel.GMAIL_CHECKS,
      linear: barrel.LINEAR_CHECKS,
      slack: barrel.SLACK_CHECKS,
      stripe: barrel.STRIPE_CHECKS,
    })) {
      expect(Array.isArray(checks), twin).toBe(true);
      expect(checks.length, twin).toBeGreaterThan(0);
    }
  });
});

// The reason both packages can publish from one allocator run and agree by
// construction: they re-export the SAME tuple object from the same twin, so
// there is no copy that could drift. pome-cloud's `checks-package-drift.test.ts`
// compares them across an npm boundary, where identity is gone and only the
// declared fields survive — this is the cheap in-repo half of that.
describe("the vocabulary is shared with @pome-sh/checks, not copied", () => {
  it("serves the identical tuple object each twin declares", async () => {
    const twinGithub = await import("@pome-sh/twin-github/checks");
    expect(github.GITHUB_CHECKS).toBe(twinGithub.GITHUB_CHECKS);
    const twinStripe = await import("@pome-sh/twin-stripe/checks");
    expect(stripe.STRIPE_CHECKS).toBe(twinStripe.STRIPE_CHECKS);
  });
});

// The property the `zod` PEER dependency exists to guarantee, asserted from the
// consumer's side of it.
//
// This file imports zod itself, exactly as pome-cloud does, and the schemas the
// package hands back must be values of THAT zod — not of a second copy bundled
// inside the tarball. Two zod copies is the F-942 bug: `instanceof` starts
// failing and `.parse()` results stop being interchangeable, and nothing at
// runtime announces it, which is why it needs an assertion rather than a
// convention. `check-sandbox-domains-tarball.mjs` covers the other half (zod is
// never inlined into the shipped bytes); this covers the half a tarball scan
// cannot see, which is that the objects are the same IDENTITY at run time.
describe("zod is the consumer's, not a bundled copy", () => {
  it("hands back schemas the importing module's own zod recognises", () => {
    expect(github.seedSchema).toBeInstanceOf(z.ZodType);
    expect(slack.seedSchema).toBeInstanceOf(z.ZodType);
    expect(stripe.seedSchema).toBeInstanceOf(z.ZodType);
    expect(gmail.gmailSeedSchema).toBeInstanceOf(z.ZodType);
    expect(linear.linearSeedSchema).toBeInstanceOf(z.ZodType);
  });

  it("round-trips a seed this test's zod parsed", () => {
    // The shape pome-cloud actually performs: parse with the package's schema,
    // hand the result back to the package. A second zod identity survives the
    // first call and fails here.
    const parsed = github.seedSchema.parse(github.defaultSeedState());
    expect(github.parseSeed(parsed)).toBeTruthy();
  });
});
