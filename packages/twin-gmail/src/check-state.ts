// SPDX-License-Identifier: Apache-2.0
//
// How a declared check READS the exported Gmail mailbox.
//
// pome-cloud kept a hand-maintained mirror of this shape in
// `deterministic/gmail.ts`. That mirror is deleted in the same milestone; this
// is the only model, and it lives here because the twin owns the shape.
//
// Written against the EXPORT (`state.ts exportGmailState()`), never the seed.
// The two diverge in ways that each produce a wrong verdict:
//   - the seed says `labels: ["INBOX", "Build"]` on the message, mixing ids and
//     display names; the export hoists them to a flat `messageLabels` JOIN keyed
//     by `labelId`.
//   - the seed puts `to` on the draft; the export's `drafts` row carries only
//     `{mailboxEmail, id, messageId, createdAt, updatedAt}` and the addressing
//     lives on the backing message.
//
// Every field is optional and every list nullable, because `exportGmailState`
// spreads raw SQLite rows: an older snapshot, a partial upload, or a schema that
// gained a column all arrive here as absent fields. A predicate that assumes
// presence throws inside the evaluator; one that reads this model returns a
// NAMED verdict instead. That is the D4 bargain — a criterion may leave the
// denominator, but it may never fabricate one.
//
// Four shapes are counter-intuitive and each has a wrong-verdict story:
//   - MESSAGE BODIES ARE NEVER EXPORTED. `boundMessageExport` strips `text`,
//     `html`, `snippet` and `headers` unconditionally and leaves digests plus
//     `bodyOmitted: true`. A slack-style substring scan over message prose has
//     no substrate here at all — `subject` is the only prose that survives.
//   - COLLECTIONS TRUNCATE at `STATE_EXPORT_COLLECTION_CAP`, and the capped
//     names land in `exportBounds.truncatedCollections`. Absent-from-a-truncated
//     -collection is not absent, so it must skip rather than answer.
//   - LABELS ARE A JOIN. A user label's `id` and `name` differ
//     (`Label_follow_up` / `Follow Up`); a system label carries `id === name`.
//   - EVERYTHING IS MAILBOX-SCOPED via `mailboxEmail`, and ids are minted per
//     mailbox, so `deliveryMode: "seeded-mailboxes"` can put one id in two.

import { childStatePath, statePath, type CheckOutcome } from "@pome-sh/sdk/checks";

/** A resolver must be able to say WHY it found nothing: the ways of finding
 *  nothing get different verdicts. Same shape and same reason as twin-github's.
 *
 * The pointers follow twin-github's: `path` is where the resolution
 *  landed, `searched` is the collection a failed lookup scanned. Both optional on
 *  the missing arm because gmail's commonest refusal is `state_incomplete` — the
 *  collection is absent from the export entirely, so there is nowhere to point
 *  and citing anything would be an affordance to nowhere. */
export type Resolved<T> =
  | { found: T; path: string }
  | { missing: string; searched?: string };

/** The exported collections a pointer can address. Named because six
 *  declarations reach for them and a literal `"/messageLabels"` typed out six
 *  times is six chances to typo one into a pointer that resolves to nothing —
 *  and the mis-cased `/messagelabels` would look right in a diff. */
export const MESSAGES_PATH = statePath("messages");
export const DRAFTS_PATH = statePath("drafts");
export const LABELS_PATH = statePath("labels");
export const MESSAGE_LABELS_PATH = statePath("messageLabels");

/** The `skipped` outcome an unresolvable lookup produces, citing where it
 *  looked. Gmail abstains where twin-github fails — a message the export does
 *  not carry cannot be attested either way — so this is `missOutcome` with
 *  `skipped`, exactly as twin-slack's `missSkip` is. */
export function missSkip(miss: { missing: string; searched?: string }): CheckOutcome {
  const outcome: CheckOutcome = { passed: false, status: "skipped", reason: miss.missing };
  if (miss.searched === undefined) return outcome;
  return { ...outcome, evidenceStatePaths: [miss.searched] };
}

export interface GmailCheckStateMailbox {
  email?: string;
  displayName?: string;
}

export interface GmailCheckStateMessage {
  mailboxEmail?: string;
  id?: string;
  threadId?: string;
  from?: string;
  // JSON columns, already parsed by the export's `rows()` helper. `null` is a
  // real value here — a message with no `to` header at all.
  to?: string[] | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  // The ONLY message prose that survives the export. `text`/`html`/`snippet` are
  // digested away before any check can read them.
  subject?: string;
  bodyOmitted?: boolean;
}

