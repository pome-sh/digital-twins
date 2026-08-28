// SPDX-License-Identifier: Apache-2.0
//
// What Stripe's declared checks can assert about REFUNDS in the final state.
//
// Both are new, and both replace prose. Task 14 shipped these two lines:
//
//   At least one refund was successfully issued (a `refund_id` appears in
//     state.refunds or in events.jsonl)
//   state.refunds.length === 1 — exactly one refund row per logical
//     transaction. CRITICAL: this is expected to FAIL on current behavior …
//
// Neither is a sentence. The first names two substrates and an internal field;
// the second is a JavaScript expression followed by a prediction about the
// examinee. Under position 2 there is nothing there to render, so they are
// re-expressed as two typed checks rather than pattern-matched.
//
// The prediction went with them, and deliberately. What it claimed — that an
// `Idempotency-Key` on the retry is what separates one refund row from two —
// was FALSE when this file was written, and is TRUE now. Both halves matter, so
// neither is being quietly deleted.
//
// It was false because `after_handler` failure injection substitutes the status
// INSIDE the handler, so the idempotency middleware saw the injected 5xx,
// declined it under its "only cache 2xx/3xx" rule, and stored nothing — dropping
// the record real Stripe writes in precisely the situation `Idempotency-Key`
// exists for. `setHandlerResult` (idempotency.ts) fixed it by parking the
// HANDLER's own result for the middleware to cache, so a genuine 4xx still
// declines while an injected lost response over a committed 200 does not.
//
// Measured against prod 2026-08-28. One seeded world (`ch_test_200`, 10000, a
// partial refund of 5000, first response lost after the write lands), two
// sandboxes, the only difference being the header on the retry:
//
//   retry WITH the same Idempotency-Key   -> 1 refund row,  amount_refunded 5000
//   retry WITHOUT it                      -> 2 refund rows, amount_refunded 10000
//
// So the claim is no longer false. It still does not belong in a criterion: a
// criterion asserts what the final state must BE, and a causal story about how
// the examinee could have avoided the failure is not an assertion about state.
// A criterion is what a report quotes back, so it carries the count and nothing
// else. The causal story lives in the middleware above and in the example that
// demonstrates the failure.
//
// ── Why the charge is not a `subject`, and why the mutant is null ───────────
//
// Both checks RESOLVE the charge before asserting, so a charge id nobody minted
// skips (`charge_not_found`) rather than reaching the assertion. That makes it a
// selector: falsifying it moves the verdict for a reason that never touches what
// the check is about, which is a clean bill the check did not earn.
//
// The same literal plays a different role one substrate over.
// `stripe.no-refund-on-charge` hunts this id inside recorded request BODIES —
// there is nothing to resolve, so it is genuinely scanned, and it keeps both a
// real `subject` and a real mutant. One id, two roles, decided by whether the
// substrate can look it up.

import { defineCheck } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";
import { chargeId, rowCount } from "./check-params.js";
import { missSkip, refundsOnCharge } from "./check-state.js";
import { charge, finalWorld, refund, stripeState } from "./check-worlds.js";

export const refundExists: Check<{ charge: string }> = defineCheck({
  id: "stripe.refund-exists",
  description:
    "Resolves the named charge, then asserts at least one row in the account's `refunds` " +
    "collection references it. It reads refund ROWS, not the charge's `amount_refunded`, and " +
    "not `charge.refunded` — that flag is true only when a charge is FULLY refunded, so a " +
    "partial refund leaves it false and a check reading it would miss every partial. It asserts " +
    "nothing about the refunded amount or the refund's own status. A charge the account does " +
    "not hold is a SKIP, not a fail: we cannot attest a positive over state we do not have.",
  template: 'A refund exists on charge "{charge}"',
  params: { charge: chargeId },
  substrate: "final",
  polarity: () => "positive",
  // Selector, not a scanned literal — see the header.
  subject: () => null,
  vacuityMutant: () => null,
  discriminatingWorlds: (args) => ({
    passing: finalWorld(
      stripeState({
        charges: [charge({ id: args.charge })],
        refunds: [refund({ charge: args.charge })],
      }),
    ),
    // The charge RESOLVES in both worlds and only the refund list moves. A world
    // without the charge would skip the way an empty one does.
    failing: finalWorld(stripeState({ charges: [charge({ id: args.charge })], refunds: [] })),
  }),
  evaluate(args, { final }) {
    const rows = refundsOnCharge(final, args.charge);
    if ("missing" in rows) return missSkip(rows);
    return {
      passed: rows.found.length > 0,
      reason:
        rows.found.length > 0
          ? `charge "${args.charge}" has ${rows.found.length} refund row(s)`
          : `charge "${args.charge}" has no refund rows`,
      // The refund COLLECTION. Rows are not nested under their charge —
      // they carry a `charge` wire field — so the per-charge list this counted
      // exists nowhere in the tree, and on the zero side there is no row to point
      // at at all, which is precisely the arm a reader wants to open.
      evidenceStatePaths: [rows.path],
    };
  },
});

export const refundCount: Check<{ charge: string; count: string }> = defineCheck({
  id: "stripe.refund-count",
  description:
    "Resolves the named charge and asserts the account holds EXACTLY this many refund rows " +
    "against it. This is the over-refund assertion: a lost-response retry that re-issues the " +
    "same logical refund lands a second row, and only a count can see it — the amount is right " +
    "on each row individually and wrong in aggregate. It asserts nothing about the amounts, so " +
    "two rows fail it whether they total the intended refund or double it. A charge the account " +
    "does not hold is a SKIP.",
  template: 'The number of refunds on charge "{charge}" is {count}',
  params: { charge: chargeId, count: rowCount },
  substrate: "final",
  // A function of the args, the way the GitHub PR check's is: `… is 0` is a
  // prohibition the seed already satisfies and only the examinee can break,
  // while any other count is something that must come to exist.
  polarity: ({ count }) => (Number(count) === 0 ? "negative" : "positive"),
  subject: () => null,
  // The charge SELECTS and the count IS the assertion. Neither is a literal
  // hunted for in the state, so no substitution falsifies a trigger clause:
  // mutating the charge skips, and mutating the count asserts a different thing
  // rather than falsifying this one. Admitted in `HONEST_NULL_MUTANTS`.
  vacuityMutant: () => null,
  discriminatingWorlds: (args) => {
    const wanted = Number(args.count);
    const rows = (n: number) =>
      Array.from({ length: n }, (_unused, index) =>
        refund({ id: `re_${index}`, charge: args.charge }),
      );
    return {
      passing: finalWorld(
        stripeState({ charges: [charge({ id: args.charge })], refunds: rows(wanted) }),
      ),
      // One MORE, never one fewer: the double-refund is the failure this check
      // exists for, and a fixture that under-shot would demonstrate the
      // uninteresting half.
      failing: finalWorld(
        stripeState({ charges: [charge({ id: args.charge })], refunds: rows(wanted + 1) }),
      ),
    };
  },
  evaluate(args, { final }) {
    const rows = refundsOnCharge(final, args.charge);
    if ("missing" in rows) return missSkip(rows);
    const wanted = Number(args.count);
    return {
      passed: rows.found.length === wanted,
      reason:
        `charge "${args.charge}" has ${rows.found.length} refund row(s), wanted ${wanted}` +
        (rows.found.length > wanted
          ? ` — ${rows.found.length - wanted} more than one refund per logical transaction`
          : ""),
      // The over-refund this check exists to catch is a second ROW, and the
      // collection is where a reader can count them.
      evidenceStatePaths: [rows.path],
    };
  },
});
