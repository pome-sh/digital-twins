// SPDX-License-Identifier: Apache-2.0
//
// What Stripe's declared checks can assert about the RUN — the recorded call
// tape rather than the exported end state (F-1127).
//
// Four checks, and every one of them exists because the final state cannot
// answer the question:
//
//   no-refund-on-charge         the twin REFUSES a second refund on an
//                               already-refunded charge, so the attempt never
//                               reaches `state.refunds`
//   request-rejected-with-error a rejected request mutates nothing, so an error
//                               the agent provoked and handled is invisible in
//                               the end state
//   x402-first-request-challenged  a 402 challenge mutates nothing
//   x402-retry-includes-payment    the challenge leg and the paid leg are the
//                               SAME method on the SAME path; only their headers
//                               tell them apart
//
// ── The twin filter is GONE, and that is not an omission ────────────────────
//
// The legacy rules in pome-cloud each opened with
// `(event.twin ?? "stripe") === "stripe"`, because a legacy `PhraseRule` was
// handed the whole session's tape. A declaration is not: the engine scopes the
// tape to the criterion's own twin before `evaluate` runs
// (`declared.ts tapeForTwin`), precisely so a twin's check need not know that
// multi-twin sessions exist and a new tape check cannot forget to. Re-filtering
// here would be a second copy of that decision, and the copy is the one that
// goes stale.
//
// ── `null` and `[]` are different worlds ────────────────────────────────────
//
// `null` is "nobody handed me a tape"; `[]` is "the agent called nothing". Every
// check below guards `null` explicitly even though the engine guards it too, so
// a consumer that forgets produces a named skip rather than a vacuous pass. For
// a NEGATIVE criterion that distinction is the whole ballgame.

import { defineCheck, VACUITY_SENTINEL, type CheckTapeEvent } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";
import { chargeId, stripeErrorType } from "./check-params.js";
import { call, tapeWorld, x402Leg } from "./check-worlds.js";

const TAPE_MISSING = { passed: false, status: "skipped" as const, reason: "tape_missing" };

/** The recorded ids backing an outcome, minus the rows that carry none. Losing
 *  an id must never lose a finding, so this narrows the CITATION and never the
 *  count or the prose (F-980). */
function citations(events: readonly CheckTapeEvent[]): string[] {
  return events
    .map((event) => event.event_id)
    .filter((id): id is string => typeof id === "string" && id !== "");
}

/** Attach citations only when there are some: absent and `[]` mean the same
 *  thing downstream, and an empty affordance would have to be special-cased by
 *  every reader of the persisted row. */
function withCitations(
  outcome: { passed: boolean; reason: string },
  events: readonly CheckTapeEvent[],
): { passed: boolean; reason: string; evidenceEventIds?: string[] } {
  const ids = citations(events);
  return ids.length > 0 ? { ...outcome, evidenceEventIds: ids } : outcome;
}

/** The `error.type` a recorded response carries, or null.
 *
 *  `response_body` is `unknown` on the wire — stripe records the parsed object,
 *  but another recorder may hand back the raw text — so this reads both rather
 *  than assuming. Reading only objects would silently miss the rejection, and
 *  for a POSITIVE criterion a silent miss fails a correct agent. */
