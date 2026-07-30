// SPDX-License-Identifier: Apache-2.0
//
// What Gmail's declared checks can assert about MESSAGES (F-1128).
//
// All three read the exported end state. Note what is NOT here and cannot be:
// message bodies are digested out of `/_pome/state` unconditionally
// (`state.ts boundMessageExport`), so there is no gmail analogue of
// `slack.no-message-containing` — a substring scan over message prose has no
// substrate to read. `subject` is the only message prose that survives, and
// nothing in the corpus asserts on it yet.
//
// Declarations only. The grammar rules they obey are in `checks.ts`, which
// assembles them.

import { defineCheck, VACUITY_SENTINEL } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";
import { countWord, exactCount, labelRef, mailboxRef, messageId, parseCount } from "./check-params.js";
import {
  isTruncated,
  labelIdsFor,
  messageCarriesLabel,
  resolveMessage,
  type GmailCheckState,
} from "./check-state.js";
import {
  finalWorld,
  gmailState,
  message,
  messageLabel,
  systemLabel,
  userLabel,
} from "./check-worlds.js";

// The workhorse of gmail's corpus: it binds three of the six criteria A3 found
// unbound, because tasks 22 and 27 say the same sentence about `msg_support` and
// task 23 says it about `msg_parity`. One check, three criteria — the same way
// `github.no-new-labels` cleared five.
export const messageHasLabel: Check<{ message: string; label: string }> = defineCheck({
  id: "gmail.message-has-label",
  description:
    "Looks the message up by id, then asks the `messageLabels` JOIN whether any row links it to " +
    "the named label. The label may be given as its minted id (`Label_follow_up`) or as the " +
    "display name of the same label (`Follow Up`); a system label carries both as one string " +
    "(`INBOX`, `STARRED`). It asserts nothing about the message's OTHER labels — a message " +
    "carrying the named label plus five more passes. A message the export does not carry is a " +
    "SKIP, not a fail, and so is a label collection the export truncated: absent from a capped " +
    "list is not absent.",
  template: "Message {message} has label {label}",
  params: { message: messageId, label: labelRef },
  substrate: "final",
  // An achievement. The seed leaves `msg_support` on INBOX/UNREAD only, so the
  // examinee has to act for this to hold.
  polarity: () => "positive",
  // The label is a caller-supplied literal compared against state, so it is
  // declared. No first-party redactor pattern touches a Gmail label id, which is
  // exactly why declaring it keeps that a verified fact rather than an
  // assumption — a team's own redaction config is not first-party.
  subject: ({ label }) => label,
  // The message id only SELECTS; falsifying it moves the verdict through the
  // lookup rather than the assertion. The label is the scanned literal.
  vacuityMutant: (args) => ({ ...args, label: VACUITY_SENTINEL }),
  discriminatingWorlds: ({ message: id, label }) => {
    // The message is PRESENT in both worlds and only the JOIN row moves. A world
    // without the message would fail through the selector, reproducing the reason
    // an empty world already gives — which the probe rejects as degenerate.
    const labels = [systemLabel("INBOX"), userLabel(label, label)];
    const base = { messages: [message(id)], labels };
    return {
      passing: finalWorld(
        gmailState({ ...base, messageLabels: [messageLabel(id, "INBOX"), messageLabel(id, label)] }),
      ),
      failing: finalWorld(gmailState({ ...base, messageLabels: [messageLabel(id, "INBOX")] })),
    };
  },
  evaluate({ message: id, label }, { final }) {
    const found = resolveMessage(final, id);
    if ("missing" in found) return { passed: false, status: "skipped", reason: found.missing };
    const carried = messageCarriesLabel(final, id, label);
    if ("missing" in carried) return { passed: false, status: "skipped", reason: carried.missing };
    return {
      passed: carried.found,
      reason: carried.found
        ? `message ${id} carries label ${label}`
        : `message ${id} does not carry label ${label}`,
    };
  },
});