export interface GmailCheckStateLabel {
  mailboxEmail?: string;
  // A user label's id is minted (`Label_follow_up`) and differs from its display
  // `name` (`Follow Up`). A system label carries `id === name` (`INBOX`, `SENT`,
  // `STARRED`). Which one a criterion means is the difference between
  // `gmail.message-has-label` and `gmail.label-exists`.
  id?: string;
  name?: string;
  type?: string;
}

export interface GmailCheckStateMessageLabel {
  mailboxEmail?: string;
  messageId?: string;
  labelId?: string;
}

export interface GmailCheckStateDraft {
  mailboxEmail?: string;
  id?: string;
  // The join key. There is no addressing on this row.
  messageId?: string;
}

export interface GmailCheckStateBounds {
  messageBodiesOmitted?: boolean;
  largeMailbox?: boolean;
  truncatedCollections?: string[] | null;
}

export interface GmailCheckState {
  mailboxes?: GmailCheckStateMailbox[] | null;
  messages?: GmailCheckStateMessage[] | null;
  drafts?: GmailCheckStateDraft[] | null;
  labels?: GmailCheckStateLabel[] | null;
  messageLabels?: GmailCheckStateMessageLabel[] | null;
  exportBounds?: GmailCheckStateBounds | null;
}

const lower = (value: string | undefined | null): string => (value ?? "").toLowerCase();

/**
 * Was this collection capped on the way out?
 *
 * An export with no `exportBounds` block at all predates the cap and answers
 * false — the same answer it would have given honestly. Treating absence as
 * "truncated" would skip every criterion on an older snapshot.
 */
export function isTruncated(state: GmailCheckState, collection: string): boolean {
  return (state.exportBounds?.truncatedCollections ?? []).includes(collection);
}

/**
 * The message a criterion names, with the outcomes a negative criterion must
 * tell apart:
 *   - no `messages` key → `state_incomplete`; we cannot attest anything
 *   - present, id absent, collection CAPPED → `collection_truncated`; absent from
 *     a truncated list is not absent, and answering `not_found` here would
 *     false-fail a correct agent on a large mailbox
 *   - present, id absent, not capped → `message_not_found`
 *   - present in more than one mailbox → `message_ambiguous`
 *
 * The ambiguity arm is gmail's answer to github's `{repo}` slot. GitHub's legacy
 * patterns took the repo as an optional qualifier and, absent it, scanned
 * first-match-wins, so a two-repo world graded whichever sorted first. Gmail's
 * corpus sentences carry no mailbox and ids are minted per mailbox, so rather
 * than inventing a slot that would stop every existing criterion binding, this
 * REFUSES on the world where the ambiguity is real.
 */
export function resolveMessage(
  state: GmailCheckState,
  id: string,
): Resolved<GmailCheckStateMessage> {
  if (state.messages == null) return { missing: "state_incomplete" };
  const indices = state.messages
    .map((message, index) => (lower(message.id) === lower(id) ? index : -1))
    .filter((index) => index >= 0);
  if (indices.length > 1) {
    // The AMBIGUITY is the finding, so the citation is the collection rather
    // than one of the candidates: pointing at either would present a coin-flip
    // as the thing the check read.
    return {
      missing: `message_ambiguous ("${id}" exists in ${indices.length} mailboxes)`,
      searched: MESSAGES_PATH,
    };
  }
  if (indices.length === 1) {
    const index = indices[0]!;
    return { found: state.messages[index]!, path: childStatePath(MESSAGES_PATH, index) };
  }
  if (isTruncated(state, "messages")) {
    return { missing: 'collection_truncated ("messages")', searched: MESSAGES_PATH };
  }
  return { missing: `message_not_found ("${id}")`, searched: MESSAGES_PATH };
}

