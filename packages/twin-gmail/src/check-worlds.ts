// SPDX-License-Identifier: Apache-2.0
//
// The fixture worlds Gmail's declarations name (F-1128).
//
// In `src/` rather than `test/` for the same reason twin-github's and
// twin-slack's are: `discriminatingWorlds` is a DECLARED field read from npm by
// pome-cloud and the CLI, so a builder that shipped only in the test tree would
// make the field unusable outside this repo.
//
// `gmailState` fills every collection explicitly, including the empty ones.
// Omitting one makes the reader answer `state_incomplete`, which is a SKIP, and
// a skip satisfies neither arm of the discrimination gate — so the explicitness
// is load-bearing, not tidiness.

import type { CheckSubstrate, CheckTapeEvent } from "@pome-sh/sdk/checks";
import type {
  GmailCheckState,
  GmailCheckStateDraft,
  GmailCheckStateLabel,
  GmailCheckStateMessage,
  GmailCheckStateMessageLabel,
} from "./check-state.js";

export const FIXTURE_MAILBOX = "pome-agent@pome-twin.test";

export function gmailState(parts: Partial<GmailCheckState> = {}): GmailCheckState {
  return {
    mailboxes: [{ email: FIXTURE_MAILBOX }],
    messages: [],
    drafts: [],
    labels: [],
    messageLabels: [],
    exportBounds: { messageBodiesOmitted: true, largeMailbox: false, truncatedCollections: [] },
    ...parts,
  };
}

export function finalWorld(final: GmailCheckState): CheckSubstrate<GmailCheckState> {
  return { seed: null, final, tape: null };
}

// A well-formed but EMPTY mailbox, deliberately not `{}`. A tape check must not
// read state, and handing it a shape that would satisfy a state check hides the
// difference — twin-github's `tapeWorld` makes the same choice for the same
// reason.
export function tapeWorld(tape: readonly CheckTapeEvent[]): CheckSubstrate<GmailCheckState> {
  return { seed: null, final: gmailState(), tape };
}

export function message(
  id: string,
  parts: Partial<GmailCheckStateMessage> = {},
): GmailCheckStateMessage {
  return { mailboxEmail: FIXTURE_MAILBOX, id, to: [FIXTURE_MAILBOX], bodyOmitted: true, ...parts };
}

export function systemLabel(name: string): GmailCheckStateLabel {
  // System labels carry `id === name`. Building them any other way would make a
  // fixture that the twin's own export could never produce.
  return { mailboxEmail: FIXTURE_MAILBOX, id: name, name, type: "system" };
}

export function userLabel(id: string, name: string): GmailCheckStateLabel {
  return { mailboxEmail: FIXTURE_MAILBOX, id, name, type: "user" };
}

export function messageLabel(messageId: string, labelId: string): GmailCheckStateMessageLabel {
  return { mailboxEmail: FIXTURE_MAILBOX, messageId, labelId };
}

export function draft(id: string, messageId: string): GmailCheckStateDraft {
  return { mailboxEmail: FIXTURE_MAILBOX, id, messageId };
}

/** A draft plus the message its addressing lives on — the pair, because either
 *  alone is a world the export could not produce. */
export function draftAddressedTo(
  id: string,
  recipients: string[],
): { draft: GmailCheckStateDraft; message: GmailCheckStateMessage } {
  const messageId = `${id}_message`;
  return {
    draft: draft(id, messageId),
    message: message(messageId, { to: recipients }),
  };
}
