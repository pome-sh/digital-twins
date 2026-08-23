// The properties every declared check must hold, carried across from twin-github and
// twin-slack when Stripe's vocabulary moved out of pome-cloud.

import {
  checkNearMissPattern,
  checkPattern,
  parseCheck,
  probeDiscrimination,
  probeRedactionSurvival,
  probeStateCitation,
  renderCheck,
  type CheckDefinition,
  type CheckSubstrateKind,
  type RedactionGuard,
} from "@pome-sh/sdk/checks";
import { describe, expect, it } from "vitest";
import { STRIPE_CHECKS, type StripeCheckState } from "../src/checks.js";
import {
  chargeWithStatusExists,
  eventEmitted,
  paymentIntentAmount,
  paymentIntentStatusIs,
  paymentIntentWithStatusExists,
} from "../src/check-payments.js";
import { refundCount, refundExists } from "../src/check-refunds.js";
import {
  noRefundOnCharge,
  requestRejectedWithError,
  x402FirstRequestChallenged,
  x402RetryIncludesPayment,
} from "../src/check-tape.js";

// The declarations are a heterogeneous tuple, so iterating them yields a union
// whose args type differs per check, while the fixtures below are looked up by
// id at run time. That tie cannot be made statically — erase it once here
// rather than casting at a dozen call sites.
type OpenCheck = CheckDefinition<StripeCheckState, Record<string, string>>;
const CHECKS = STRIPE_CHECKS as readonly unknown[] as readonly OpenCheck[];

// Representative args per check. Every one is the value a SHIPPED criterion
// carries, so the properties below are exercised against the corpus's real
// arguments rather than invented ones — the two x402 checks have no slots, and
// `charge-exists-with-status` takes task 12's rewritten status.
//
// The coverage assertion makes this table impossible to forget: a new check with
// no fixture fails rather than silently skipping every property here.
const FIXTURES: Record<string, Record<string, string>> = {
  "stripe.payment-intent-amount": { amount: "10000" },
  "stripe.payment-intent-status": { status: "requires_action" },
  "stripe.payment-intent-with-status-exists": { status: "succeeded" },
  "stripe.charge-exists-with-status": { status: "succeeded" },
  "stripe.event-emitted": { event_type: "payment_intent.succeeded" },
  "stripe.refund-exists": { charge: "ch_test_200" },
  "stripe.refund-count": { charge: "ch_test_200", count: "1" },
  "stripe.no-refund-on-charge": { charge: "ch_test_200" },
  "stripe.request-rejected-with-error": { error_type: "invalid_request_error" },
  "stripe.x402-first-request-challenged": {},
  "stripe.x402-retry-includes-payment": {},
};

// Every check whose `vacuityMutant` returns null, WITH the reason. A null mutant
// is an admitted blind spot; admitting it in a ledger is what keeps it from
// becoming a habit.
//
// Nine of eleven, which is a higher share than twin-github's eight of thirteen —
// so it is worth stating what it actually costs, rather than letting the ratio
// stand as a worry.
//
// The vacuity probe only samples criteria that PASSED on their own seed: its
// question is whether a passing verdict was reached without the trigger clause
// ever being evaluated. Ten of stripe's eleven checks are POSITIVE and their
// shipped criteria fail on their seeds — nothing to sample. The one shipped
// stripe criterion the probe can take is task 19's
// `No refund was attempted on charge "ch_test_200"`, a negative that passes on
// its seed, and that check keeps a REAL mutant. So the measured loss from these
// nine is zero criteria, not nine.
//
// Two arguments earn a line, both inherited:
//   1. THE PARAMETER ONLY SELECTS. Falsifying it moves the verdict for a reason
//      that never reaches the assertion — a clean bill the check did not earn.
//   2. THE PARAMETER IS A CLOSED SET. Typing a slot as `oneOf` means no member is
//      guaranteed false, so a mutant could assert a different state that happens
//      to be true as well, and a value outside the set does not re-bind at all.
//      This is the price of the closed set, and it is worth paying — but it must
//      be admitted, not hidden.
const HONEST_NULL_MUTANTS: Record<string, string> = {
  "stripe.payment-intent-status": "the status is a closed set of seven; nothing else is a slot",
  "stripe.payment-intent-with-status-exists": "the status is a closed set of seven",
  "stripe.charge-exists-with-status": "the status is a closed set of three",
  "stripe.event-emitted": "the event type is a closed set of fifteen — the twin's `EventType` union",
  "stripe.refund-exists": "the charge is a selector, not a scanned literal — a miss skips",
  // Both arguments at once, which is why it gets the longest line: there are two
  // slots and neither is a trigger.
  "stripe.refund-count":
    "the charge only selects (a miss skips) and the count IS the assertion — mutating it " +
    "asserts a different thing rather than falsifying this one",
  "stripe.request-rejected-with-error": "the error type is a closed set of five",
  "stripe.x402-first-request-challenged":
    "the sentence has no slots at all; the trigger is a status code on the first call to one " +
    "path, which no mutation of the criterion text can reach",
  "stripe.x402-retry-includes-payment":
    "the sentence has no slots at all; the trigger is a header NAME fixed by the sentence, " +
    "so there is nothing an author supplied to falsify",
};

