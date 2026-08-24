// SPDX-License-Identifier: Apache-2.0
//
// What Gmail's declared checks can assert about DRAFTS.
//
// The shape that makes this its own module: an exported draft row is
// `{mailboxEmail, id, messageId, createdAt, updatedAt}` and carries NO
// addressing. Who a draft is for lives on the backing message, reachable only
// through `messageId`. A predicate that read the draft row alone would answer
// "no draft is addressed to anyone", always — a negative that can never fail,
// which is the exact defect A3 exists to eliminate.

import { defineCheck, VACUITY_SENTINEL, VACUITY_SENTINEL_NUMBER } from "@pome-sh/sdk/checks";
import { childStatePath } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";
import { countWord, emailAddress, parseCount } from "./check-params.js";
import { DRAFTS_PATH, draftRecipients, isTruncated } from "./check-state.js";
import { draftAddressedTo as draftFor, finalWorld, gmailState } from "./check-worlds.js";

export const draftAddressedTo: Check<{ email: string }> = defineCheck({
  id: "gmail.draft-addressed-to",
  description:
    "Joins every draft to its backing message and asks whether any of them addresses this " +
    "recipient in `to` or `cc`, compared case-insensitively as an EXACT address rather than a " +
    "substring. It asserts nothing about the draft's body — message bodies are digested out of " +
    "the state export unconditionally, so no check on this twin can read one — and nothing about " +
    "whether the draft was left unsent, which is a separate claim. A draft whose backing message " +
    "did not survive the export contributes no recipients rather than throwing.",
  template: "A draft addressed to {email} exists",
  params: { email: emailAddress },
  substrate: "final",
  // An achievement: the seeded mailbox already contains a draft with a
  // recipient, so an examinee that does nothing does not satisfy this.
  polarity: () => "positive",
  //
  // THE LOAD-BEARING DECLARATION ON THIS CHECK.
  //
  // `subject` names the value the assertion is actually about, and on this check
  // that value is an email address — squarely inside what a redaction config may
  // legitimately destroy before an evaluator ever sees the state. Declaring it
  // is what lets a consumer detect that the comparison has become impossible and
  // record an honest skip. Without it there is nothing to detect: the address is
  // simply absent, the comparison silently cannot match, and the criterion
  // reports a vacuous verdict that reads like a real one.
  subject: ({ email }) => email,
  // The address is the scanned literal, so the mutant points at it. It stays
  // email-shaped so it re-binds to this same check: a mutant that stops matching
  // evaluates to `unmatched`, which reads as "the verdict moved -> healthy" and
  // hands the criterion a clean bill it did not earn.
  vacuityMutant: (args) => ({ ...args, email: `${VACUITY_SENTINEL}@example.invalid` }),
  discriminatingWorlds: ({ email }) => {
    const wanted = draftFor("draft_target", [email]);
    const other = draftFor("draft_other", ["someone-else@example.com"]);
    // Both worlds carry a draft, so the failing world fails on the ASSERTION
    // rather than on an empty collection — the degenerate arm the probe rejects.
    return {
      passing: finalWorld(
        gmailState({ drafts: [wanted.draft], messages: [wanted.message] }),
      ),
      failing: finalWorld(gmailState({ drafts: [other.draft], messages: [other.message] })),
    };
  },
  evaluate({ email }, { final }) {
    if (final.drafts == null || final.messages == null) {
      return { passed: false, status: "skipped", reason: "state_incomplete" };
    }
    const wanted = email.toLowerCase();
    const index = final.drafts.findIndex((entry) =>
      draftRecipients(final, entry).some((to) => to.toLowerCase() === wanted),
    );
    if (index >= 0) {
      const hit = final.drafts[index]!;
      return {
        passed: true,
        reason: `draft ${hit.id ?? "?"} is addressed to ${email}`,
        // The DRAFT row, not the backing message that actually holds the
        // address. A reader following this pointer lands on the thing the
        // sentence is about — "a draft addressed to X" — and the join to the
        // message is an implementation detail of how the twin exports, not the
        // claim.
        evidenceStatePaths: [childStatePath(DRAFTS_PATH, index)],
      };
    }
    // Only refuse once the answer would otherwise be "no". A capped collection
    // that still contains the draft is a real pass, and skipping it would drop a
    // criterion the export could actually answer.
    if (isTruncated(final, "drafts") || isTruncated(final, "messages")) {
      return { passed: false, status: "skipped", reason: "collection_truncated" };
    }
    return {
      passed: false,
      reason: `no draft is addressed to ${email} (${final.drafts.length} draft(s) inspected)`,
      evidenceStatePaths: [DRAFTS_PATH],
    };
  },
});

