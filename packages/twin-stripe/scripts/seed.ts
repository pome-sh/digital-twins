// pome:unwired-ok(seed): dev utility that seeds a local DB for manual poking. Asserts nothing, and the seeded state CI relies on comes from src/seed.ts, which the suites drive directly.

// SPDX-License-Identifier: Apache-2.0
import { openTwinStripeDatabase } from "../src/db.js";
import { applySeed, defaultSeed } from "../src/seed.js";

const dbPath = process.env.STRIPE_CLONE_DB ?? ".stripe_clone/stripe.db";
const db = openTwinStripeDatabase(dbPath);
applySeed(db, defaultSeed());
db.close();

console.log(`Seeded twin-stripe database at ${dbPath}`);