// twin-github ledgers REPO_FREE_CHECKS here. Stripe has no analogue, and its
// ABSENCE is argued rather than assumed.
//
// The repo rule exists because GitHub's legacy patterns took `in owner/repo` as
// an optional qualifier and, absent it, scanned repositories first-match-wins —
// so a two-repo world silently graded whichever sorted first. Stripe's export is
// ACCOUNT-SCOPED before a check ever sees it (`exportState(accountId)`), and a
// session authenticates as exactly one account, so there is no second scope for
// a slot to disambiguate.
//
// Where the same hazard DOES appear here it is closed by a different mechanism:
// `stripe.payment-intent-status` refuses (`unmatched`) on a multi-intent world
// rather than scanning first-match-wins, and `A PaymentIntent exists with status
// …` is the separate check for when several are expected. That is the
// first-match-wins problem answered by two checks instead of by a slot.

const SUBSTRATES: CheckSubstrateKind[] = ["final", "seed+final", "tape"];

describe("declared check identity", () => {
  it("declares a non-empty, twin-prefixed id for every check", () => {
    for (const check of CHECKS) {
      expect(check.id, "every check needs an id").toBeTruthy();
      expect(check.id.startsWith("stripe."), `${check.id} must be namespaced <twin>.<what>`).toBe(
        true,
      );
    }
  });

  it("keeps ids unique across the twin's declarations", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const check of CHECKS) {
      if (seen.has(check.id)) duplicates.push(check.id);
      seen.add(check.id);
    }
    expect(duplicates, `duplicate check ids: ${duplicates.join(", ")}`).toEqual([]);
  });

  it("declares polarity and a vacuity mutant on every check", () => {
    for (const check of CHECKS) {
      expect(typeof check.polarity, `${check.id}.polarity`).toBe("function");
      expect(typeof check.vacuityMutant, `${check.id}.vacuityMutant`).toBe("function");
    }
  });

  it("declares a known substrate on every check", () => {
    for (const check of CHECKS) {
      expect(SUBSTRATES, `${check.id}.substrate`).toContain(check.substrate);
    }
  });

  it("has a fixture for every check, so no check skips the properties below", () => {
    const missing = CHECKS.filter((check) => !FIXTURES[check.id]).map((check) => check.id);
    expect(missing, `checks with no FIXTURES entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("says what the predicate actually compares, in words the sentence does not carry", () => {
    // The one defect this architecture makes EASIER, not harder: a rendered
    // sentence wider or narrower than its check (Shankar et al., UIST '24
    // §7.3.3 — readable surfaces hide the disagreement code makes visible).
    // `The first request returns 402` reads as a claim about every request; the
    // predicate looks only at the x402 surface. An authoring surface can only
    // show what is declared, so the gap has to close here — and in that case it
    // closed by renaming the sentence rather than by explaining it away.
    for (const check of CHECKS) {
      expect(check.description?.trim(), `${check.id} declares no description`).toBeTruthy();
      expect(
        check.description.trim(),
        `${check.id}'s description just restates its template — it must say what the ` +
          `predicate COMPARES, which is the thing the sentence cannot carry`,
      ).not.toBe(check.template);
    }
  });

  it("declares a polarity that reads the args where the args can change it", () => {
    // `refund-count` is the only check here whose direction depends on its
    // arguments, and it is the reason `polarity` takes them at all: "is 0" is a
    // prohibition its seed already satisfies, "is 1" is something that must come
    // to exist. A constant here would mis-score one of the two.
    expect(refundCount.polarity({ charge: "ch_test_200", count: "0" })).toBe("negative");
    expect(refundCount.polarity({ charge: "ch_test_200", count: "1" })).toBe("positive");
  });
});

