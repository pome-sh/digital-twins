// SPDX-License-Identifier: Apache-2.0
//
// What Stripe's declared checks can assert about PAYMENT INTENTS, CHARGES and
// EVENTS (F-1127).
//
// Two migrate from pome-cloud's `services/evaluators/deterministic/stripe.ts`,
// where they were hand-written regexes over a cloud-side mirror of the state
// shape. Three are new, and each one exists because a shipped criterion asked
// for it and bound nothing:
//
//   A PaymentIntent exists with status "…"   ← task 13, `A backing PaymentIntent
//                                              reaches succeeded`
//   A charge exists with status "…"          ← task 12
//   {event_type} is emitted                  ← task 12, and the one sentence in
//                                              this file that re-renders the
//                                              corpus BYTE-IDENTICALLY
//
// ── The definite and the indefinite are different checks ────────────────────
//
// `The PaymentIntent status is …` asserts about THE PaymentIntent and refuses
// (`unmatched`) when a world holds more than one — the legacy rule's rule, kept
// because it is right: `.some()` over every PI would let a wrong agent pass by
// leaving an unrelated seed PI in the wanted status (D4).
//
// `A PaymentIntent exists with status …` asserts that SOME PI reached it. That
// is a weaker claim and the corpus needs it: task 13's x402 middleware mints a
// fresh PaymentIntent on every challenge leg, so a real run of that task holds
// several and the definite form would refuse every time. Two readings, two
// checks, and D6's collision arm keeps them from claiming one sentence.
//
// ── What was dropped in the migration, and why it is not a silent loss ──────
//
// The legacy `payment-intent-status` pattern carried an OPTIONAL qualifier —
// `The PaymentIntent with amount 10000 status is …` / `… with id pi_123 …`. A
// template has no optional slot, and the qualifier existed only to disambiguate
// a multi-PI world, which the indefinite check above now answers directly. It
// has zero corpus users, so nothing re-renders differently. An author who needs
// to name ONE PaymentIntent by id wants a check whose template carries that id;
// nothing asks for one yet, and inventing it here would ship a fourth
// PaymentIntent template for the near-miss patterns to shadow each other with.

import { defineCheck, VACUITY_SENTINEL_NUMBER } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";
import {
  chargeStatus,
  minorUnitAmount,
  paymentIntentStatus,
  stripeEventType,
} from "./check-params.js";
import {
  CHARGES_PATH,
  EVENTS_PATH,
  PAYMENT_INTENTS_PATH,
  type StripeCheckState,
} from "./check-state.js";
import { charge, event, finalWorld, paymentIntent, stripeState } from "./check-worlds.js";

const STATE_INCOMPLETE = { passed: false, status: "skipped" as const, reason: "state_incomplete" };

// Every collection this file reads is absent-able, and every absence is the
// same verdict: we were handed no `payment_intents` / `charges` / `events` key
// at all, so nothing can be attested. Named once so the three checks cannot
// drift on it — and so arm 3 of the discrimination gate has ONE degenerate
// reason to compare against rather than three near-identical ones.
function requireList<T>(list: T[] | null | undefined): T[] | null {
  return list == null ? null : list;
}

export const paymentIntentAmount: Check<{ amount: string }> = defineCheck({
  id: "stripe.payment-intent-amount",
  description:
    "Asserts SOME PaymentIntent in the account carries this exact amount, in the currency's " +
    "minor unit (cents for USD) — the integer the `amount` field holds, never a formatted " +
    "figure. It asserts nothing about that intent's status, its currency, or how many others " +
    "exist. An absent `payment_intents` key is a SKIP: a positive criterion must not fail a " +
    "correct agent over state nobody uploaded.",
  template: "A PaymentIntent exists with amount {amount}",
  params: { amount: minorUnitAmount },
  substrate: "final",
  polarity: () => "positive",
  // The amount is COMPARED to a numeric field, not hunted for inside prose, so
  // no redactor can silently delete it. `subject` is omitted rather than
  // returning null for the same reason twin-github omits it on structural
  // checks: absent means "nothing a redactor could reach", which is the truth.
  vacuityMutant: (args) => ({ ...args, amount: String(VACUITY_SENTINEL_NUMBER) }),
  discriminatingWorlds: ({ amount }) => ({
    passing: finalWorld(stripeState({ payment_intents: [paymentIntent({ amount: Number(amount) })] })),
    // A PaymentIntent that EXISTS and holds a different amount, not an empty
    // list: the reason then names the amounts it scanned and cannot be confused
    // with the one an absent collection produces.
    failing: finalWorld(
      stripeState({ payment_intents: [paymentIntent({ amount: Number(amount) + 1 })] }),
    ),
  }),
  evaluate({ amount }, { final }) {
    const pis = requireList(final.payment_intents);
    if (pis === null) return STATE_INCOMPLETE;
    const wanted = Number(amount);
    const found = pis.some((pi) => pi.amount === wanted);
    return {
      passed: found,
      reason: found
        ? `a PaymentIntent exists with amount ${wanted}`
        : `no PaymentIntent has amount ${wanted} (amounts: [${pis.map((pi) => pi.amount ?? "?").join(", ")}])`,
      // The COLLECTION, not the matching row (F-1197). Every check in this file
      // scans a whole collection and answers a question about the set — "does
      // one exist with…" — so the set is what was read. Citing the hit on a pass
      // and the collection on a fail would make the pointer's shape track the
      // verdict, and a reader would learn to read it as one.
      evidenceStatePaths: [PAYMENT_INTENTS_PATH],
    };
  },
});

