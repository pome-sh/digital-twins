// SPDX-License-Identifier: Apache-2.0
//
// A twin that EXISTS but declares no vocabulary yet — derived, never named.
//
// Five tests named `stripe` inline and all five broke the moment stripe declared
// (F-1127). They were not testing stripe; they were testing the no-vocabulary
// PATH, and a literal there asserts the membership of a set that is deliberately
// shrinking. That is F-1075's hard-coded picker index one level up: "the
// vocabulary is a closed set that grows, so an index literal asserts the size of
// the set, not the behaviour of the picker."
//
// F-1129 EMPTIED THE SET, and this file is the decision that forced.
//
// The old contract was to throw here, so nobody could let these tests quietly
// stop covering anything. Answered: the PATH stays, the LITERAL goes. Two
// reasons, and neither is "deleting was harder":
//
//   1. THE PATH STILL HAS LIVE INPUT, just not from `MOUNTED_TWINS`.
//      `bindCriterion` and `runChecksLintCommand` reach it for ANY twin id this
//      CLI holds no declaration for, and a pinned CLI can always lag the twin
//      set — that is the entire premise of the digest handshake (F-1132,
//      F-1136). "Unanswerable, not a pass" is the D11 property those three
//      tests assert, and it is as live now as when stripe was undeclared.
//   2. `twinsWithoutChecks()` IS NOW DERIVED from `MOUNTED_TWINS` minus the
//      registry, so it repopulates by itself the day a sixth twin mounts. A
//      throw here would fire on a temporary state rather than on a defect.
//
// So: the real derived twin when one exists, a SYNTHETIC id when the set is
// empty. The synthetic id is deliberately not a plausible twin name — a test
// that starts depending on it being MOUNTED should fail rather than pass by
// accident.

import { twinsWithoutChecks } from "../../src/cli/checks.js";

/** Not a real twin, and not meant to look like one. */
export const SYNTHETIC_UNDECLARED_TWIN = "undeclared-twin-fixture";

/**
 * A twin id for which `checksFor(id)` is empty.
 *
 * NOT guaranteed to satisfy `isKnownTwin` — that is a different property, and
 * once every mounted twin declares, no id satisfies both at once. A test that
 * needs the COMMAND-level "not migrated yet" branch cannot use this; see
 * `checks-command.test.ts`, which asserts the emptiness itself instead.
 */
export function twinWithoutChecks(): string {
  return twinsWithoutChecks()[0] ?? SYNTHETIC_UNDECLARED_TWIN;
}