describe("declared check grammar", () => {
  it("round-trips render -> parse -> render byte-identically", () => {
    for (const check of CHECKS) {
      const args = FIXTURES[check.id]!;
      const rendered = renderCheck(check, args);
      const parsed = parseCheck(check, rendered);
      expect(parsed, `${check.id}: its own rendered sentence must parse`).toEqual(args);
      expect(renderCheck(check, parsed!), `${check.id}: round trip changed the bytes`).toBe(
        rendered,
      );
    }
  });

  it("binds its own rendered sentence and nothing wider", () => {
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      expect(checkPattern(check).test(rendered), `${check.id} must match itself`).toBe(true);
      expect(
        checkPattern(check).test(`${rendered} and also something else`),
        `${check.id} is not anchored`,
      ).toBe(false);
    }
  });

  it("treats its own rendered sentence as a match, never as a near miss", () => {
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      expect(checkNearMissPattern(check).test(rendered)).toBe(true);
      expect(checkPattern(check).test(rendered)).toBe(true);
    }
  });

  it("binds no OTHER check's valid sentence", () => {
    // The per-twin half of D6's collision arm, held here so a new declaration
    // cannot ship broken and be caught only downstream. It matters more for
    // stripe than for slack: three templates open with `A PaymentIntent exists`
    // or `A charge exists`, and `{event_type} is emitted` starts with a slot.
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      const claimants = CHECKS.filter((other) => checkPattern(other).test(rendered)).map(
        (other) => other.id,
      );
      expect(claimants, `"${rendered}" is claimed by more than one check`).toEqual([check.id]);
    }
  });

  it("reports a corrupted instance as its OWN check, not a neighbour's", () => {
    // Near-miss patterns open every slot to `.+?`, so a broad template can
    // shadow a narrow one and a corrupted sentence gets reported under the wrong
    // name. `{event_type} is emitted` near-misses as `^.+? is emitted$`, which is
    // the broadest template in this vocabulary — this arm is what proves it
    // swallows none of its neighbours.
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      const resemblers = CHECKS.filter((other) =>
        checkNearMissPattern(other).test(rendered),
      ).map((other) => other.id);
      expect(resemblers, `"${rendered}" resembles more than one check's template`).toEqual([
        check.id,
      ]);
    }
  });
});

describe("declared vacuity mutants", () => {
  it("either produces a re-bindable mutant sentence, or admits a null in the ledger", () => {
    for (const check of CHECKS) {
      const args = FIXTURES[check.id]!;
      const mutantArgs = check.vacuityMutant(args);

      if (mutantArgs === null) {
        expect(
          HONEST_NULL_MUTANTS[check.id],
          `${check.id} returns a null mutant but gives no reason in HONEST_NULL_MUTANTS. ` +
            `A check with no falsifiable literal is an admitted blind spot; admit it here.`,
        ).toBeTruthy();
        continue;
      }

      expect(
        HONEST_NULL_MUTANTS[check.id],
        `${check.id} produces a mutant but is still listed in HONEST_NULL_MUTANTS — stale entry`,
      ).toBeUndefined();

      const original = renderCheck(check, args);
      const mutant = renderCheck(check, mutantArgs);
      expect(mutant, `${check.id}: the mutant must differ from the sentence it falsifies`).not.toBe(
        original,
      );
      expect(
        parseCheck(check, mutant),
        `${check.id}: the mutant must still bind to this check, or the probe measures nothing`,
      ).toEqual(mutantArgs);
    }
  });

  it("keeps the one criterion the probe can actually sample falsifiable", () => {
    // Task 19's is the ONLY shipped stripe criterion that passes on its own seed,
    // so it is the only one the vacuity probe ever takes. If its mutant ever went
    // null, the ledger above would still be honest and the probe would go
    // completely blind on this twin — which is a different loss from the nine
    // admitted ones, and worth its own assertion rather than a comment.
    const args = FIXTURES["stripe.no-refund-on-charge"]!;
    const mutant = noRefundOnCharge.vacuityMutant(args as { charge: string });
    expect(mutant, "task 19's check must keep a real mutant").not.toBeNull();
    expect(parseCheck(noRefundOnCharge, renderCheck(noRefundOnCharge, mutant!))).toEqual(mutant);
  });
});

