// SPDX-License-Identifier: Apache-2.0
//
// What protects a criterion whose redaction-destroyed literal is NOT its
// declared `subject` (F-1157).
//
// `subject` closes the DETECTABLE half of this class, and closes it at the
// door: the consuming engine renders the declared subject, runs it past the
// team's redaction pipeline, and — when the redactor destroys it — skips the
// criterion before `evaluate` is ever called. That arm reads the DECLARATION
// and never the state, deliberately, because that is what makes the authoring
// door and the scoring door agree by construction.
//
// The undetectable half arrived with a witness. `gmail.mailbox-label-count`
// declares `subject: ({ label }) => label`; its `{label}` (`SENT`) survives
// every first-party redactor, so the arm waves the criterion through. The slot
// that actually got eaten was `{mailbox}`, which `DEFAULT_REDACTION_CONFIG`
// masks (`mailboxes[].email`), and which the subject arm never looks at. The
// skip surfaced from INSIDE `evaluate` instead — safe, but by that one check's
// own guard, per check, with nothing measuring the class.
//
// This module measures the class.
//
// ─── The question, and why it takes BOTH worlds to ask ──────────────────────
//
// The naive probe destroys a slot's literal in the check's passing world and
// asks whether it still passes. That question cannot be answered: the passing
// world passes by construction, so "still passes" conflates the check that
// re-derived the same true fact from surviving state with the check whose
// assertion just became trivial. Measured over the five twins it called all ten
// of twin-github's `{repo}` slots a vacuous pass, when what actually happened is
// that `findRepo` matched on `owner`/`name` after `full_name` was masked — the
// predicate did its work, correctly, on a spelling the redactor had not eaten.
//
// So the question is asked of the FAILING world instead: destroy the literal
// there and see whether a real `failed` turns into a real `passed`. That is
// what a vacuous pass IS — a wrong agent blessed because the grader went blind —
// and it is a question with a definite answer, because `discriminatingWorlds`
// already guarantees that world fails for a reason the assertion owns.
//
// Both worlds still get destroyed and both verdicts read, because the passing
// arm carries the OTHER cost: a check that starts refusing (`abstains`) drops a
// criterion out of the denominator, and one that starts really failing
// (`false_fail`) marks a correct agent down for the grader's blindness. Neither
// is the defect the gate forbids, but a class nobody counted is how F-1157
// happened, so both are named and both are ledgered.
//
//   declared_subject       the engine already refuses at the door; `evaluate` is
//                          never reached, so there is nothing here to measure
//   vacuous_pass           the failing world PASSES with the literal gone. THE
//                          defect, and the one every twin's contract test
//                          forbids outright
//   abstains               the check's own guard returned `skipped` — the honest
//                          answer, and the one `gmail.mailbox-label-count` gives
//   false_fail             a real `failed` verdict computed over a state the
//                          predicate could not read
//   discriminates_anyway   both worlds kept their verdicts: the fact the
//                          predicate needed survives elsewhere in the export
//   absent_from_world      the literal appears in neither world, so no redactor
//                          could have eaten it — a count slot, an arity word, a
//                          `oneOf` member the world spells differently
//   throws                 the predicate crashed. Also never allowed: a
//                          criterion may leave the denominator, but it may not
//                          take the evaluator with it
//
// ─── Why the strictest reading of the world ─────────────────────────────────
//
// Same bargain `probeStateCitation` struck: it reuses the worlds a check ALREADY
// declares rather than asking for a second fixture, which is what makes the gate
// cheap enough to hold across five twins.
//
// The destruction is deliberately stricter than any redaction config we have
// seen: every occurrence of the literal, in `seed`, `final` AND `tape`, not just
// the one field a particular config names. `DEFAULT_REDACTION_CONFIG` masks
// `mailboxes[].email` and leaves `messages[].mailboxEmail` alone — but a team's
// redaction config is that team's to write, not the twin's to predict, and a
// safety property that holds only against the configs we happen to know is not a
// property. Whole-value equality rather than substring: a config masks a FIELD,
// and a literal that survives as a substring of some larger prose is exactly the
// case `subject` already covers at the door.
//
// ─── Two things it does not model, and one of them has a ticket ─────────────
//
// Stated because a gate whose reach is unwritten gets read as wider than it is.
//
// 1. A SECTION THAT IS ABSENT, rather than a value that was masked. This probe
//    only ever REPLACES strings; it never deletes a top-level collection, so a
//    check that reads `(final.reactions ?? []).some(…)` and scores a negative
//    criterion `passed` over an export carrying no `reactions` at all is
//    invisible here — and that is a live defect, not a hypothetical
//    (`slack.no-reaction-added`, F-1159, guarded in the consuming engine's
//    `STATE_SECTION_GUARDS` while its state lives in twin-slack). It is the same
//    direction of failure as `vacuous_pass` and a different axis of cause, so it
//    has its own instrument: the engine's `findVacuousStateSectionReaders`,
//    which swaps and deletes SECTIONS where this one destroys LITERALS. Neither
//    subsumes the other and a green run here says nothing about that one.
//
// 2. A redactor that eats a COMPONENT of a slot's literal rather than the
//    literal itself. twin-github spells `{repo}` three ways in one export
//    (`full_name`, and `owner` + `name` separately), and masking `owner` alone
//    would leave `acme/api` intact everywhere this probe looks while still
//    blinding `findRepo`'s second arm. That is a different question — "which
//    FIELDS does this predicate depend on" rather than "what happens when this
//    criterion's literal is destroyed" — and answering it needs a field-level
//    dependency declaration nothing in the vocabulary has. The decomposition is
//    why `github.issue-exists`'s `{repo}` reads `discriminates_anyway` here
//    rather than `abstains`.