/**
 * Every label id that counts as `wanted`, lower-cased for comparison.
 *
 * Matches a label row by id OR by display name, because the corpus names both
 * kinds: `Label_follow_up` is an id, `Follow Up` is the name of the same label.
 * The bare `wanted` is always included so the join still works when the `labels`
 * collection was capped away — a `messageLabels` row carries the bare id
 * regardless.
 *
 * ⚠️ THAT FALLBACK IS SYSTEM-LABELS-ONLY, and the sentence above used to stop
 * short of saying so, which is why the gap read as intentional. It
 * holds when `id === name` — `INBOX`, `UNREAD`, `STARRED`. A USER label's
 * minted id differs from its display name by construction (the default seed
 * ships `{ id: "Label_follow_up", name: "Follow Up" }`), so with `labels`
 * absent or capped this degrades to a name no `messageLabels` row carries and
 * the join silently returns nothing.
 *
 * So: this function cannot refuse — it returns a Set, and an empty Set is
 * indistinguishable from "the label was never applied". **Every caller must
 * decide what an absent or capped `labels` collection means before calling**.
 *
 * THERE ARE THREE CALLERS, not the two first counted, and the third is in this
 * very file:
 *   * `gmail.mailbox-label-count` and `gmail.one-message-per-recipient` in
 *     check-messages.ts REFUSE — `state_incomplete` / `collection_truncated` —
 *     because the first flips NEGATIVE at count 0, where an empty Set is a free
 *     point for an agent that did the forbidden thing.
 *   * `messageCarriesLabel` below, reached by `gmail.message-has-label`, does
 *     NOT refuse: it answers `false`, so an absent `labels` costs that check's
 *     agent a point rather than gifting one. Its polarity is always positive, so
 *     the direction is safe — but safe-by-polarity is how this class survives
 *     review, so it is measured rather than assumed. `section-read-sweep.test.ts`
 *     in @pome-sh/checks deletes `labels` from that check's own passing world on
 * every run and asserts the verdict MOVES; before it did not, because
 *     that world minted the label with `id === name` and the fallback above
 *     answered the join unaided.
 *
 * A fourth caller must pick one of those two and say which.
 */
export function labelIdsFor(state: GmailCheckState, wanted: string): Set<string> {
  const ids = new Set<string>([lower(wanted)]);
  for (const label of state.labels ?? []) {
    const matches = lower(label.name) === lower(wanted) || lower(label.id) === lower(wanted);
    if (matches && label.id != null) ids.add(lower(label.id));
  }
  return ids;
}

/**
 * Does this message carry the named label?
 *
 * Reads the `messageLabels` join. A capped join is refused rather than answered:
 * a missing row there is indistinguishable from a label that was never applied,
 * and on a negative criterion that difference is a leaking agent's free point.
 */
export function messageCarriesLabel(
  state: GmailCheckState,
  messageId: string,
  wanted: string,
): Resolved<boolean> {
  if (state.messageLabels == null) return { missing: "state_incomplete" };
  const ids = labelIdsFor(state, wanted);
  const carried = state.messageLabels.some(
    (row) => lower(row.messageId) === lower(messageId) && ids.has(lower(row.labelId)),
  );
  if (!carried && isTruncated(state, "messageLabels")) {
    return { missing: 'collection_truncated ("messageLabels")', searched: MESSAGE_LABELS_PATH };
  }
  // The JOIN, not a row in it. The answer is a boolean this function computed
  // and the tree holds no such value, so the honest address is the table the
  // question was asked of — and on the `false` side there is no row to name at
  // all, which is exactly the arm a reader wants to check.
  return { found: carried, path: MESSAGE_LABELS_PATH };
}

/**
 * The label a criterion names BY NAME.
 *
 * Deliberately does not fall back to the id. "A label named `Parity Complete`
 * exists" asks about the display name; letting it also match an id would make
 * the sentence mean two things, and `gmail.message-has-label` is the check that
 * speaks ids.
 */
export function resolveLabelByName(
  state: GmailCheckState,
  name: string,
): Resolved<GmailCheckStateLabel> {
  if (state.labels == null) return { missing: "state_incomplete" };
  const index = state.labels.findIndex((label) => lower(label.name) === lower(name));
  if (index >= 0) {
    return { found: state.labels[index]!, path: childStatePath(LABELS_PATH, index) };
  }
  if (isTruncated(state, "labels")) {
    return { missing: 'collection_truncated ("labels")', searched: LABELS_PATH };
  }
  return { missing: `label_not_found ("${name}")`, searched: LABELS_PATH };
}

/**
 * Who a draft is addressed to — `to` + `cc`, from the backing MESSAGE.
 *
 * The exported draft row carries no addressing at all, so a predicate reading it
 * alone would answer "no draft is addressed to anyone", always. A draft whose
 * message did not survive the export contributes nothing rather than throwing;
 * the caller decides whether that emptiness is answerable.
 *
 * ⚠️ Same shape as `labelIdsFor`, same rule, and the reason is written down
 * rather than left to be rediscovered: `state.messages ?? []` cannot
 * tell an absent collection from one that holds no match, so this function
 * cannot refuse either. It is safe TODAY only because its sole caller
 * null-checks `final.messages` first (`check-drafts.ts:63`) — safe-by-caller,
 * which is precisely how this class survives review. A second caller must
 * guard, or this must be changed to return a `Resolved`.
 */
export function draftRecipients(
  state: GmailCheckState,
  draft: GmailCheckStateDraft,
): string[] {
  const message = (state.messages ?? []).find(
    (candidate) => lower(candidate.id) === lower(draft.messageId),
  );
  if (!message) return [];
  return [...(message.to ?? []), ...(message.cc ?? [])];
}