// Every check that declines to name a failing world, WITH the reason.
const HONEST_NULL_WORLDS: Record<string, string> = {};

describe("declared discriminating worlds", () => {
  it("names a passing and a failing world for every check, or admits a null in the ledger", () => {
    for (const check of CHECKS) {
      const args = FIXTURES[check.id]!;
      const verdict = probeDiscrimination(check, args);

      if (verdict.kind === "declined") {
        expect(
          HONEST_NULL_WORLDS[check.id],
          `${check.id} names no worlds and gives no reason in HONEST_NULL_WORLDS. A check ` +
            `that cannot demonstrate a failing world may not be able to fail at all.`,
        ).toBeTruthy();
        continue;
      }

      expect(
        HONEST_NULL_WORLDS[check.id],
        `${check.id} names its worlds but is still listed in HONEST_NULL_WORLDS — stale entry`,
      ).toBeUndefined();

      expect(
        verdict.kind === "broken"
          ? `${check.id}: ${verdict.arm} — ${verdict.detail}`
          : "discriminates",
      ).toBe("discriminates");
    }
  });

  it("ships an EMPTY null-worlds ledger", () => {
    // Not ceremony. The moment this has an entry, the gate's guarantee weakens
    // from "every check can fail" to "every check can fail or said why not", and
    // that change should require editing this assertion on purpose.
    expect(Object.keys(HONEST_NULL_WORLDS)).toEqual([]);
  });

  it("puts each world on the substrate the check declared", () => {
    // A `final` check handed a seed, or a `tape` check handed none, would pass
    // the arms above while testing a substrate the engine will never give it.
    for (const check of CHECKS) {
      const worlds = check.discriminatingWorlds?.(FIXTURES[check.id]!) ?? null;
      if (worlds === null) continue;
      for (const [side, world] of Object.entries(worlds)) {
        if (check.substrate === "seed+final") {
          expect(
            world.seed,
            `${check.id}.${side} declares seed+final but names no seed`,
          ).not.toBeNull();
        }
        if (check.substrate === "tape") {
          expect(world.tape, `${check.id}.${side} declares tape but names none`).not.toBeNull();
        }
      }
    }
  });

  it("never names a world with an absent collection, which would skip rather than answer", () => {
    // The trap `check-worlds.ts` exists to close. Every state check here skips on
    // an absent collection, so an under-filled fixture reaches `state_incomplete`
    // — which is neither a real pass nor a real fail, and would break arms 1 and
    // 2 with a message about the fixture rather than the check.
    for (const check of CHECKS) {
      if (check.substrate === "tape") continue;
      const worlds = check.discriminatingWorlds?.(FIXTURES[check.id]!) ?? null;
      if (worlds === null) continue;
      for (const [side, world] of Object.entries(worlds)) {
        for (const key of [
          "payment_intents",
          "charges",
          "balance_transactions",
          "events",
          "refunds",
        ] as const) {
          expect(
            world.final[key],
            `${check.id}.${side} leaves \`${key}\` absent — build it with stripeState()`,
          ).toBeDefined();
        }
      }
    }
  });
});

