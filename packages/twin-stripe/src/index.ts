// SPDX-License-Identifier: Apache-2.0
//
// Embeddable surface for the vendored Stripe twin: the pieces
// the in-process runner needs to boot, seed, drive, and export state — not
// the standalone server entrypoint. The twin assembles on the
// @pome-sh/sdk engine via defineTwin() (./twin.ts).
export { createStripeTwinDefinition, createTwinStripeApp, tthwSeconds } from "./twin.js";
export type { CreateStripeTwinDefinitionOptions, CreateTwinStripeAppOptions } from "./twin.js";
export { openTwinStripeDatabase, migrate, resetDatabase } from "./db.js";
export { StripeDomain } from "./domain/index.js";
export { defaultSeed, parseSeed, loadSeedFromEnv, seedSchema, DEFAULT_API_KEY, DEFAULT_SID } from "./seed.js";
// The seed's WRITE half. Beside the schemas on this root export, apart from them
// on the `/seed` subpath — that subpath is a zod-only leaf and `applySeed`
// reaches `./domain/schema.js` (F-584).
export { applySeed } from "./apply-seed.js";
export { registerStripeRoutes } from "./routes/index.js";
export { registerX402Routes } from "./session.js";
export { paymentMiddleware } from "./x402.js";
export { mintApiKey, resolveSidFromKey, revokeApiKey } from "./api-keys.js";
export {
  executeTool,
  isMutatingTool,
  stripeToolFixture,
  stripeToolInputSchema,
  toolArgumentSchemas,
} from "./tools.js";
export type { Recorder, ResolvedSession, SeedState, TwinStripeDatabase } from "./types.js";