export const paymentIntentStatusIs: Check<{ status: string }> = defineCheck({
  id: "stripe.payment-intent-status",
  description:
    "Asserts THE PaymentIntent — singular — is in this status. When the account holds more " +
    "than one it returns `unmatched` rather than a verdict, because scanning all of them " +
    "would let a wrong agent pass on an unrelated intent the seed left in the wanted state. " +
    "Use `A PaymentIntent exists with status …` when several are expected. An absent " +
    "`payment_intents` key is a SKIP.",
  template: "The PaymentIntent status is {status}",
  params: { status: paymentIntentStatus },
  substrate: "final",
  polarity: () => "positive",
  // Null, and admitted in `HONEST_NULL_MUTANTS`. The only slot is a closed set,
  // so no member is guaranteed false — a mutant naming a different status
  // asserts something that may also be true — and a value outside the set does
  // not re-bind at all, which reads as "the verdict moved" and blesses the very
  // criterion the probe exists to catch. Task 10 carries this criterion AND
  // `payment-intent-amount`, whose numeric slot keeps a real mutant, so the twin
  // does not go dark in the probe.
  vacuityMutant: () => null,
  discriminatingWorlds: ({ status }) => ({
    // Exactly ONE intent in both worlds. Two would return `unmatched`, which is
    // neither a real pass nor a real fail, and would break arms 1 and 2.
    passing: finalWorld(stripeState({ payment_intents: [paymentIntent({ status })] })),
    failing: finalWorld(
      stripeState({
        payment_intents: [paymentIntent({ status: status === "canceled" ? "processing" : "canceled" })],
      }),
    ),
  }),
  evaluate({ status }, { final }) {
    const pis = requireList(final.payment_intents);
    if (pis === null) return STATE_INCOMPLETE;
    if (pis.length > 1) {
      return {
        passed: false,
        status: "unmatched",
        reason: `ambiguous: ${pis.length} payment_intents and this sentence names one`,
        // The ambiguity IS the finding, and the collection is where a reader
        // sees it: several intents where the sentence says "the".
        evidenceStatePaths: [PAYMENT_INTENTS_PATH],
      };
    }
    const found = pis.some((pi) => pi.status === status);
    return {
      passed: found,
      reason: found
        ? `the PaymentIntent has status "${status}"`
        : `the PaymentIntent does not have status "${status}" ` +
          `(statuses: [${pis.map((pi) => pi.status ?? "?").join(", ")}])`,
      evidenceStatePaths: [PAYMENT_INTENTS_PATH],
    };
  },
});

export const paymentIntentWithStatusExists: Check<{ status: string }> = defineCheck({
  id: "stripe.payment-intent-with-status-exists",
  description:
    "Asserts AT LEAST ONE PaymentIntent in the account reached this status, whichever one and " +
    "however many others exist. This is the check for a flow that mints intents the author " +
    "cannot name in advance — x402 creates a fresh one per challenge leg — where naming `the` " +
    "PaymentIntent would be ambiguous by construction. An absent `payment_intents` key is a SKIP.",
  template: 'A PaymentIntent exists with status "{status}"',
  params: { status: paymentIntentStatus },
  substrate: "final",
  polarity: () => "positive",
  // Closed set — see `stripe.payment-intent-status` above, same argument.
  vacuityMutant: () => null,
  discriminatingWorlds: ({ status }) => {
    const other = status === "canceled" ? "processing" : "canceled";
    return {
      // Two intents in each world, because that plurality is the whole reason
      // this check exists beside the definite one: a fixture with a single
      // intent would pass identically under both and prove nothing about the
      // difference.
      passing: finalWorld(
        stripeState({
          payment_intents: [
            paymentIntent({ id: "pi_a", status: other }),
            paymentIntent({ id: "pi_b", status }),
          ],
        }),
      ),
      failing: finalWorld(
        stripeState({
          payment_intents: [
            paymentIntent({ id: "pi_a", status: other }),
            paymentIntent({ id: "pi_b", status: other }),
          ],
        }),
      ),
    };
  },
  evaluate({ status }, { final }) {
    const pis = requireList(final.payment_intents);
    if (pis === null) return STATE_INCOMPLETE;
    const hits = pis.filter((pi) => pi.status === status);
    return {
      passed: hits.length > 0,
      reason:
        hits.length > 0
          ? `${hits.length} of ${pis.length} PaymentIntent(s) have status "${status}"`
          : `no PaymentIntent has status "${status}" ` +
            `(statuses: [${pis.map((pi) => pi.status ?? "?").join(", ")}])`,
      evidenceStatePaths: [PAYMENT_INTENTS_PATH],
    };
  },
});

