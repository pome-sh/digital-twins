// SPDX-License-Identifier: Apache-2.0
//
// Stripe — the twin's grading vocabulary and its seed contract.
//
// Re-exports `@pome-sh/twin-stripe/checks` and `@pome-sh/twin-stripe/seed` under the twin's own
// names (no copy: these are `export … from` lines, so there is nothing here that
// can drift from the twin), which means a pome-cloud import site moves by
// changing the specifier and nothing else.
// Both are reached through the twin's SUBPATH exports, never its package root:
// the root pulls the Hono app, the SQLite domain and ~40 tool schemas, none of
// which belongs in a declarations package (the same argument F-1306 made for
// the CLI's startup path).
//
// `applySeed` and `loadSeedFromEnv` are deliberately NOT re-exported.
// `applySeed` writes rows into a live SQLite database and `loadSeedFromEnv`
// reads `process.env` — both are twin-runtime behaviour, not declarations. The
// runtime channel is GHCR and stays GHCR (F-1308).
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
export { seedSchema, parseSeed, defaultSeed } from "@pome-sh/twin-stripe/seed";
export type { SeedState } from "@pome-sh/twin-stripe/seed";