import type { CheckDefinition, CheckOutcome } from "./checks.js";

/**
 * The token a scoring redactor leaves in place of a value it masked.
 *
 * Declared HERE rather than imported from `@pome-sh/wire`, and the distinction
 * is not pedantic. Wire's redactor scrubs secrets out of a recorded TRACE on the
 * way to disk; the redactor that eats a check's literal is the consuming
 * engine's STATE redactor, which runs in pome-cloud against a team's own config.
 * Two producers, two lifetimes — they agree on the bytes today, and making one
 * import the other's constant would assert a shared fact neither repo checks.
 *
 * So this is the check-side half of that contract, published on
 * `@pome-sh/checks/dsl` so the engine writing the token and the predicates
 * recognising it can read it from one place.
 */
export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Did a redactor eat this value?
 *
 * A recogniser, not a proof: a team whose config writes some other placeholder
 * gets `false` here, and the predicate that asked falls back to whatever it said
 * before — the status quo, never a wrong verdict. Which is why the vacuous-pass
 * gate below does not depend on this function at all: it destroys the literal
 * itself and reads the verdict, so a check that never calls `isRedacted` is
 * measured exactly as strictly as one that does.
 */
export function isRedacted(value: string | null | undefined): boolean {
  return value === REDACTION_PLACEHOLDER;
}

export type RedactionGuard =
  | "declared_subject"
  | "vacuous_pass"
  | "abstains"
  | "false_fail"
  | "discriminates_anyway"
  | "absent_from_world"
  | "throws";

export interface RedactionSurvivalRow {
  readonly param: string;
  readonly guard: RedactionGuard;
  // What the check said, verbatim, so a ledger entry can be read — and a drift
  // in it explained — without re-running the probe.
  readonly detail: string;
}

export type RedactionSurvivalVerdict =
  // Every declared slot classified, in `params` order.
  | { kind: "measured"; rows: readonly RedactionSurvivalRow[] }
  // The declaration named no worlds. The CALLER must find a ledger entry — this
  // function deliberately does not know about ledgers, exactly as
  // `probeDiscrimination` and `probeStateCitation` do not, so a twin cannot
  // satisfy the gate by shipping an empty one.
  | { kind: "declined" };

/**
 * The same tree with every occurrence of `literal` replaced by the placeholder.
 *
 * Case-insensitive, because every twin's predicates compare that way — a
 * redactor that masked `Pome-Agent@…` would otherwise read as untouched to a
 * check that would have matched it.
 *
 * Returns `hit` so the caller can tell "the redactor ate it" from "there was
 * nothing here to eat", which are different findings and get different names.
 */
function destroyLiteral(tree: unknown, literal: string): { tree: unknown; hit: boolean } {
  const wanted = literal.toLowerCase();
  let hit = false;

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (node.toLowerCase() !== wanted) return node;
      hit = true;
      return REDACTION_PLACEHOLDER;
    }
    if (Array.isArray(node)) return node.map(walk);
    // `typeof null === "object"`, so the null guard is not redundant.
    if (node === null || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, value]) => [key, walk(value)]),
    );
  };

  return { tree: walk(tree), hit };
}

