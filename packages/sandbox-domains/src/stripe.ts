// SPDX-License-Identifier: Apache-2.0
//
// Stripe — the domain runtime pome-cloud boots in-process. See `./github.ts`
// for why the domain and the opener come through the twin's package root while
// the seed and the vocabulary come through narrow subpaths.
//
// `applySeed` is here and is deliberately NOT in `@pome-sh/checks/stripe`: it
// writes rows into a live SQLite database, which is twin-runtime behaviour
// rather than a declaration, and a declarations package shipping it would be
// the engine leak `check-checks-tarball.mjs` refuses. This package IS the
// runtime, so it is exactly where the write side belongs — stripe is the one
// twin whose seed is applied as a separate step from parsing it.
export { StripeDomain } from "@pome-sh/twin-stripe";
// `applySeed` comes through the package ROOT, beside the domain and the opener,
// rather than through `/seed`: that subpath is a zod-only leaf and the write
// half lives in `apply-seed.ts` (F-584). The NAME this package exports has not
// moved — only where it reads it from.
export { applySeed } from "@pome-sh/twin-stripe";
export { openTwinStripeDatabase, migrate, resetDatabase } from "@pome-sh/twin-stripe";
export type { Recorder, ResolvedSession, TwinStripeDatabase } from "@pome-sh/twin-stripe";

export {
  DEFAULT_API_KEY,
  DEFAULT_SID,
  defaultSeed,
  parseSeed,
  seedSchema,
} from "@pome-sh/twin-stripe/seed";
export type {
  BalanceTransactionSeed,
  ChargeSeed,
  PaymentIntentSeed,
  RefundSeed,
  SeedState,
} from "@pome-sh/twin-stripe/seed";

export { STRIPE_CHECKS } from "@pome-sh/twin-stripe/checks";
export type { Check } from "@pome-sh/twin-stripe/checks";
export type {
  StripeCheckState,
  StripeCheckStateBalanceTransaction,
  StripeCheckStateCharge,
  StripeCheckStateEvent,
  StripeCheckStatePaymentIntent,
  StripeCheckStateRefund,
} from "@pome-sh/twin-stripe/checks";