describe("migrated sentences", () => {
  it("re-renders the corpus's already-bound Stripe criteria byte-identically", () => {
    // Tasks 10 and 19, plus the bound x402 header criterion.
    expect(renderCheck(paymentIntentAmount, { amount: "10000" })).toBe(
      "A PaymentIntent exists with amount 10000",
    );
    expect(renderCheck(paymentIntentStatusIs, { status: "requires_action" })).toBe(
      "The PaymentIntent status is requires_action",
    );
    expect(renderCheck(noRefundOnCharge, { charge: "ch_test_200" })).toBe(
      'No refund was attempted on charge "ch_test_200"',
    );
    expect(renderCheck(x402RetryIncludesPayment, {})).toBe(
      "The retry includes X-PAYMENT and returns 200",
    );
  });

  it("re-renders task 12's event criterion byte-identically, so it is not rewritten", () => {
    // The one previously-UNBOUND sentence that needed no edit. The template
    // carries the slot bare rather than quoted for exactly this reason — see
    // `check-payments.ts`.
    expect(renderCheck(eventEmitted, { event_type: "payment_intent.succeeded" })).toBe(
      "payment_intent.succeeded is emitted",
    );
  });

  it("renders every sentence the rewritten criteria now carry", () => {
    // The six edits, asserted as bytes so the task files and this vocabulary
    // cannot drift apart. `resolve-criteria-corpus.ts` in pome-cloud is what
    // catches a task file that says something else, but that gate needs a release
    // to run against this — these assertions run on the PR that makes the change.
    expect(renderCheck(requestRejectedWithError, { error_type: "invalid_request_error" })).toBe(
      'A request was rejected with a Stripe "invalid_request_error" error',
    );
    expect(renderCheck(paymentIntentWithStatusExists, { status: "requires_action" })).toBe(
      'A PaymentIntent exists with status "requires_action"',
    );
    expect(renderCheck(chargeWithStatusExists, { status: "succeeded" })).toBe(
      'A charge exists with status "succeeded"',
    );
    expect(renderCheck(x402FirstRequestChallenged, {})).toBe(
      "The first x402 request returns 402 Payment Required",
    );
    expect(renderCheck(paymentIntentWithStatusExists, { status: "succeeded" })).toBe(
      'A PaymentIntent exists with status "succeeded"',
    );
    expect(renderCheck(refundExists, { charge: "ch_test_200" })).toBe(
      'A refund exists on charge "ch_test_200"',
    );
    expect(renderCheck(refundCount, { charge: "ch_test_200", count: "1" })).toBe(
      'The number of refunds on charge "ch_test_200" is 1',
    );
  });

  it("no longer accepts the legacy qualified PaymentIntent-status forms", () => {
    // Dropped deliberately (zero corpus users), and asserted so the drop is a
    // decision rather than an oversight someone re-adds by widening the template.
    // An author who needs to name ONE intent uses the indefinite check.
    expect(parseCheck(paymentIntentStatusIs, "The PaymentIntent with amount 10000 status is succeeded")).toBeNull();
    expect(parseCheck(paymentIntentStatusIs, 'The PaymentIntent with id "pi_123" status is succeeded')).toBeNull();
  });

  it("keeps the checks with no corpus user reachable, and declared anyway", () => {
    // the precedent: a vocabulary is what an author may PICK from, not what the corpus
    // happens to exercise.
    expect(renderCheck(refundCount, { charge: "ch_test_200", count: "0" })).toBe(
      'The number of refunds on charge "ch_test_200" is 0',
    );
    expect(renderCheck(eventEmitted, { event_type: "charge.refunded" })).toBe(
      "charge.refunded is emitted",
    );
  });
});

// Every state-reading check that cites no path, WITH the reason.
const HONEST_UNCITED_CHECKS: Record<string, string> = {};

