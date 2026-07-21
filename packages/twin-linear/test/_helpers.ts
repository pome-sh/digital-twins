// SPDX-License-Identifier: Apache-2.0
import { defaultSeedState, type LinearStateSeed } from "../src/index.js";

/** Default seed without outbound webhooks (avoids 10s fetch timeouts in unit tests). */
export function testSeed(overrides: LinearStateSeed = {}): LinearStateSeed {
  return {
    ...defaultSeedState(),
    ...overrides,
    webhooks: overrides.webhooks ?? [],
  };
}