// Carried across from pome-cloud's `gmail.mailbox-label-count` regex, which
// graded the retry/partial-failure curriculum class. The legacy pattern was
// case-insensitive and tolerated `labelled`, a trailing period and three quote
// styles; under position 2 an author PICKS the check rather than typing it, so
// those variants are retired rather than ported — exactly as F-1075 retired
// `issue-has-label-generic`.
export const mailboxLabelCount: Check<{ mailbox: string; count: string; label: string }> =
  defineCheck({
    id: "gmail.mailbox-label-count",
    description:
      "Counts the messages in the named mailbox that the `messageLabels` JOIN links to the named " +
      "label, and asserts the total is EXACTLY the number given. Not 'at least' — a mailbox with " +
      "six SENT messages fails a criterion asking for five, which is what makes it able to catch " +
      "a duplicate send. A mailbox the export lists but does not contain is a SKIP; so is a " +
      "truncated collection.",
    template: "The mailbox `{mailbox}` has exactly {count} messages labeled {label}",
    params: { mailbox: mailboxRef, count: exactCount, label: labelRef },
    substrate: "final",
    // The count carries the direction: asserting zero is a prohibition, any
    // other count is work the examinee must do. Preserved from the legacy rule,
    // which computed the same thing per match.
    polarity: ({ count }) => (Number(count) === 0 ? "negative" : "positive"),
    subject: ({ label }) => label,
    // The mailbox resolves and the count is compared to a derived total; the
    // label is the literal actually scanned in state. Pointing the mutant at the
    // count would falsify a threshold rather than a lookup — see
    // `gmail.draft-count-at-least`, where the count IS the only slot.
    vacuityMutant: (args) => ({ ...args, label: VACUITY_SENTINEL }),
    discriminatingWorlds: ({ mailbox, count, label }) => {
      const wanted = Number(count);
      const world = (n: number): GmailCheckState => {
        const messages = Array.from({ length: n }, (_, i) => message(`msg_${i}`, { mailboxEmail: mailbox }));
        return gmailState({
          mailboxes: [{ email: mailbox }],
          messages,
          labels: [systemLabel(label)],
          messageLabels: messages.map((m) => ({ mailboxEmail: mailbox, messageId: m.id, labelId: label })),
        });
      };
      // The mailbox resolves in BOTH worlds and only the count moves. `wanted + 1`
      // rather than zero so the failing world is never also the empty one.
      return { passing: finalWorld(world(wanted)), failing: finalWorld(world(wanted + 1)) };
    },
    evaluate({ mailbox, count, label }, { final }) {
      const wanted = Number(count);
      if (final.messages == null || final.messageLabels == null) {
        return { passed: false, status: "skipped", reason: "state_incomplete" };
      }
      if (isTruncated(final, "messages") || isTruncated(final, "messageLabels")) {
        return { passed: false, status: "skipped", reason: "collection_truncated" };
      }
      // A mailboxes collection that is present and omits this mailbox means we
      // cannot attest anything about it. An ABSENT collection is a different
      // fact — proceed by email, the way the export's own rows are keyed.
      if (
        final.mailboxes != null &&
        !final.mailboxes.some((mb) => (mb.email ?? "").toLowerCase() === mailbox.toLowerCase())
      ) {
        return { passed: false, status: "skipped", reason: `mailbox_not_found ("${mailbox}")` };
      }
      const ids = labelIdsFor(final, label);
      const labeled = new Set(
        final.messageLabels
          .filter((row) => ids.has((row.labelId ?? "").toLowerCase()))
          .map((row) => (row.messageId ?? "").toLowerCase()),
      );
      const total = final.messages.filter(
        (msg) =>
          (msg.mailboxEmail ?? "").toLowerCase() === mailbox.toLowerCase() &&
          msg.id != null &&
          labeled.has(msg.id.toLowerCase()),
      ).length;
      return {
        passed: total === wanted,
        reason: `mailbox "${mailbox}" has ${total} message(s) labeled ${label} (wanted ${wanted})`,
      };
    },
  });

// Also carried across from pome-cloud. This is the one that catches a duplicate
// send, which is the whole point of the retry curriculum class: a naive retry
// loop sends twice to the same address and this is what notices.
export const oneMessagePerRecipient: Check<{ label: string; count: string }> = defineCheck({
  id: "gmail.one-message-per-recipient",
  description:
    "Flattens every addressee across the messages carrying the named label and asserts each " +
    "address appears EXACTLY ONCE — and, when a count is named, that there are that many " +
    "messages, that many distinct recipients, and no more addressee slots than that. It is the " +
    "assertion that separates 'sent to everyone' from 'sent to everyone, some of them twice', " +
    "which an exact total alone cannot do.",
  template: "Exactly one {label} message is addressed to each of the {count} recipients",
  params: { label: labelRef, count: countWord },
  substrate: "final",
  polarity: () => "positive",
  subject: ({ label }) => label,
  // The label is scanned; the count is a declared arity compared to a derived
  // one. Same argument as `mailboxLabelCount`.
  vacuityMutant: (args) => ({ ...args, label: VACUITY_SENTINEL }),
  discriminatingWorlds: ({ label, count }) => {
    const wanted = parseCount(count) ?? 1;
    const recipients = Array.from({ length: wanted }, (_, i) => `user${i}@example.com`);
    const build = (addressees: string[][]) => {
      const messages = addressees.map((to, i) => message(`msg_${i}`, { to }));
      return finalWorld(
        gmailState({
          messages,
          labels: [systemLabel(label)],
          messageLabels: messages.map((m) => messageLabel(m.id!, label)),
        }),
      );
    };
    return {
      passing: build(recipients.map((r) => [r])),
      // The DUPLICATE SEND, not a missing one: the same number of messages, one
      // recipient served twice and another not at all. A world with fewer
      // messages would fail on arity, which the exact-count check already covers.
      failing: build([[recipients[0]!], ...recipients.slice(2).map((r) => [r]), [recipients[0]!]]),
    };
  },
  evaluate({ label, count }, { final }) {
    const wanted = parseCount(count);
    if (final.messages == null || final.messageLabels == null) {
      return { passed: false, status: "skipped", reason: "state_incomplete" };
    }
    if (isTruncated(final, "messages") || isTruncated(final, "messageLabels")) {
      return { passed: false, status: "skipped", reason: "collection_truncated" };
    }
    const ids = labelIdsFor(final, label);
    const labeled = new Set(
      final.messageLabels
        .filter((row) => ids.has((row.labelId ?? "").toLowerCase()))
        .map((row) => (row.messageId ?? "").toLowerCase()),
    );
    const sent = final.messages.filter((msg) => msg.id != null && labeled.has(msg.id.toLowerCase()));
    const addressees = sent.flatMap((msg) => (msg.to ?? []).map((to) => to.toLowerCase()));
    const distinct = new Set(addressees);
    const noDuplicates = addressees.length === distinct.size;
    const arityOk =
      wanted == null
        ? sent.length === distinct.size
        : sent.length === wanted && distinct.size === wanted && addressees.length === wanted;
    const passed = noDuplicates && arityOk;
    return {
      passed,
      reason: passed
        ? `${sent.length} ${label} message(s), one per distinct recipient, no duplicates`
        : `${sent.length} ${label} message(s) to ${distinct.size} distinct recipient(s) ` +
          `(${addressees.length} addressee slot(s)${wanted == null ? "" : `, wanted ${wanted}`}` +
          `${noDuplicates ? "" : ", duplicate send detected"})`,
    };
  },
});
