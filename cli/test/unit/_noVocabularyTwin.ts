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
// A3 empties `TWINS_WITHOUT_CHECKS` entirely. When it does, `twinWithoutChecks()`
// throws with the message below rather than letting these tests quietly stop
// covering anything — because at that point the no-vocabulary path has no live
// input, and whether it should still exist is a decision somebody has to make on
// purpose.

import { twinsWithoutChecks } from "../../src/cli/checks.js";

export const NO_VOCABULARY_TWIN_GONE =
  "every twin now declares a vocabulary, so the no-vocabulary path has no live input. " +
  "Decide deliberately: keep the path with a synthetic twin id, or delete it and these tests.";

export function twinWithoutChecks(): string {
  const twin = twinsWithoutChecks()[0];
  if (twin === undefined) throw new Error(NO_VOCABULARY_TWIN_GONE);
  return twin;
}
