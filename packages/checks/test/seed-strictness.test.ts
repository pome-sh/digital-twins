// SPDX-License-Identifier: Apache-2.0
//
// A seed field nobody spelled right must be REFUSED, not dropped.
//
// Plain `z.object()` strips an unrecognised key, so a misspelled field is not an
// error — it is an absence. Measured 2026-08-29 against `parseSeed`:
//
//   github  { repositories: [{ owner, name, isuses: [ … ] }] }  → ACCEPTED, issues []
//   slack   { chanels: [ … ] }                                  → ACCEPTED, channels []
//   stripe  { charges: [], typo_key: 1 }                        → ACCEPTED, key gone
//
// The author asked for a world with an issue in it and got a world with no
// issue, a green boot and nothing anywhere saying so. gmail and linear were
// already `.strict()` at every level, which is what makes this a gate rather
// than a preference: three of five twins agreed and two did not.
//
// ⚠️ THIS FILE IS THE DERIVATION, not a list. `everyObjectIn` walks each twin's
// own zod tree, so a nested object added later WITHOUT strictness reds here even
// though nothing in this file names it. A hand-written list of paths would go
// stale on the first new seed field — which is precisely how the drift under
// F-581 / F-584 happened.
//
// This package is where the walk lives because it is the only one that has all
// five twins in scope, and because `@pome-sh/checks` is the SQLite-free door
// pome-cloud reaches `parseSeed` through: a strictness regression here is a
// strictness regression on the hosted seed door.

import { describe, expect, it } from "vitest";
import type { $ZodType } from "zod/v4/core";

import * as github from "../src/github.js";
import * as gmail from "../src/gmail.js";
import * as linear from "../src/linear.js";
import * as slack from "../src/slack.js";
import * as stripe from "../src/stripe.js";

type SeedParse = (input: unknown) => unknown;

/** One row per twin: the schema to walk, the door to call, and the smallest
 *  seed that twin accepts — the base a typo is then added to, so the ONLY
 *  reason a case fails is the typo. */
const TWINS = [
  {
    twin: "github",
    schema: github.seedSchema as unknown as $ZodType,
    parseSeed: github.parseSeed as SeedParse,
    minimal: { repositories: [{ owner: "zed", name: "quiet" }] },
    // A misspelling of a real field, at a real path, the way a human makes it.
    nested: {
      repositories: [{ owner: "zed", name: "quiet", isuses: [{ title: "dropped" }] }],
    },
    nestedKey: "isuses",
  },
  {
    twin: "slack",
    schema: slack.seedSchema as unknown as $ZodType,
    parseSeed: slack.parseSeed as SeedParse,
    minimal: {},
    nested: { channels: [{ name: "eng-alerts", mesages: [] }] },
    nestedKey: "mesages",
  },
  {
    twin: "stripe",
    schema: stripe.seedSchema as unknown as $ZodType,
    parseSeed: stripe.parseSeed as SeedParse,
    minimal: {},
    nested: {
      api_keys: [{ key: "sk_test_pome_default", sid: "default", acount_id: "acct_default" }],
    },
    nestedKey: "acount_id",
  },
  {
    twin: "gmail",
    schema: gmail.gmailSeedSchema as unknown as $ZodType,
    parseSeed: gmail.parseSeed as SeedParse,
    minimal: { primaryMailbox: { email: "ops@vakoi.test" } },
    nested: { primaryMailbox: { email: "ops@vakoi.test", mesages: [] } },
    nestedKey: "mesages",
  },
  {
    twin: "linear",
    schema: linear.linearSeedSchema as unknown as $ZodType,
    parseSeed: linear.parseSeed as SeedParse,
    minimal: {},
    nested: { teams: [{ key: "ENG", name: "Engineering", stats: [] }] },
    nestedKey: "stats",
  },
] as const;

/** Unwrap `.optional()`, `.default()`, `.nullable()`, `.prefault()` and pipes
 *  down to the schema that actually carries a shape. */
