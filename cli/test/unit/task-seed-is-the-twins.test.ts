// SPDX-License-Identifier: Apache-2.0
//
// A stripe or slack task seed the task parser accepts must be a seed the twin
// can boot. It was not.
//
// Three of `taskSchema`'s five arms imported the twin's own schema. slack and
// stripe were HAND-WRITTEN mirrors, because both had to be `.strict()` and the
// twins' schemas were not — a constraint F-1689 removed. #488 fixed the
// top-level key sets and `task-seed-mirror.test.ts` gated them, but the ROWS
// under those keys stayed `z.record(z.string(), z.unknown())`: an open map,
// validating nothing. Measured 2026-08-29:
//
//   task schema  { charges: [{ id: "ch_1" }] }                    ACCEPTED
//   stripe twin  same seed                                        REFUSED
//   task schema  { charges: [{ …, amount_refunfed: 20000 }] }     ACCEPTED
//   stripe twin  same seed                                        REFUSED
//   task schema  { channels: [{ name: "eng", mesages: [] }] }     ACCEPTED
//   slack twin   same seed                                        REFUSED
//
// So `pome eval` blessed the task and the world failed to boot — the exam ran
// against a world nobody authored, or against no world at all. Both arms are
// the twin's own object now, which is the same fix F-581 made one layer up and
// the reason `packages/twin-stripe/src/seed.ts` had to become the zod-only leaf
// it was already documented as.

import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedSchema as slackTwinSeedSchema } from "@pome-sh/twin-slack/seed";
import { seedSchema as stripeTwinSeedSchema } from "@pome-sh/twin-stripe/seed";
import { parseTaskFile } from "../../src/task/parseTask.js";
import { slackSeedStateSchema, stripeSeedStateSchema } from "../../src/task/taskSchema.js";

describe("the task parser's stripe and slack arms ARE the twins' schemas", () => {
  it("stripe", () => {
    expect(stripeSeedStateSchema).toBe(stripeTwinSeedSchema);
  });

  it("slack", () => {
    expect(slackSeedStateSchema).toBe(slackTwinSeedSchema);
  });
});

function task(twin: string): string {
  return [
    "# Test task",
    "",
    "## Prompt",
    "",
    "Do the thing.",
    "",
    "## Success Criteria",
    "",
    "- [code] Stub criterion",
    "",
    "## Seed State",
    "",
    "(the sidecar wins)",
    "",
    "## Config",
    "",
    "```yaml",
    `twins: [${twin}]`,
    "```",
    "",
  ].join("\n");
}

async function parseWithSidecar(twin: string, seed: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "pome-task-seed-"));
  const mdPath = join(dir, "task.md");
  await writeFile(mdPath, task(twin));
  await writeFile(join(dir, "task.seed.json"), JSON.stringify(seed));
  return parseTaskFile(mdPath);
}

const SETTLED_CHARGE = {
  id: "ch_test_200",
  account_id: "acct_default",
  payment_intent_id: "pi_test_200",
  amount: 20000,
  amount_captured: 20000,
  amount_refunded: 20000,
  status: "succeeded",
  captured: true,
  currency: "usd",
  created: 1700000000,
};

// Each row is a seed the task door used to bless and the twin then refused.
const BLESSED_THEN_REFUSED: Array<{ what: string; twin: string; seed: unknown; names: RegExp }> = [
  {
    what: "stripe: a charge with nothing but an id",
    twin: "stripe",
    seed: { charges: [{ id: "ch_test_200" }] },
    names: /account_id|payment_intent_id|amount/,
  },
  {
    what: "stripe: a charge whose `amount_refunded` is misspelled",
    twin: "stripe",
    seed: { charges: [{ ...SETTLED_CHARGE, amount_refunfed: 20000 }] },
    names: /amount_refunfed/,
  },
  {
    what: "stripe: a failure-injection rule with no status",
    twin: "stripe",
    seed: { failure_injection: [{ method: "POST", path: "/v1/refunds", attempt: 1 }] },
    names: /status/,
  },
  {
    what: "slack: a channel whose `messages` is misspelled",
    twin: "slack",
    seed: { channels: [{ name: "eng-alerts", mesages: [] }] },
    names: /mesages/,
  },
  {
    what: "slack: a channel name real Slack would refuse",
    twin: "slack",
    seed: { channels: [{ name: "Eng Alerts!" }] },
    names: /name/,
  },
  {
    what: "slack: an emoji alias that is not an emoji name",
    twin: "slack",
    seed: { emoji: [{ name: "shipit", alias: "NOT AN ALIAS" }] },
    names: /alias/,
  },
];