interface World<TState> {
  seed: TState | null;
  final: TState;
  tape: readonly unknown[] | null;
}

function destroyWorld<TState>(
  world: World<TState>,
  literal: string,
): { world: World<TState>; hit: boolean } {
  const seed = destroyLiteral(world.seed, literal);
  const final = destroyLiteral(world.final, literal);
  const tape = destroyLiteral(world.tape, literal);
  return {
    world: {
      seed: seed.tree as TState | null,
      final: final.tree as TState,
      tape: tape.tree as readonly unknown[] | null,
    },
    hit: seed.hit || final.hit || tape.hit,
  };
}

const describeOutcome = (outcome: CheckOutcome): string =>
  `passed=${outcome.passed} status=${outcome.status ?? "-"} reason=${JSON.stringify(outcome.reason)}`;

/**
 * What the check says with one literal gone, or the crash it produced instead.
 *
 * The catch RETURNS rather than falling through, exactly as
 * `check-discrimination.ts`'s `reasonOnEmptyWorld` does: D4's
 * no-catch-and-continue gate is right to forbid the assign-and-continue shape,
 * and a predicate that crashes is itself one of the answers this probe reports.
 */
function say(evaluate: () => CheckOutcome): CheckOutcome | { threw: string } {
  try {
    return evaluate();
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

const isRealPass = (outcome: CheckOutcome): boolean =>
  outcome.passed === true && (outcome.status === undefined || outcome.status === "passed");

function classify(
  passing: CheckOutcome | { threw: string },
  failing: CheckOutcome | { threw: string },
): { guard: RedactionGuard; detail: string } {
  if ("threw" in passing) return { guard: "throws", detail: `passing world: ${passing.threw}` };
  if ("threw" in failing) return { guard: "throws", detail: `failing world: ${failing.threw}` };

  // FIRST, because it is the only one of these that is a wrong verdict rather
  // than a missing one: the world this check declared as its failure now reads
  // as a success, purely because the grader stopped being able to see.
  if (isRealPass(failing)) {
    return { guard: "vacuous_pass", detail: `failing world now passes — ${describeOutcome(failing)}` };
  }
  if (passing.status === "skipped") {
    return { guard: "abstains", detail: describeOutcome(passing) };
  }
  if (isRealPass(passing)) {
    return { guard: "discriminates_anyway", detail: describeOutcome(passing) };
  }
  return { guard: "false_fail", detail: `passing world now fails — ${describeOutcome(passing)}` };
}

/**
 * For every slot this check declares, what stands between a redactor that eats
 * that slot's literal and a vacuous pass.
 *
 * The subject arm is credited without evaluating: when the destroyed literal IS
 * (or is inside) the declared subject, the engine never calls `evaluate`, so
 * running the predicate anyway would measure a code path production cannot
 * reach and file its answer under this check's name.
 *
 * `includes`, not equality, on that comparison. A subject is usually one arg
 * verbatim, but a declaration may compose one, and a redactor that masks a
 * component masks the composed string too.
 */
export function probeRedactionSurvival<TState, TArgs extends Record<string, string>>(
  def: CheckDefinition<TState, TArgs>,
  args: TArgs,
): RedactionSurvivalVerdict {
  const worlds = def.discriminatingWorlds(args);
  if (worlds === null) return { kind: "declined" };

  const subject = def.subject?.(args) ?? null;
  const rows: RedactionSurvivalRow[] = [];

  for (const param of Object.keys(def.params)) {
    const literal = args[param as keyof TArgs];
    if (typeof literal !== "string" || literal === "") continue;

    if (subject !== null && subject.toLowerCase().includes(literal.toLowerCase())) {
      rows.push({
        param,
        guard: "declared_subject",
        detail: `the engine skips the criterion before evaluate — subject ${JSON.stringify(subject)}`,
      });
      continue;
    }

    const passing = destroyWorld(worlds.passing, literal);
    const failing = destroyWorld(worlds.failing, literal);
    if (!passing.hit && !failing.hit) {
      rows.push({
        param,
        guard: "absent_from_world",
        detail: `${JSON.stringify(literal)} appears in neither declared world`,
      });
      continue;
    }

    rows.push({
      param,
      ...classify(
        say(() => def.evaluate(args, passing.world as never)),
        say(() => def.evaluate(args, failing.world as never)),
      ),
    });
  }

  return { kind: "measured", rows };
}
