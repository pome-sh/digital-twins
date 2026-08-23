// SPDX-License-Identifier: Apache-2.0
//
// What Gmail's declared checks can assert about LABEL DEFINITIONS.
//
// Separate from `check-messages.ts` because it asks a different question of a
// different collection: whether a label EXISTS in the mailbox at all, not
// whether a message carries one. Gmail's own API splits them the same way —
// `create_label` is mailbox-scoped, `label_message` is message-scoped — and
// `github.no-new-labels` records what happens when one sentence blurs the two.

import { defineCheck, VACUITY_SENTINEL } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";
import { labelName } from "./check-params.js";
import { missSkip, resolveLabelByName } from "./check-state.js";
import { finalWorld, gmailState, systemLabel, userLabel } from "./check-worlds.js";

export const labelExists: Check<{ label: string }> = defineCheck({
  id: "gmail.label-exists",
  description:
    "Asks whether the mailbox defines a label with this DISPLAY NAME, compared case-insensitively " +
    "the way the twin's own seeder keys its uniqueness lookup. It reads the `labels` collection " +
    "only — a label that exists but has been applied to nothing still passes, and a message " +
    "carrying a label is `gmail.message-has-label`'s question, not this one. It deliberately does " +
    "NOT match on the minted id: `Label_follow_up` is an id and `Follow Up` is the name of that " +
    "same label, and letting one sentence mean both would make the assertion unreadable.",
  // The name slot admits spaces, which is what the corpus needs (`Parity
  // Complete`) and what separates this template from `gmail.message-has-label`'s
  // id slot. The two cannot claim one sentence: this one says "A label named",
  // that one says "Message ... has label".
  template: "A label named {label} exists",
  params: { label: labelName },
  substrate: "final",
  // An achievement — the seed defines no `Parity Complete`, so the
  // examinee has to create it.
  polarity: () => "positive",
  // The name is a caller-supplied literal compared against state.
  subject: ({ label }) => label,
  vacuityMutant: (args) => ({ ...args, label: VACUITY_SENTINEL }),
  discriminatingWorlds: ({ label }) => ({
    // Both worlds carry a non-empty `labels` collection, so the failing world
    // fails on the ASSERTION (`label_not_found`) rather than reproducing the
    // `state_incomplete` an empty world gives — the degenerate arm the probe
    // rejects.
    passing: finalWorld(
      gmailState({ labels: [systemLabel("INBOX"), userLabel("Label_1", label)] }),
    ),
    failing: finalWorld(gmailState({ labels: [systemLabel("INBOX")] })),
  }),
  evaluate({ label }, { final }) {
    const found = resolveLabelByName(final, label);
    if ("missing" in found) {
      // `state_incomplete` and `collection_truncated` are unanswerable; a label
      // genuinely not there is the honest FAIL this check exists to deliver.
      if (found.missing.startsWith("label_not_found")) {
        return {
          passed: false,
          reason: `no label named "${label}" exists`,
          // The label COLLECTION — the honest citation for a lookup that found
          // nothing, and the arm a reader most wants to open: see for yourself
          // that the name is not in it.
          ...(found.searched === undefined ? {} : { evidenceStatePaths: [found.searched] }),
        };
      }
      return missSkip(found);
    }
    return {
      passed: true,
      reason: `label "${label}" exists (id ${found.found.id ?? "?"})`,
      evidenceStatePaths: [found.path],
    };
  },
});