function unwrap(schema: unknown): { type?: string; [k: string]: unknown } | undefined {
  let node = schema as { _zod?: { def?: Record<string, unknown> } } | undefined;
  for (let depth = 0; depth < 50; depth++) {
    const def = node?._zod?.def;
    if (!def) return undefined;
    if (def.innerType) {
      node = def.innerType as typeof node;
      continue;
    }
    if (def.type === "pipe" && def.out) {
      node = def.out as typeof node;
      continue;
    }
    return def as { type?: string };
  }
  return undefined;
}

/** Every object node in a schema tree, by dotted path. `seen` breaks the cycle a
 *  recursive schema would otherwise spin on. */
function everyObjectIn(
  schema: unknown,
  path: string[] = [],
  seen = new Set<unknown>(),
): Array<{ path: string; strict: boolean }> {
  const def = unwrap(schema);
  if (!def || seen.has(def)) return [];
  seen.add(def);
  const here = path.join(".") || "<root>";
  if (def.type === "object") {
    const shape = def.shape as Record<string, unknown>;
    const catchall = unwrap(def.catchall)?.type;
    return [
      { path: here, strict: catchall === "never" },
      ...Object.entries(shape).flatMap(([key, child]) =>
        everyObjectIn(child, [...path, key], seen),
      ),
    ];
  }
  if (def.type === "array") return everyObjectIn(def.element, [...path, "[]"], seen);
  if (def.type === "union") {
    return (def.options as unknown[]).flatMap((option, i) =>
      everyObjectIn(option, [...path, `|${i}`], seen),
    );
  }
  return [];
}

describe("every object in every twin's seed schema refuses an unknown key", () => {
  it.each(TWINS)("$twin", ({ schema }) => {
    const objects = everyObjectIn(schema);
    // The walk finding nothing would pass the assertion below vacuously.
    expect(objects.length).toBeGreaterThan(3);
    expect(objects.filter((node) => !node.strict).map((node) => node.path)).toEqual([]);
  });
});

describe("parseSeed refuses a key no seed field matches", () => {
  it.each(TWINS)("$twin: at the top level, naming the key", ({ parseSeed, minimal }) => {
    expect(() => parseSeed(minimal)).not.toThrow();
    expect(() => parseSeed({ ...minimal, isuses: [] })).toThrow(/isuses/);
  });

  it.each(TWINS)("$twin: nested, naming the key", ({ parseSeed, nested, nestedKey }) => {
    expect(() => parseSeed(nested)).toThrow(new RegExp(nestedKey));
  });
});

// `pome compile-seeds` stamps a `_meta` provenance block on every
// `<task>.seed.json` it writes, and eight of the twenty sidecars in
// agent-examples/ carry it INSIDE the twin's own arm (`{ github: { _meta, … } }`)
// where no top-level strip can reach it. `parseTask` and `pome twin start --seed`
// each strip their own; `POME_SEED_JSON` and the hosted `seed` field never did,
// and survived only because the schemas were non-strict. Declaring it in the
// twin's own door is the one place all four channels pass through.
//
// It is dropped rather than declared as a field: `seedFields()` derives the
// door's key list from the schema's shape, and `_meta` appearing there would put
// Pome's provenance block in the reader's list of things a seed can say.
describe("`_meta` is provenance, not a seed field", () => {
  const META = { version: 1, source_hash: "sha256:hand-authored", model: "hand-authored" };

  it.each(TWINS)("$twin: accepts it and does not return it", ({ parseSeed, minimal }) => {
    const parsed = parseSeed({ _meta: META, ...minimal }) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain("_meta");
  });

  it.each(TWINS)("$twin: does not make it a seed field", ({ schema }) => {
    const def = unwrap(schema);
    expect(Object.keys(def?.shape as Record<string, unknown>)).not.toContain("_meta");
  });
});
