// SPDX-License-Identifier: Apache-2.0
//
// How a declared check READS the exported Slack workspace (F-1126).
//
// Slack had no state model at all before this file. `exportState()`
// (`domain/slack-domain.ts:226`) returns `Record<string, unknown>` — a set of
// `SELECT *` dumps — and pome-cloud kept a hand-maintained mirror of the shape
// in `deterministic/slack.ts`. That mirror is deleted in the same milestone;
// this is the only model.
//
// Split from `checks.ts` on twin-github's precedent: what the vocabulary can
// assert is a different question from how the tree is shaped, and the tree is
// the half that moves when the twin's schema does.
//
// Every field is optional and every list nullable, because `exportState()`
// spreads raw SQLite rows: an older snapshot, a partial upload, or a schema that
// gained a column all arrive here as absent fields. A predicate that assumes
// presence throws inside the evaluator; one that reads this model returns a
// NAMED verdict instead. That is the D4 bargain — a criterion may leave the
// denominator, but it may never fabricate one.
//
// Three shapes are counter-intuitive and each has a wrong-verdict story:
//   - `is_private` is a SQLite INTEGER `0 | 1`, never a boolean. A predicate
//     written against `=== true` silently never fires. This is the same trap
//     twin-github's `pull_request.merged` comment names.
//   - There is NO `is_public`, and DMs share the `channels` array with real
//     channels (`allChannels()` is an unfiltered SELECT). "Public" is the
//     conjunction of four falsy flags, not one.
//   - The WIRE serializer computes private as `is_private || is_group`
//     (`serializers.ts:154`); this export does no such OR and emits both raw
//     columns. The two surfaces can disagree about what private means, so
//     `isPublicChannel` reads both rather than trusting either alone.

import { childStatePath, statePath, type CheckOutcome } from "@pome-sh/sdk/checks";

/** The token `redactSecrets` leaves in place of anything it destroys. */
export const REDACTION_TOKEN = "[REDACTED]";

export interface SlackCheckStateMessage {
  ts?: string;
  // `user_id`, NOT `user`. The SEED schema calls this field `user`; the export
  // spreads the raw `messages` row, where the column is `user_id`. The two
  // shapes diverge in several places — the seed also uses `is_private: boolean`
  // where the export emits `0 | 1`, and nests reactions inside messages where
  // the export hoists them to a flat top-level list — which is why this model is
  // written against the EXPORT and why the state-shape parity arm in
  // `fidelity-contract.test.ts` exists. That arm caught this exact field on its
  // first run.
  user_id?: string;
  // Free prose, already through the redaction pipeline by the time any check
  // reads it — at the twin (`sdk/src/server.ts:318`) and again at the scoring
  // door (`routes/scenarios.ts:267`). Both sides of a delta cross the same
  // redactors, which is what makes POSITION comparable when the VALUE is not.
  text?: string;
  thread_ts?: string | null;
}

export interface SlackCheckStateChannel {
  id?: string;
  name?: string;
  // SQLite integer booleans on a real export. `boolean` is accepted so a
  // hand-written fixture also works, and `null`/absent is a THIRD world that
  // must not be collapsed into `false` — see `isPublicChannel`.
  is_private?: number | boolean | null;
  is_group?: number | boolean | null;
  is_im?: number | boolean | null;
  is_mpim?: number | boolean | null;
  members?: string[] | null;
  messages?: SlackCheckStateMessage[] | null;
}

// Reactions are a FLAT top-level list keyed by `channel_id`, not nested under
// their channel. A channel-scoped reaction predicate resolves the channel first,
// then filters this.
export interface SlackCheckStateReaction {
  channel_id?: string;
  message_ts?: string;
  name?: string;
  user_id?: string;
}

export interface SlackCheckState {
  channels?: SlackCheckStateChannel[] | null;
  reactions?: SlackCheckStateReaction[] | null;
}

/** twin-github's verdict type, same shape and same reason: a resolver must be
 *  able to say WHY it found nothing, because the three ways of finding nothing
 *  get three different verdicts.
 *
 *  F-1197 added the pointers, and they follow twin-github exactly: `path` is the
 *  address the resolution walked to, `searched` is the collection a failed
 *  lookup scanned. `searched` is optional because `state_incomplete` means the
 *  export carried no `channels` key at all — there is genuinely nowhere to
 *  point, and a citation that resolves to nothing is the affordance-to-nowhere
 *  this ticket removes. */
export type Resolved<T> =
  | { found: T; path: string }
  | { missing: string; searched?: string };

