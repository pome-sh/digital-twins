// SPDX-License-Identifier: Apache-2.0
//
// How a declared check READS the exported Gmail mailbox (F-1128).
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

/** A resolver must be able to say WHY it found nothing: the ways of finding
 *  nothing get different verdicts. Same shape and same reason as twin-github's. */
export type Resolved<T> = { found: T } | { missing: string };

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
  const hits = state.messages.filter((message) => lower(message.id) === lower(id));
  if (hits.length > 1) {
    return { missing: `message_ambiguous ("${id}" exists in ${hits.length} mailboxes)` };
  }
  if (hits.length === 1) return { found: hits[0]! };
  if (isTruncated(state, "messages")) return { missing: 'collection_truncated ("messages")' };
  return { missing: `message_not_found ("${id}")` };
}

/**
 * Every label id that counts as `wanted`, lower-cased for comparison.
 *
 * Matches a label row by id OR by display name, because the corpus names both
 * kinds: `Label_follow_up` is an id, `Follow Up` is the name of the same label.
 * The bare `wanted` is always included so the join still works when the `labels`
 * collection was capped away — a `messageLabels` row carries the bare id
 * regardless.
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
    return { missing: 'collection_truncated ("messageLabels")' };
  }
  return { found: carried };
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
  const hit = state.labels.find((label) => lower(label.name) === lower(name));
  if (hit) return { found: hit };
  if (isTruncated(state, "labels")) return { missing: 'collection_truncated ("labels")' };
  return { missing: `label_not_found ("${name}")` };
}

/**
 * Who a draft is addressed to — `to` + `cc`, from the backing MESSAGE.
 *
 * The exported draft row carries no addressing at all, so a predicate reading it
 * alone would answer "no draft is addressed to anyone", always. A draft whose
 * message did not survive the export contributes nothing rather than throwing;
 * the caller decides whether that emptiness is answerable.
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
