// SPDX-License-Identifier: Apache-2.0
//
// Does a declared check actually discriminate?
//
// Split from `checks.ts` because it is the other half of the relationship: that
// file DEFINES the grammar a declaration is written in, this one EXERCISES a
// declaration against the worlds it named. Consumers still import
// `probeDiscrimination` from `@pome-sh/sdk/checks`, which re-exports it.
//
// Pure — no vitest, no ledger. Each twin's contract test owns the admitted-null
// half, so a twin cannot satisfy the gate by shipping an empty ledger.

import type { CheckDefinition, CheckOutcome, DiscriminationVerdict } from "./checks.js";

// A real verdict, not an abstention. A `skipped` outcome in either world would
// let a check satisfy the gate by declining to answer twice.
function isRealPass(outcome: CheckOutcome): boolean {
  return outcome.passed === true && (outcome.status === undefined || outcome.status === "passed");
}
function isRealFail(outcome: CheckOutcome): boolean {
  return outcome.passed === false && (outcome.status === undefined || outcome.status === "failed");
}

const describeOutcome = (outcome: CheckOutcome): string =>
  `passed=${outcome.passed} status=${outcome.status ?? "-"} reason=${JSON.stringify(outcome.reason)}`;

/**
 * What this check says about a world with nothing in it, or null if it refuses
 * to say anything at all.
 *
 * Extracted so the catch RETURNS rather than falling through — D4's
 * no-catch-and-continue gate is right to forbid the assign-and-continue shape,
 * and the intent here really is "produce a value or none".
 */
function reasonOnEmptyWorld<TState, TArgs extends Record<string, string>>(
  def: CheckDefinition<TState, TArgs>,
  args: TArgs,
): string | null {
  try {
    return def.evaluate(args, { seed: {} as TState, final: {} as TState, tape: [] }).reason;
  } catch {
    // A predicate that THROWS on an empty world cannot have its failing world
    // confused with one, so arm 3 has nothing to compare against. It abstains
    // rather than inventing a failure.
    return null;
  }
}

/**
 * Run a check against the worlds it names and say whether they actually
 * discriminate. Pure: no vitest, no ledger — each twin's contract test owns the
 * ledger half, so an empty ledger cannot silently excuse anything.
 */
export function probeDiscrimination<TState, TArgs extends Record<string, string>>(
  def: CheckDefinition<TState, TArgs>,
  args: TArgs,
): DiscriminationVerdict {
  const worlds = def.discriminatingWorlds(args);
  if (worlds === null) return { kind: "declined" };

  const passing = def.evaluate(args, worlds.passing);
  if (!isRealPass(passing)) {
    return {
      kind: "broken",
      arm: "passing",
      detail: `passing world did not pass — ${describeOutcome(passing)}`,
    };
  }

  const failing = def.evaluate(args, worlds.failing);
  if (!isRealFail(failing)) {
    return {
      kind: "broken",
      arm: "failing",
      detail: `failing world did not fail — ${describeOutcome(failing)}`,
    };
  }

  // ARM 3, and the one the other two cannot cover. A failing world whose reason
  // is the reason an EMPTY world already produces fails through the check's
  // SELECTOR, not its assertion — measured on 11 of GitHub's 13 checks before
  // this arm existed.
  const degenerate = reasonOnEmptyWorld(def, args);
  if (degenerate !== null && failing.reason === degenerate) {
    return {
      kind: "broken",
      arm: "degenerate",
      detail:
        `the failing world's reason is the one an EMPTY world produces ` +
        `(${JSON.stringify(failing.reason)}), so it fails through its selector rather than ` +
        `its assertion`,
    };
  }

  return { kind: "discriminates" };
}
