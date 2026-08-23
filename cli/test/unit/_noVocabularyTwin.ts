// SPDX-License-Identifier: Apache-2.0
// A twin that EXISTS but declares no vocabulary yet — derived, never named.

import { twinsWithoutChecks } from "../../src/cli/checks.js";

/** Not a real twin, and not meant to look like one. */
export const SYNTHETIC_UNDECLARED_TWIN = "undeclared-twin-fixture";

/** A twin id for which `checksFor(id)` is empty. NOT guaranteed to satisfy
 *  `isKnownTwin` — see `checks-command.test.ts` for the command-level branch. */
export function twinWithoutChecks(): string {
  return twinsWithoutChecks()[0] ?? SYNTHETIC_UNDECLARED_TWIN;
}
