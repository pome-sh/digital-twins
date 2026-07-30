// SPDX-License-Identifier: Apache-2.0
//
// The Gmail twin's assertable check vocabulary (F-1128, milestone A3).
//
// These live HERE, next to the state they read, because the twin owns that
// state's shape. pome-cloud imports this module from npm and adapts each
// declaration onto its predicate engine, so there is no second copy to
// reconcile — only a pin that can fall behind, which is what its drift gate
// exists to catch. The cloud's `deterministic/gmail.ts`, and the mirror of the
// state shape inside it, are deleted in the same milestone.
//
// Gmail comes third in A3 and is the first that needed PLUMBING before
// vocabulary: unlike slack and stripe it had no in-process seed loader in the
// control plane at all, so every gmail criterion reported `no_seed_loader` —
// not a wrong verdict, an absent one. Six criteria across tasks 22, 23 and 27
// resolved zero of six before this.
//
// This file is the ASSEMBLY. Declarations are grouped by what they assert about
// — `check-messages.ts`, `check-labels.ts`, `check-drafts.ts`, `check-tape.ts` —
// with typed slots in `check-params.ts`, fixture worlds in `check-worlds.ts`,
// and the reading of the exported tree in `check-state.ts`.

import { draftAddressedTo, draftCountAtLeast } from "./check-drafts.js";
import { labelExists } from "./check-labels.js";
import { mailboxLabelCount, messageHasLabel, oneMessagePerRecipient } from "./check-messages.js";
import { noUnsupportedEndpoint } from "./check-tape.js";

export type { Check } from "./check-kind.js";
export type {
  GmailCheckState,
  GmailCheckStateDraft,
  GmailCheckStateLabel,
  GmailCheckStateMailbox,
  GmailCheckStateMessage,
  GmailCheckStateMessageLabel,
} from "./check-state.js";

// Order is not first-match-wins — the generated patterns are anchored and
// mutually exclusive, and `checks-contract.test.ts` proves no sentence is
// claimed by two. It is the order an authoring surface lists them in, running
// from the assertion an author reaches for first to the ones a specialised task
// needs.
export const GMAIL_CHECKS = [
  messageHasLabel,
  labelExists,
  draftAddressedTo,
  draftCountAtLeast,
  mailboxLabelCount,
  oneMessagePerRecipient,
  // Last, because these are the only ones that assert about the RUN rather than
  // the world it left behind — twin-github orders its tape checks the same way.
  noUnsupportedEndpoint,
] as const;
