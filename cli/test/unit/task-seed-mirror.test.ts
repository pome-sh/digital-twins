// SPDX-License-Identifier: Apache-2.0
// The task parser's slack and stripe seed schemas are LOCAL mirrors of the
// twins', and this is the gate that stops them drifting.
//
// Three of the five arms in `taskSchema.ts` import the twin's own schema
// (`githubSeedStateSchema`, `gmailSeedStateSchema`, `linearSeedStateSchema`) and
// so cannot drift. slack and stripe are hand-written, because both are
// `.strict()` and that strictness is load-bearing for the union below them: it
// is what stops a github or stripe seed greedily matching the slack arm.
//
// Both had drifted, measured 2026-08-27:
//
//   slack   mirror lacked `emoji`                      (in the twin since #190)
//   stripe  mirror lacked `refunds`, `balance_transactions`,
//           and carried five keys the twin's seed schema does not have
//           (`customers`, `products`, `prices`, `events`, `balances`)
//
// Which meant `pome twin seed slack` output was refused by `parseTask` on
// `Unrecognized key: "emoji"`, and — the half that matters more — a HUMAN
// writing a slack task seed with `emoji` had never been able to. This is the
// same defect as the three broken doc examples: a copy with no gate. It had
// already been fixed once, for `files` (#432), and the fix was that instance
// rather than the class.
//
// ⚠️ THIS TEST IS THE DERIVATION. Deriving the key set inside `taskSchema.ts`
// was the first fix and `scripts/lint/rules/twin-chunks.mjs` refused it:
// `@pome-sh/twin-stripe/seed` statically imports `./domain/schema.js`, so it is
// not the zod-only leaf it is documented as, and a static import there puts
// stripe's domain in the graph `pome --version` loads. A test file is not in
// that graph, so the comparison lives here instead — which means this file
// failing IS the drift, not a symptom of it.
//
// Field ORDER is asserted too, not just membership: key order survives `parse()`
// into the object `parseTask` returns, so a mirror listing the same fields in a
// different order makes a parsed seed and a generated one differ by nothing but
// key order — enough to fail a byte comparison between them.

import { describe, expect, it } from "vitest";
import { seedSchema as slackTwinSeedSchema } from "@pome-sh/twin-slack/seed";
import { seedSchema as stripeTwinSeedSchema } from "@pome-sh/twin-stripe/seed";
import { slackSeedStateSchema, stripeSeedStateSchema } from "../../src/task/taskSchema.js";

const MIRRORS = [
  { twin: "slack", mirror: slackSeedStateSchema, real: slackTwinSeedSchema },
  { twin: "stripe", mirror: stripeSeedStateSchema, real: stripeTwinSeedSchema },
] as const;

function keysOf(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

describe("the task parser's seed mirrors name exactly the twin's fields, in order", () => {
  it.each(MIRRORS)("$twin", ({ mirror, real }) => {
    expect(keysOf(mirror as never)).toEqual(keysOf(real as never));
  });
});

describe("what the mirrors must keep doing", () => {
  it.each(MIRRORS)("$twin: stays .strict(), so an unknown key is loud", ({ mirror }) => {
    // The legacy `{ <twin>: { seed: … } }` wrapper is the case this was added
    // for: without `.strict()` it parses to an empty seed instead of failing.
    expect(() => (mirror as never as { parse(v: unknown): unknown }).parse({ seed: {} })).toThrow();
  });

  it("slack: an empty seed still fills its collections", () => {
    const parsed = slackSeedStateSchema.parse({});
    expect(parsed.users).toEqual([]);
    expect(parsed.channels).toEqual([]);
    expect(parsed.files).toEqual([]);
  });

  it("stripe: the default single-api-key seed still parses", () => {
    const parsed = stripeSeedStateSchema.parse({
      api_keys: [{ key: "sk_test_pome_default", sid: "default", account_id: "acct_default" }],
    });
    expect(parsed.api_keys).toHaveLength(1);
  });

  // The union in `taskSchema.ts` puts slack FIRST and relies on `.strict()` to
  // stop it swallowing its neighbours. Widening the mirror by a key set is only
  // safe while that still holds.
  it("slack does not greedily match a github seed", () => {
    expect(
      slackSeedStateSchema.safeParse({
        users: [{ login: "acme" }],
        repositories: [{ owner: "acme", name: "api" }],
      }).success,
    ).toBe(false);
  });

  it("slack does not greedily match a stripe seed", () => {
    expect(slackSeedStateSchema.safeParse({ api_keys: [], charges: [] }).success).toBe(false);
  });

  it("stripe does not greedily match a slack seed", () => {
    expect(stripeSeedStateSchema.safeParse({ team: {}, channels: [] }).success).toBe(false);
  });
});
