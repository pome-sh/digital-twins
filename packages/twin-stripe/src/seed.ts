// SPDX-License-Identifier: Apache-2.0
// v1 default seed mints exactly one api key (sk_test_pome_default → sid="default").
// Other twin state is empty by design — agent runs create their own PIs.
//
// The seed shape also accepts prerequisite Stripe state
// (payment_intents / charges / refunds / balance_transactions) so scenarios
// can stand up "agent walks in mid-flow" situations like scenario 14's
// refund-retry double-charge. Each new collection mirrors the wire shape
// returned by `GET /v1/<resource>/:id`; on apply, rows are inserted directly
// into the same SQLite tables the domain helpers write to, so a seeded row
// is indistinguishable from one created by `simulateCryptoDeposit` /
// `POST /v1/refunds` on read.
import { z } from "zod";
// `@pome-sh/sdk/failure-injection-rules` rather than `@pome-sh/sdk/server`: this
// module is part of the DECLARATION surface `@pome-sh/checks` bundles, and
// `/server` is the whole twin engine — hono, hono/jwt, node:sqlite and the
// recorder, 14 runtime modules — reached for one zod schema. The narrow
// subpath is 2. Importing the barrel here put an HTTP server and a SQLite
// driver inside a package whose entire job is to hand out zod schemas and
// check declarations. `twin.ts` and `routes/_helpers.ts` still use `/server`,
// which is correct: they ARE the server.
import { failureInjectionRuleSchema } from "@pome-sh/sdk/failure-injection-rules";
import type { SeedState } from "./types.js";

// ⚠️ THIS MODULE IS A ZOD-ONLY LEAF, AND `twin-chunks` NOW ENFORCES IT.
// It may import `zod`, type-only modules, and other leaves — nothing that
// reaches `./domain/`, `./db.ts` or the package root. The write half
// (`applySeed` and its row inserts) lives in `./apply-seed.ts` for that reason;
// before the split, `@pome-sh/twin-stripe/seed` was the one twin subpath whose
// documented "zod-only leaf" claim was false, and it is what stopped the CLI
// importing this schema instead of hand-copying it (F-584).

// `parseSeed` RETURNS a `SeedState`, so a consumer reaching this module through
// `@pome-sh/twin-stripe/seed` could not name its own variable's type: the symbol
// was declared in `./types.js`, which is not a subpath export. The other four
// twins export their parsed-seed type from `seed.ts` beside `parseSeed`
// (`ParsedGitHubStateSeed`, `ParsedGmailStateSeed`, `ParsedLinearStateSeed`);
// this is stripe catching up, not a new surface.
export type { SeedState } from "./types.js";

export const DEFAULT_SID = "default";
export const DEFAULT_API_KEY = "sk_test_pome_default";

const PI_STATUSES = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
  "canceled",
  "succeeded",
] as const;

const CHARGE_STATUSES = ["pending", "succeeded", "failed"] as const;
const REFUND_STATUSES = ["succeeded", "pending", "failed", "canceled"] as const;
const BALANCE_TX_STATUSES = ["pending", "available"] as const;

const paymentIntentSeedSchema = z.strictObject({
  id: z.string().min(1),
  account_id: z.string().min(1),
  amount: z.number().int(),
  currency: z.string().min(1),
  status: z.enum(PI_STATUSES),
  payment_method_types: z.array(z.string()).default(["crypto"]),
  next_action: z.unknown().nullable().optional(),
  latest_charge_id: z.string().nullable().optional(),
  capture_method: z.string().default("automatic"),
  confirmation_method: z.string().default("automatic"),
  idempotency_key: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).default({}),
  crypto_deposit: z.unknown().nullable().optional(),
  client_secret: z.string().min(1),
  created: z.number().int(),
  updated: z.number().int(),
  canceled_at: z.number().int().nullable().optional(),
  captured_at: z.number().int().nullable().optional(),
});

const chargeSeedSchema = z.strictObject({
  id: z.string().min(1),
  account_id: z.string().min(1),
  payment_intent_id: z.string().min(1),
  amount: z.number().int(),
  amount_captured: z.number().int().default(0),
  amount_refunded: z.number().int().default(0),
  status: z.enum(CHARGE_STATUSES),
  balance_transaction_id: z.string().nullable().optional(),
  captured: z.boolean().default(true),
  currency: z.string().min(1),
  created: z.number().int(),
});

