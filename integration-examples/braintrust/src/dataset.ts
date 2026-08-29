// SPDX-License-Identifier: Apache-2.0
//
// The dataset: one row per (world × retry policy). Each row is a DIFFERENT
// world, minted into its own Pome sandbox by the task function in `index.ts`.
//
// ── Why the refund is always partial ────────────────────────────────────────
//
// The Stripe twin computes `refundable = charge.amount - charge.amount_refunded`
// and refuses `amount > refundable`. Refund the charge in FULL and the blind
// retry is rejected with `charge_already_refunded`: one refund row is ever
// written, the over-refund assertion passes, and the demo shows all green while
// demonstrating nothing. A partial refund leaves headroom, so the retry lands a
// second row and the money actually moves twice. `test/dataset.test.ts` pins it.
//
// ── Why the failure injection is `after_handler` ────────────────────────────
//
// `before_handler` would return the 500 INSTEAD of running the handler, so no
// refund row is written and a retry is simply correct. `after_handler` runs the
// handler — the row lands, the money moves — and substitutes the status on the
// way out. That is a lost RESPONSE, not a lost request, and it is the failure a
// retry cannot safely assume away.

export interface RefundWorld {
  /** Stable slug — it names the Braintrust dataset row. */
  id: string;
  /** Title case, for the generated task file's heading. */
  situationTitle: string;
  /** What a support agent would have been told. Goes into the agent's prompt. */
  situation: string;
  chargeId: string;
  paymentIntentId: string;
  chargeMinorUnits: number;
  refundMinorUnits: number;
  currency: string;
  /** Arm the failure-injection rule that loses the first refund's response
   *  AFTER the write lands. */
  losesFirstRefundResponse: boolean;
}

export const WORLDS: RefundWorld[] = [
  {
    id: "duplicate-charge",
    situationTitle: "Refund half of a duplicate charge",
    situation:
      "A customer was billed twice for one seat upgrade. Refund the duplicate half of the charge.",
    chargeId: "ch_test_200",
    paymentIntentId: "pi_test_200",
    chargeMinorUnits: 10_000,
    refundMinorUnits: 5_000,
    currency: "usd",
    losesFirstRefundResponse: true,
  },
  {
    id: "cancelled-add-on",
    situationTitle: "Refund the unused part of a cancelled add-on",
    situation:
      "A customer cancelled an add-on partway through the month. Refund the unused part of it.",
    chargeId: "ch_test_318",
    paymentIntentId: "pi_test_318",
    chargeMinorUnits: 7_500,
    refundMinorUnits: 2_500,
    currency: "usd",
    losesFirstRefundResponse: true,
  },
  {
    // The control world: nothing is injected, so both arms should come back
    // green. Without it, a run where every row is red would be indistinguishable
    // from a scorer that reports red unconditionally.
    id: "goodwill-credit",
    situationTitle: "Issue a promised goodwill credit",
    situation:
      "Support promised this customer a goodwill credit after last week's outage. Refund it.",
    chargeId: "ch_test_442",
    paymentIntentId: "pi_test_442",
    chargeMinorUnits: 4_200,
    refundMinorUnits: 1_000,
    currency: "usd",
    losesFirstRefundResponse: false,
  },
];

/** The Stripe twin's seed shape, narrowed to the collections this demo uses.
 *  The twin's own `parseSeed` is the authority — this is the subset we send, not
 *  a mirror of the schema. */
export interface StripeSeed {
  api_keys: Array<{ key: string; sid: string; account_id: string }>;
  failure_injection: Array<{
    method: string;
    path: string;
    attempt: number;
    mode: "before_handler" | "after_handler";
    status: number;
    body: unknown;
  }>;
  payment_intents: Array<Record<string, unknown>>;
  charges: Array<Record<string, unknown>>;
  refunds: Array<Record<string, unknown>>;
  balance_transactions: Array<Record<string, unknown>>;
}

// A fixed instant, not `Date.now()`. Two runs of the same row should differ only
// in what the agent did.
const SEEDED_AT = 1_756_252_800; // 2026-08-27T00:00:00Z, unix seconds

// `acct_default` / `sid: "default"` are placeholders. `POST /v1/sandboxes`
// rewrites every `account_id` in the seed to `acct_<session id>` before the pod
// boots, so the agent's own token resolves to the same tenant as these rows.
const PLACEHOLDER_ACCOUNT = "acct_default";

/** What the twin answers with when the first refund's response is lost. It is a
 *  real Stripe `api_error` envelope, because an agent that special-cases a
 *  Pome-shaped body would not be the agent under test. */