/** The pointer at the workspace's channel list — the collection every
 *  channel-scoped resolution scans, and the citation a workspace-wide scan
 *  makes. Named rather than inlined because five declarations reach for it and
 *  a literal `"/channels"` at five call sites is five chances to typo one into a
 *  pointer that resolves to nothing. */
export const CHANNELS_PATH = statePath("channels");

/** The `skipped` outcome an unresolvable channel produces, citing where the
 *  lookup looked. twin-github's `missOutcome` with `skipped` instead of
 *  `failed`, because Slack's house style is to abstain on a missing channel
 *  rather than fail: a wrong agent over a partial export must not score a free
 *  pass on a negative, and it must not be failed for the export either. */
export function missSkip(miss: { missing: string; searched?: string }): CheckOutcome {
  const outcome: CheckOutcome = { passed: false, status: "skipped", reason: miss.missing };
  if (miss.searched === undefined) return outcome;
  return { ...outcome, evidenceStatePaths: [miss.searched] };
}

const isSet = (flag: number | boolean | null | undefined): boolean => flag === 1 || flag === true;

/**
 * Is this a channel a non-member of the workspace could read?
 *
 * `null` means UNDECLARED, and it is not a convenience. F-1028: guessing
 * "public" false-fails a correct agent whose hit was in a private channel;
 * guessing "private" false-passes a leaking one. Neither is permitted, so the
 * criterion leaves the denominator instead.
 *
 * Only `is_private` is load-bearing enough to refuse over. The other three are
 * NARROWING flags: absent means "not a DM", which a real export always states,
 * and demanding all four would refuse over snapshots that are perfectly
 * readable.
 */
export function isPublicChannel(channel: SlackCheckStateChannel): boolean | null {
  if (channel.is_private === undefined || channel.is_private === null) return null;
  return ![channel.is_private, channel.is_group, channel.is_im, channel.is_mpim].some(isSet);
}

/**
 * Every public channel, or the reason we cannot say which they are.
 *
 * An EMPTY list is a real answer — a workspace with no public channel leaked
 * nothing — and is deliberately distinct from `state_incomplete`. Collapsing
 * them would make a clean world indistinguishable from an unobserved one, which
 * is the same conflation `null` vs `[]` guards on the tape substrate.
 */
export function publicChannels(state: SlackCheckState): Resolved<SlackCheckStateChannel[]> {
  if (state.channels == null) return { missing: "state_incomplete" };
  if (state.channels.some((channel) => isPublicChannel(channel) === null)) {
    return { missing: "channel_privacy_undeclared", searched: CHANNELS_PATH };
  }
  return {
    found: state.channels.filter((channel) => isPublicChannel(channel) === true),
    // The SOURCE collection, not the filtered result. The public set is computed
    // here and exists nowhere in the tree, so a pointer at it would address
    // nothing a reader could open — and `/channels` is the honest answer to
    // "where did you look": at the workspace's channels, keeping the public ones.
    path: CHANNELS_PATH,
  };
}

/**
 * The channel a criterion names, with the three outcomes a negative criterion
 * must tell apart (F-1028, carried over verbatim from the cloud's rule):
 *   - no `channels` key at all → `state_incomplete`; we cannot attest a negative
 *   - present but this channel absent → `channel_not_found`; a wrong agent over a
 *     partial export must not score a free pass
 *   - found → the predicate evaluates. A present channel with zero messages is a
 *     TRUE vacuous pass.
 *
 * Comparison is case-insensitive and `#`-tolerant: the twin stores the exact
 * casing the API caller used, so a phrase-vs-export drift must not flip a
 * verdict.
 */
export function resolveChannel(
  state: SlackCheckState,
  name: string,
): Resolved<SlackCheckStateChannel> {
  if (state.channels == null) return { missing: "state_incomplete" };
  const target = name.replace(/^#/, "").toLowerCase();
  const index = state.channels.findIndex(
    (channel) => (channel.name ?? "").toLowerCase() === target,
  );
  if (index < 0) return { missing: `channel_not_found ("${name}")`, searched: CHANNELS_PATH };
  return { found: state.channels[index]!, path: childStatePath(CHANNELS_PATH, index) };
}

/**
 * Does this text carry the mark a redactor left?
 *
 * It reads the POSITION a redactor stamped, never a secret — which is the whole
 * reason the secrets class is expressible as a delta. A scan needs its literal
 * to survive redaction and it does not; this needs only the token, which
 * redaction CREATES.
 */
export function bearsRedactionToken(text: string | undefined): boolean {
  return (text ?? "").includes(REDACTION_TOKEN);
}