const refundSeedSchema = z.strictObject({
  id: z.string().min(1),
  account_id: z.string().min(1),
  charge_id: z.string().min(1),
  payment_intent_id: z.string().min(1),
  amount: z.number().int(),
  currency: z.string().min(1),
  status: z.enum(REFUND_STATUSES),
  reason: z.string().nullable().optional(),
  balance_transaction_id: z.string().nullable().optional(),
  idempotency_key: z.string().nullable().optional(),
  created: z.number().int(),
});

const balanceTransactionSeedSchema = z.strictObject({
  id: z.string().min(1),
  account_id: z.string().min(1),
  type: z.string().min(1),
  amount: z.number().int(),
  fee: z.number().int().default(0),
  net: z.number().int(),
  currency: z.string().min(1),
  source_id: z.string().nullable().optional(),
  source_type: z.string().nullable().optional(),
  available_on: z.number().int(),
  status: z.enum(BALANCE_TX_STATUSES).default("available"),
  created: z.number().int(),
});

export type PaymentIntentSeed = z.infer<typeof paymentIntentSeedSchema>;
export type ChargeSeed = z.infer<typeof chargeSeedSchema>;
export type RefundSeed = z.infer<typeof refundSeedSchema>;
export type BalanceTransactionSeed = z.infer<typeof balanceTransactionSeedSchema>;

export const seedSchema = z.strictObject({
  api_keys: z
    .array(
      z.strictObject({
        key: z.string().min(1),
        sid: z.string().min(1),
        account_id: z.string().min(1).optional()
      })
    )
    .default([]),
  failure_injection: z.array(failureInjectionRuleSchema).default([]),
  payment_intents: z.array(paymentIntentSeedSchema).default([]),
  charges: z.array(chargeSeedSchema).default([]),
  refunds: z.array(refundSeedSchema).default([]),
  balance_transactions: z.array(balanceTransactionSeedSchema).default([]),
});

/** See `withoutSidecarMeta` in `@pome-sh/twin-github`'s seed module: `_meta` is
 *  the provenance block `pome compile-seeds` stamps on a sidecar, dropped at the
 *  twin's own door so all four seed channels agree, and deliberately not a
 *  declared seed field. */
function withoutSidecarMeta(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  if (!("_meta" in (input as Record<string, unknown>))) return input;
  const { _meta, ...rest } = input as Record<string, unknown>;
  void _meta;
  return rest;
}

export function parseSeed(input: unknown): SeedState {
  return seedSchema.parse(withoutSidecarMeta(input));
}

/**
 * Boot-time seed loader: prefer `POME_SEED_JSON` env (set by the cloud
 * control-plane from the CLI-supplied scenario seed;  +
 * and fall back to `defaultSeed()` when the env is absent.
 *
 * Unwrap contract: scenarios may send the
 * canonical wrapped shape `{ stripe: { seed: {...} } }` (what scenario
 * 14 uses) or the flat shape `{ payment_intents: [...], ... }`. We peel
 * `body.stripe?.seed ?? body` so both shapes work end-to-end without
 * a cloud-side rewrite. Throws on malformed JSON or schema-invalid
 * seed, so a misconfigured cloud deploy fails the twin server's
 * healthz instead of silently booting with an empty Stripe world.
 */
/**
 * `Record<string, string | undefined>` rather than `NodeJS.ProcessEnv`, which is
 * structurally the same thing but an AMBIENT global. This signature is vendored
 * into `@pome-sh/checks`'s published declarations, and an ambient reference there
 * makes a consumer's `tsc` fail with TS2503 unless they happen to have
 * `@types/node` installed — a dependency this package should not impose to
 * describe a plain string map.
 */
export function loadSeedFromEnv(env: Record<string, string | undefined> = process.env): SeedState {
  const raw = env.POME_SEED_JSON;
  if (raw === undefined || raw === "") {
    return defaultSeed();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `POME_SEED_JSON is not valid JSON: ${(err as Error).message}`
    );
  }
  const unwrapped = unwrapStripeSeed(parsed);
  return parseSeed(unwrapped);
}

function unwrapStripeSeed(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const stripeKey = (value as Record<string, unknown>).stripe;
    if (stripeKey && typeof stripeKey === "object" && !Array.isArray(stripeKey)) {
      const inner = (stripeKey as Record<string, unknown>).seed;
      if (inner !== undefined) {
        return inner;
      }
    }
  }
  return value;
}

export function defaultSeed(): SeedState {
  return {
    api_keys: [
      { key: DEFAULT_API_KEY, sid: DEFAULT_SID, account_id: `acct_${DEFAULT_SID}` }
    ],
    failure_injection: [],
    payment_intents: [],
    charges: [],
    refunds: [],
    balance_transactions: [],
  };
}