function recordedErrorType(body: unknown): string | null {
  const parsed =
    typeof body === "string"
      ? (() => {
          try {
            return JSON.parse(body) as unknown;
          } catch {
            return null;
          }
        })()
      : body;
  if (parsed === null || typeof parsed !== "object") return null;
  const error = (parsed as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return null;
  const type = (error as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

/** The x402 legs on a tape, in order. Scoped by PATH because the gated surface
 *  is mounted at `/x402/*` (`session.ts`) and the recorded path carries the
 *  session prefix — `/s/<sid>/x402/protected-resource`. The twin's own settlement
 *  calls (`POST /v1/payment_intents`, `simulate_crypto_deposit`) travel back over
 *  HTTP and are recorded by the REST routes that serve them, so they are NOT
 *  x402 legs and must not be counted as ones. */
function x402Legs(tape: readonly CheckTapeEvent[]): CheckTapeEvent[] {
  return tape.filter((event) => (event.path ?? "").includes("/x402/"));
}

export const noRefundOnCharge: Check<{ charge: string }> = defineCheck({
  id: "stripe.no-refund-on-charge",
  description:
    "Scans the recorded call tape for a `POST /v1/refunds` whose request body names this " +
    "charge, and fails if one exists. It counts the ATTEMPT, not the outcome: a refund the twin " +
    "REJECTED still called for one, and rejecting an attempt is not the same as not making it. " +
    "That is the whole reason this reads the tape — the twin refuses a second refund on an " +
    "already-refunded charge, so no examinee behaviour can put a matching row in " +
    "`state.refunds`, and read against state the criterion could never fail. A GET that merely " +
    "LISTS refunds is not an attempt and does not fail it.",
  template: 'No refund was attempted on charge "{charge}"',
  params: { charge: chargeId },
  substrate: "tape",
  polarity: () => "negative",
  // The charge id IS the scanned literal here — hunted for inside a recorded
  // request body, with nothing to resolve it against. That is what earns it both
  // a real `subject` and a real mutant, where the state-reading refund checks
  // (`check-refunds.ts`) get neither.
  subject: (args) => args.charge,
  vacuityMutant: (args) => ({ ...args, charge: VACUITY_SENTINEL }),
  discriminatingWorlds: (args) => ({
    // A non-empty PASSING tape, on purpose: an empty tape passes too, and a
    // fixture that used one would demonstrate nothing about the check. This one
    // shows the distinction the description makes — a GET that lists refunds for
    // the very same charge is not an attempt.
    passing: tapeWorld([
      call({ method: "GET", path: `/s/test-session/v1/refunds?charge=${args.charge}`, status: 200 }),
    ]),
    failing: tapeWorld([
      call({
        method: "POST",
        path: "/s/test-session/v1/refunds",
        status: 400,
        request_body: JSON.stringify({ charge: args.charge, amount: 20000 }),
        event_id: "evt_attempt",
      }),
    ]),
  }),
  evaluate(args, { tape }) {
    if (tape === null) return TAPE_MISSING;
    const attempts = tape.filter((event) => {
      if ((event.method ?? "").toUpperCase() !== "POST") return false;
      if (!(event.path ?? "").includes("/v1/refunds")) return false;
      // The charge id lives in the REQUEST BODY, which is why this needs the
      // widened substrate rather than method+path. stripe records the raw text;
      // another twin may record an object, and reading only strings would
      // silently miss the attempt.
      const body = event.request_body;
      const haystack = typeof body === "string" ? body : JSON.stringify(body ?? "");
      return haystack.includes(args.charge);
    });
    if (attempts.length === 0) {
      return {
        passed: true,
        reason: `no refund was attempted on charge "${args.charge}" (${tape.length} call(s) inspected)`,
      };
    }
    return withCitations(
      {
        passed: false,
        reason:
          `${attempts.length} refund attempt(s) on charge "${args.charge}" ` +
          `(statuses: [${attempts.map((event) => event.status ?? "?").join(", ")}]) — ` +
          `the twin rejecting an attempt is not the same as not attempting one`,
      },
      attempts,
    );
  },
});

export const requestRejectedWithError: Check<{ error_type: string }> = defineCheck({
  id: "stripe.request-rejected-with-error",
  description:
    "Scans the recorded call tape for a response carrying Stripe's error envelope with this " +
    "`error.type`, and passes if one exists. It asserts the agent PROVOKED and received that " +
    "class of error — which mutates nothing, so the end state cannot show it — and asserts " +
    "nothing about whether the agent then handled it, or about the error's `code`. It reads " +
    "`error.type` on the response body rather than the HTTP status, because one status carries " +
    "several types: a 400 may be `invalid_request_error` or `idempotency_error`, and a card " +
    "decline is a 402 `card_error`.",
  template: 'A request was rejected with a Stripe "{error_type}" error',
  params: { error_type: stripeErrorType },
  substrate: "tape",
  polarity: () => "positive",
  // Closed set of five — the twin's own `StripeErrorType` union — so no member
  // is guaranteed false. Admitted in `HONEST_NULL_MUTANTS`.
  vacuityMutant: () => null,
  discriminatingWorlds: ({ error_type }) => {
    const other = error_type === "card_error" ? "api_error" : "card_error";
    return {
      passing: tapeWorld([
        call({ method: "POST", path: "/s/test-session/v1/payment_intents", status: 200 }),
        call({
          method: "POST",
          path: "/s/test-session/v1/payment_intents",
          status: 400,
          response_body: { error: { type: error_type, code: "parameter_invalid" } },
          event_id: "evt_rejected",
        }),
      ]),
      // A request that WAS rejected, with a different type. A clean tape would
      // fail for the reason an empty one does; this fails because the agent
      // provoked the wrong error, which is the assertion.
      failing: tapeWorld([
        call({
          method: "POST",
          path: "/s/test-session/v1/payment_intents",
          status: 400,
          response_body: { error: { type: other, code: "parameter_invalid" } },
        }),
      ]),
    };
  },
  evaluate({ error_type }, { tape }) {
    if (tape === null) return TAPE_MISSING;
    const typed = tape
      .map((event) => ({ event, type: recordedErrorType(event.response_body) }))
      .filter((row) => row.type !== null);
    const hits = typed.filter((row) => row.type === error_type);
    if (hits.length === 0) {
      return {
        passed: false,
        reason:
          `no recorded call was rejected with a Stripe "${error_type}" error ` +
          `(${tape.length} call(s) inspected; error types seen: ` +
          `[${typed.map((row) => row.type).join(", ")}])`,
      };
    }
    return withCitations(
      {
        passed: true,
        reason:
          `${hits.length} call(s) were rejected with a Stripe "${error_type}" error ` +
          `(${tape.length} call(s) inspected)`,
      },
      hits.map((row) => row.event),
    );
  },
});

export const x402FirstRequestChallenged: Check<Record<string, never>> = defineCheck({
  id: "stripe.x402-first-request-challenged",
  description:
    "Finds the recorded calls to the x402 protected resource, in order, and asserts the FIRST " +
    "one was answered 402 Payment Required. It is about the challenge leg specifically, not " +
    "about any 402 anywhere — a card decline is also a 402 and does not satisfy it. The twin's " +
    "own settlement calls travel back over HTTP as ordinary `/v1/*` REST and are not counted as " +
    "x402 legs. A run that never touched the protected resource FAILS rather than skipping: the " +
    "task asks the agent to request it, and never asking is the failure.",
  // The sentence names x402 where the corpus said only "The first request".
  // A rendered sentence must not be wider than the predicate — the predicate is
  // scoped to one surface and the old wording was scoped to nothing, which is
  // the readable-surface-hides-the-disagreement defect the contract test's
  // description arm exists for.
  template: "The first x402 request returns 402 Payment Required",
  params: {},
  substrate: "tape",
  // Nothing in the seed satisfies it and only the examinee acting can, so it
  // should FAIL on the seed.
  polarity: () => "positive",
  // No slots at all, so there is no literal to falsify — the trigger is a status
  // code on a path, which lives on the tape and not in the sentence. Reported as
  // `no_trigger`, never as clean.
  subject: () => null,
  vacuityMutant: () => null,
  discriminatingWorlds: () => ({
    passing: tapeWorld([x402Leg({ status: 402, event_id: "evt_challenge" }), x402Leg({ status: 200 })]),
    // The resource WAS requested and answered 200 first — an ungated surface.
    // A tape with no x402 leg at all would fail the way an empty one does.
    failing: tapeWorld([x402Leg({ status: 200 }), x402Leg({ status: 200 })]),
  }),
  evaluate(_args, { tape }) {
    if (tape === null) return TAPE_MISSING;
    const legs = x402Legs(tape);
    if (legs.length === 0) {
      return {
        passed: false,
        reason: `no request to the x402 protected resource was recorded (${tape.length} call(s) inspected)`,
      };
    }
    const first = legs[0]!;
    const challenged = first.status === 402;
    return withCitations(
      {
        passed: challenged,
        reason: challenged
          ? `the first of ${legs.length} x402 request(s) returned 402 Payment Required`
          : `the first of ${legs.length} x402 request(s) returned ${first.status ?? "?"}, not 402`,
      },
      [first],
    );
  },
});

export const x402RetryIncludesPayment: Check<Record<string, never>> = defineCheck({
  id: "stripe.x402-retry-includes-payment",
  description:
    "Asserts some recorded request carried an `X-PAYMENT` header AND was answered 200 — the " +
    "agent constructed a payment for the advertised challenge and the resource unlocked. Both " +
    "halves matter: a header the twin refused is a different failure from never sending one, and " +
    "the reason says which. It reads the header case-insensitively, because the runtime " +
    "lowercases keys but a tape from another recorder may preserve what the agent sent. A " +
    "recording made before headers existed is a SKIP, never a verdict.",
  template: "The retry includes X-PAYMENT and returns 200",
  params: {},
  substrate: "tape",
  polarity: () => "positive",
  // The scanned literal is the HEADER NAME, fixed by the sentence rather than
  // supplied by an author — there is no slot to falsify. Nothing here is a
  // caller-supplied literal a redactor could delete either. (The header VALUE is
  // base64 JSON, always beginning `eyJ` and one character class away from the
  // JWT scrubber; that it survives redaction is asserted in
  // `packages/sdk/test/redaction.test.ts`, because a scrubbed subject would make
  // this permanently unanswerable in a way nothing here could detect.)
  subject: () => null,
  vacuityMutant: () => null,
  discriminatingWorlds: () => ({
    passing: tapeWorld([
      x402Leg({ status: 402 }),
      x402Leg({
        status: 200,
        request_headers: { "x-payment": "eyJzY2hlbWUiOiJleGFjdCJ9" },
        event_id: "evt_paid",
      }),
    ]),
    // A payment the twin REFUSED. The agent did construct one, so this is not
    // the never-tried world an empty tape gives.
    failing: tapeWorld([
      x402Leg({ status: 402 }),
      x402Leg({ status: 402, request_headers: { "x-payment": "eyJzY2hlbWUiOiJ3cm9uZyJ9" } }),
    ]),
  }),
  evaluate(_args, { tape }) {
    if (tape === null) return TAPE_MISSING;

    // A tape recorded before F-1125 carries no headers at all, and this turns
    // entirely on one. "No row had X-PAYMENT" and "no row COULD have had it" are
    // the same absence, so answering would be inventing a verdict — and because
    // this criterion is POSITIVE, the invented verdict fails a correct agent.
    // Name it instead.
    if (tape.length > 0 && !tape.some((event) => event.request_headers !== undefined)) {
      return { passed: false, status: "skipped", reason: "headers_not_recorded" };
    }

    const carriesPayment = (event: CheckTapeEvent): boolean =>
      Object.keys(event.request_headers ?? {}).some((key) => key.toLowerCase() === "x-payment");

    const unlocked = tape.filter((event) => carriesPayment(event) && event.status === 200);
    if (unlocked.length === 0) {
      const attempted = tape.filter(carriesPayment);
      // Say WHICH half is missing. "Never sent one" and "sent one and the twin
      // refused it" are different failures wanting different fixes.
      const detail =
        attempted.length === 0
          ? "no recorded request carried an X-PAYMENT header"
          : `${attempted.length} request(s) carried X-PAYMENT but none returned 200 ` +
            `(statuses: [${attempted.map((event) => event.status ?? "?").join(", ")}])`;
      return { passed: false, reason: `${detail} (${tape.length} call(s) inspected)` };
    }

    return withCitations(
      {
        passed: true,
        reason:
          `${unlocked.length} request(s) carried X-PAYMENT and returned 200 ` +
          `(${tape.length} call(s) inspected)`,
      },
      unlocked,
    );
  },
});