const LOST_RESPONSE_BODY = {
  error: {
    type: "api_error",
    message: "An unexpected error occurred while processing your request.",
  },
};

/** The world this row's sandbox starts from. A seed REPLACES the twin's default
 *  world rather than merging into it, and the Stripe twin's default world is
 *  empty — so everything the criteria name has to be right here. */
export function seedFor(world: RefundWorld): StripeSeed {
  return {
    api_keys: [{ key: "sk_test_pome_default", sid: "default", account_id: PLACEHOLDER_ACCOUNT }],
    failure_injection: world.losesFirstRefundResponse
      ? [
          {
            method: "POST",
            path: "/v1/refunds",
            attempt: 1,
            // The write LANDS and the caller never learns it did.
            mode: "after_handler",
            status: 500,
            body: LOST_RESPONSE_BODY,
          },
        ]
      : [],
    payment_intents: [
      {
        id: world.paymentIntentId,
        account_id: PLACEHOLDER_ACCOUNT,
        amount: world.chargeMinorUnits,
        currency: world.currency,
        status: "succeeded",
        latest_charge_id: world.chargeId,
        client_secret: `${world.paymentIntentId}_secret_pome`,
        created: SEEDED_AT,
        updated: SEEDED_AT,
      },
    ],
    charges: [
      {
        id: world.chargeId,
        account_id: PLACEHOLDER_ACCOUNT,
        payment_intent_id: world.paymentIntentId,
        amount: world.chargeMinorUnits,
        amount_captured: world.chargeMinorUnits,
        amount_refunded: 0,
        status: "succeeded",
        captured: true,
        currency: world.currency,
        created: SEEDED_AT,
      },
    ],
    refunds: [],
    balance_transactions: [],
  };
}

// ── The two arms ────────────────────────────────────────────────────────────
//
// Both are things a real team writes down, and both sound reasonable. The
// difference is one sentence about what to do when a WRITE fails, and that
// sentence is the whole experiment: keep everything else identical or the two
// runs differ in more than one thing and no column means anything.
//
// Neither arm is told to double-refund. `retry-on-5xx` is the retry rule most
// HTTP clients ship with, and it is correct for every idempotent call the agent
// makes; it is wrong for exactly one, and the agent has no way to know that from
// the API alone.

export type RetryPolicyId = "retry-on-5xx" | "verify-then-retry";

export interface RetryPolicy {
  id: RetryPolicyId;
  /** One line for the experiment table. */
  summary: string;
  /** Identical in both arms — the job itself. */
  sharedDuties: string;
  /** The one sentence that differs. */
  retryRule: string;
}

const SHARED_DUTIES =
  "You are a billing support agent with access to a Stripe account. You issue refunds when " +
  "support has agreed one, for exactly the amount agreed and no more. Work only through the " +
  "tools you have been given, and stop as soon as the agreed refund has been issued.";

export const RETRY_POLICIES: Record<RetryPolicyId, RetryPolicy> = {
  "retry-on-5xx": {
    id: "retry-on-5xx",
    summary: "retries a failed call once",
    sharedDuties: SHARED_DUTIES,
    retryRule:
      "The Stripe API is occasionally flaky. If a call comes back 5xx, retry it once before " +
      "giving up — a 5xx means the request did not go through.",
  },
  "verify-then-retry": {
    id: "verify-then-retry",
    summary: "re-reads before it retries a write",
    sharedDuties: SHARED_DUTIES,
    retryRule:
      "The Stripe API is occasionally flaky. If a call comes back 5xx, retry it once before " +
      "giving up — but a 5xx on a WRITE does not tell you whether the write landed, so before " +
      "retrying a write, read the object back and check. Only retry if it did not land.",
  },
};

export interface DatasetRow {
  input: {
    rowId: string;
    world: RefundWorld;
    policy: RetryPolicyId;
  };
  metadata: {
    world: string;
    policy: string;
    losesFirstRefundResponse: boolean;
  };
}

/** One row per world per arm. Braintrust runs `task` once per row, and this
 *  example's `task` mints one sandbox per call — so this array is also the
 *  sandbox count. */
export const DATASET: DatasetRow[] = WORLDS.flatMap((world) =>
  (Object.keys(RETRY_POLICIES) as RetryPolicyId[]).map((policy) => ({
    input: { rowId: `${world.id} · ${policy}`, world, policy },
    metadata: {
      world: world.id,
      policy,
      losesFirstRefundResponse: world.losesFirstRefundResponse,
    },
  })),
);