describe("a seed the task parser accepts is a seed the twin boots", () => {
  it.each(BLESSED_THEN_REFUSED)("$what", async ({ twin, seed, names }) => {
    await expect(parseWithSidecar(twin, seed)).rejects.toThrow(names);
  });
});

// The direction the ticket names first: a field the twin models must survive
// the task door untouched, not be widened into an unvalidated blob and not be
// refused. `refunds` and `balance_transactions` are the two the task-side
// schema modelled for neither of the two releases before #488.
describe("a field the twin models survives the task door", () => {
  it("stripe: refunds and balance_transactions land, fully typed", async () => {
    const parsed = await parseWithSidecar("stripe", {
      api_keys: [{ key: "sk_test_pome_default", sid: "default", account_id: "acct_default" }],
      charges: [SETTLED_CHARGE],
      refunds: [
        {
          id: "re_test_200",
          account_id: "acct_default",
          charge_id: "ch_test_200",
          payment_intent_id: "pi_test_200",
          amount: 20000,
          currency: "usd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: 1700000000,
        },
      ],
      balance_transactions: [
        {
          id: "txn_test_200",
          account_id: "acct_default",
          type: "charge",
          amount: 20000,
          fee: 620,
          net: 19380,
          currency: "usd",
          available_on: 1700000000,
          created: 1700000000,
        },
      ],
    });
    const seed = parsed.seedState as unknown as {
      refunds: Array<{ reason: string }>;
      balance_transactions: Array<{ net: number; status: string }>;
    };
    expect(seed.refunds[0]!.reason).toBe("requested_by_customer");
    expect(seed.balance_transactions[0]!.net).toBe(19380);
    // A default the twin applies and the old open-record mirror could not.
    expect(seed.balance_transactions[0]!.status).toBe("available");
  });

  it("slack: emoji lands, with the twin's own defaults filled", async () => {
    const parsed = await parseWithSidecar("slack", {
      emoji: [{ name: "shipit", alias: "squirrel" }],
      channels: [{ name: "eng-alerts", messages: [{ user: "alice", text: "hi" }] }],
    });
    const seed = parsed.seedState as unknown as {
      emoji: Array<{ name: string; alias?: string }>;
      channels: Array<{ name: string; is_private: boolean; members: string[] }>;
    };
    expect(seed.emoji[0]).toEqual({ name: "shipit", alias: "squirrel" });
    // `is_private` and `members` are the twin's defaults; the open-record
    // mirror returned the author's object verbatim and filled nothing.
    expect(seed.channels[0]!.is_private).toBe(false);
    expect(seed.channels[0]!.members).toEqual([]);
  });
});

// What the deleted mirrors were carrying that must not be lost with them.
describe("what the mirrors had to keep doing, and still do", () => {
  it.each([
    { twin: "slack", schema: slackSeedStateSchema },
    { twin: "stripe", schema: stripeSeedStateSchema },
  ])("$twin: the legacy `{ <twin>: { seed } }` wrapper fails loudly", ({ schema }) => {
    // Without strictness this parsed to an EMPTY seed instead of failing —
    // the case the `.strict()` mirrors were added for. The twins' own schemas
    // are strict now (F-1689), so the property survives the deletion.
    expect(schema.safeParse({ seed: {} }).success).toBe(false);
  });

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

  it("slack: an empty seed still fills its collections", () => {
    const parsed = slackSeedStateSchema.parse({}) as {
      users: unknown[];
      channels: unknown[];
      files: unknown[];
    };
    expect(parsed.users).toEqual([]);
    expect(parsed.channels).toEqual([]);
    expect(parsed.files).toEqual([]);
  });

  it("stripe: the default single-api-key seed still parses", () => {
    const parsed = stripeSeedStateSchema.parse({
      api_keys: [{ key: "sk_test_pome_default", sid: "default", account_id: "acct_default" }],
    }) as { api_keys: unknown[] };
    expect(parsed.api_keys).toHaveLength(1);
  });
});