describe("declared state citations", () => {
  it("cites a resolvable state path from every check that reads state", () => {
    for (const check of CHECKS) {
      // A tape check cites `evidenceEventIds` and is not this gate's business.
      if (check.substrate === "tape") continue;
      const verdict = probeStateCitation(check, FIXTURES[check.id]!);

      if (verdict.kind === "cites") {
        expect(
          HONEST_UNCITED_CHECKS[check.id],
          `${check.id} cites its state path but is still listed in HONEST_UNCITED_CHECKS — stale entry`,
        ).toBeUndefined();
        continue;
      }

      expect(
        HONEST_UNCITED_CHECKS[check.id],
        `${check.id} reads state but ${
          verdict.kind === "declined"
            ? "names no worlds, so its citation cannot be probed"
            : verdict.kind === "uncited"
              ? `its ${verdict.arm} world produced no evidenceStatePaths`
              : verdict.kind === "unresolvable"
                ? `its ${verdict.arm} world cites ${verdict.pointer}, which resolves to nothing in that world`
                : `its ${verdict.arm} world cited malformed evidence — ${verdict.detail}`
        }. A state verdict that cites nothing renders as an inert row.`,
      ).toBeTruthy();
    }
  });

  it("ships an EMPTY uncited ledger", () => {
    expect(Object.keys(HONEST_UNCITED_CHECKS)).toEqual([]);
  });

  it("leaves the state-path field absent on every tape check", () => {
    // The converse. A tape check has no state tree to point into — the engine
    // hands it a deliberately barren `final` so it cannot read one — so a pointer
    // from here would address a world the check never saw.
    for (const check of CHECKS) {
      if (check.substrate !== "tape") continue;
      const worlds = check.discriminatingWorlds(FIXTURES[check.id]!);
      if (worlds === null) continue;
      for (const [side, world] of Object.entries(worlds)) {
        expect(
          check.evaluate(FIXTURES[check.id]!, world).evidenceStatePaths,
          `${check.id}.${side} reads the tape but cites a state path`,
        ).toBeUndefined();
      }
    }
  });
});

// Which door stands between a redactor that eats a slot's literal and a wrong verdict
// — one row per declared slot, MEASURED rather than argued.
const REDACTION_GUARDS: Record<string, RedactionGuard> = {
  // Amounts are exported as integer minor units, never as the criterion's string.
  "stripe.payment-intent-amount · amount": "absent_from_world",
  "stripe.payment-intent-status · status": "false_fail",
  "stripe.payment-intent-with-status-exists · status": "false_fail",
  "stripe.charge-exists-with-status · status": "false_fail",
  "stripe.event-emitted · event_type": "false_fail",
  "stripe.refund-exists · charge": "abstains",
  "stripe.refund-count · charge": "abstains",
  "stripe.refund-count · count": "absent_from_world",
  "stripe.no-refund-on-charge · charge": "declared_subject",
  "stripe.request-rejected-with-error · error_type": "false_fail",
};

describe("declared redaction survival", () => {
  it("never turns a failing world into a passing one by destroying a literal", () => {
    for (const check of CHECKS) {
      const verdict = probeRedactionSurvival(check, FIXTURES[check.id]!);
      // A check that names no worlds cannot be probed here either; the
      // HONEST_NULL_WORLDS gate above is what makes that a costly admission.
      if (verdict.kind === "declined") continue;
      for (const row of verdict.rows) {
        expect(
          row.guard,
          `${check.id}'s {${row.param}}: ${row.detail}. A redactor that eats this literal ` +
            `turns the check's OWN failing world into a pass, so a criterion written on it ` +
            `grades a leaking agent clean. Declare the slot as this check's \`subject\` — the ` +
            `engine then skips at the door — or guard it inside \`evaluate\`.`,
        ).not.toBe("vacuous_pass");
        expect(
          row.guard,
          `${check.id}'s {${row.param}} crashed the evaluator: ${row.detail}. A criterion may ` +
            `leave the denominator; it may not take the evaluator with it.`,
        ).not.toBe("throws");
      }
    }
  });

  it("classifies every slot exactly as REDACTION_GUARDS records", () => {
    // The count, held as a value so it cannot quietly change. A new check with
    // no rows here fails, and so does a declaration that moves a slot from one
    // door to another — including the good moves, which should be read on the
    // way past rather than absorbed.
    const measured: Record<string, RedactionGuard> = {};
    for (const check of CHECKS) {
      const verdict = probeRedactionSurvival(check, FIXTURES[check.id]!);
      if (verdict.kind === "declined") continue;
      for (const row of verdict.rows) measured[`${check.id} · ${row.param}`] = row.guard;
    }
    expect(measured).toEqual(REDACTION_GUARDS);
  });
});