export const chargeWithStatusExists: Check<{ status: string }> = defineCheck({
  id: "stripe.charge-exists-with-status",
  description:
    "Asserts AT LEAST ONE charge in the account is in this status. A charge is created already " +
    "settled or already declined, so `succeeded` here means money moved — the twin writes the " +
    "charge and its balance transaction inside one SQLite transaction, on both the card and the " +
    "x402 crypto rails, so a charge in this state always has its ledger entry and asserting the " +
    "balance transaction separately would assert a twin invariant rather than anything an " +
    "examinee did. An absent `charges` key is a SKIP.",
  template: 'A charge exists with status "{status}"',
  params: { status: chargeStatus },
  substrate: "final",
  polarity: () => "positive",
  // Closed set of three — same argument as the PaymentIntent status slots.
  vacuityMutant: () => null,
  discriminatingWorlds: ({ status }) => {
    const other = status === "failed" ? "succeeded" : "failed";
    return {
      passing: finalWorld(stripeState({ charges: [charge({ status })] })),
      failing: finalWorld(stripeState({ charges: [charge({ status: other })] })),
    };
  },
  evaluate({ status }, { final }) {
    const charges = requireList(final.charges);
    if (charges === null) return STATE_INCOMPLETE;
    const hits = charges.filter((row) => row.status === status);
    return {
      passed: hits.length > 0,
      reason:
        hits.length > 0
          ? `${hits.length} of ${charges.length} charge(s) have status "${status}"`
          : `no charge has status "${status}" ` +
            `(statuses: [${charges.map((row) => row.status ?? "?").join(", ")}])`,
      evidenceStatePaths: [CHARGES_PATH],
    };
  },
});

export const eventEmitted: Check<{ event_type: string }> = defineCheck({
  id: "stripe.event-emitted",
  description:
    "Asserts the account's event log contains at least one event of this type. The twin delivers " +
    "no webhooks in v1 — an examinee observes events by polling `GET /v1/events` — so this reads " +
    "the log the twin appended, not anything the examinee received. It asserts nothing about " +
    "WHICH resource the event names: `payment_intent.succeeded` is emitted by both the card " +
    "confirm path and the x402 crypto-deposit settlement, and this check deliberately does not " +
    "distinguish them, because the criterion asking for it is about the outcome rather than the " +
    "rail. An absent `events` key is a SKIP.",
  // No quotes, and that is load-bearing: the corpus already says
  // `payment_intent.succeeded is emitted`, so this template re-renders task 12's
  // existing criterion byte-identically and the migration rewrites it not at
  // all. The dot lives inside the closed set's members, which `oneOf` escapes,
  // so it matches a dot rather than any character.
  template: "{event_type} is emitted",
  params: { event_type: stripeEventType },
  substrate: "final",
  polarity: () => "positive",
  // Closed set of fifteen — the twin's own `EventType` union — so no member is
  // guaranteed false. Admitted in `HONEST_NULL_MUTANTS`.
  vacuityMutant: () => null,
  discriminatingWorlds: ({ event_type }) => {
    const other =
      event_type === "payment_intent.created" ? "payment_intent.canceled" : "payment_intent.created";
    return {
      passing: finalWorld(stripeState({ events: [event(other), event(event_type)] })),
      // A log that EXISTS and holds a different event, so the reason names what
      // was emitted instead and cannot be confused with an absent log.
      failing: finalWorld(stripeState({ events: [event(other)] })),
    };
  },
  evaluate({ event_type }, { final }) {
    const events = requireList(final.events);
    if (events === null) return STATE_INCOMPLETE;
    const hits = events.filter((row) => row.type === event_type);
    return {
      passed: hits.length > 0,
      reason:
        hits.length > 0
          ? `${hits.length} \`${event_type}\` event(s) among ${events.length} emitted`
          : `no \`${event_type}\` event among ${events.length} emitted ` +
            `([${events.map((row) => row.type ?? "?").join(", ")}])`,
      // The event LOG. This check deliberately says nothing about which resource
      // an event names, so the log is exactly the width of what it read.
      evidenceStatePaths: [EVENTS_PATH],
    };
  },
});

// Re-exported for the state-shape parity arm, which asserts these field names
// against a real `exportState()` rather than against this module's beliefs.
export type { StripeCheckState };