export const draftCountAtLeast: Check<{ count: string }> = defineCheck({
  id: "gmail.draft-count-at-least",
  description:
    "Counts the rows in the exported `drafts` collection and asserts there are AT LEAST this " +
    "many — a lower bound, so a mailbox with more drafts than asked still passes. It counts " +
    "drafts the SEED placed there as well as any the examinee created, which means a criterion " +
    "whose number the seed already satisfies can be passed by an agent that does nothing. That " +
    "is a property of the task, not of this check, and `measure-criterion-discrimination` is " +
    "where it surfaces.",
  template: "At least {count} drafts exist",
  params: { count: countWord },
  substrate: "final",
  polarity: () => "positive",
  // A threshold, not a literal hunted for inside state — there is nothing here a
  // redactor could silently delete.
  subject: () => null,
  //
  // The NUMERIC sentinel, and the argument D10 demands before it may be used.
  //
  // In every other pattern a numeric capture is a SELECTOR — an issue number, a
  // PR number — that the predicate RESOLVES before it scans anything, so
  // falsifying it early-returns "not found" and moves the verdict for a reason
  // that never reaches the assertion. Here the count is the ONLY slot and there
  // is nothing to resolve: it is compared directly against a cardinality the
  // predicate computes, so falsifying it moves the verdict THROUGH the
  // assertion. That is the same argument `stripe.payment-intent-amount` makes,
  // and it is why a numeric sentinel is admissible on this check and on very few
  // others: an evaluator that allowlists the numeric sentinel per check should
  // expect these two.
  vacuityMutant: (args) => ({ ...args, count: String(VACUITY_SENTINEL_NUMBER) }),
  discriminatingWorlds: ({ count }) => {
    const wanted = parseCount(count) ?? 1;
    const build = (n: number) => {
      const pairs = Array.from({ length: n }, (_, i) => draftFor(`draft_${i}`, ["a@example.com"]));
      return gmailState({
        drafts: pairs.map((p) => p.draft),
        messages: pairs.map((p) => p.message),
      });
    };
    // The failing world is one SHORT, not empty: `wanted - 1` keeps the drafts
    // collection non-null so the failure is the count, not the absence.
    return { passing: finalWorld(build(wanted)), failing: finalWorld(build(Math.max(0, wanted - 1))) };
  },
  evaluate({ count }, { final }) {
    const wanted = parseCount(count);
    if (wanted === null) {
      // Unreachable through the generated pattern, which only admits digits and
      // the number words `parseCount` knows. Named rather than assumed, so a
      // widened slot type surfaces here instead of as a silent `NaN` comparison.
      return { passed: false, status: "skipped", reason: `uncountable ("${count}")` };
    }
    if (final.drafts == null) return { passed: false, status: "skipped", reason: "state_incomplete" };
    const total = final.drafts.length;
    if (total < wanted && isTruncated(final, "drafts")) {
      return { passed: false, status: "skipped", reason: 'collection_truncated ("drafts")' };
    }
    return {
      passed: total >= wanted,
      reason: `${total} draft(s) exist (wanted at least ${wanted})`,
      // The collection whose LENGTH is the assertion. There is no narrower
      // address for a cardinality.
      evidenceStatePaths: [DRAFTS_PATH],
    };
  },
});
