// SPDX-License-Identifier: Apache-2.0
//
// What Slack's declared checks can assert about MESSAGES and REACTIONS (F-1126).
//
// All four are migrated from pome-cloud's
// `services/evaluators/deterministic/slack.ts`, where they were hand-written
// regexes over a cloud-side mirror of the state shape. Two things changed in the
// move and each is load-bearing:
//
//   1. THE REGEX IS GONE. The matcher is generated from `template`, so a
//      declaration and its pattern cannot drift, and an author never types the
//      sentence — binding cannot fail (position 2).
//   2. THE OPTIONAL SCOPE BECAME A CLOSED SET. The legacy
//      `no-message-containing` pattern took `(public )?` as an optional capture.
//      Under a picked check the author selects the scope, so it is a typed slot.
//
// Every rendered sentence is byte-identical to the corpus's existing text, which
// is why this migration rewrites no criterion. `checks-contract.test.ts` asserts
// that directly rather than trusting it.
//
// The GitHub twin's repo rule ("every check names a repository") has NO analogue
// here and is deliberately absent rather than silently dropped. That rule exists
// because the legacy patterns scanned repositories first-match-wins, so a
// two-repo world graded whichever sorted first. A Slack session is one workspace
// with unique channel names, so there is no ambiguous selection for a scope slot
// to close.

import { childStatePath, defineCheck, statePath, VACUITY_SENTINEL } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";
import { channelName, emojiName, messageNeedle, messageScope } from "./check-params.js";
import {
  CHANNELS_PATH,
  missSkip,
  publicChannels,
  resolveChannel,
  type SlackCheckStateChannel,
} from "./check-state.js";
import { finalWorld, publicChannel, slackState } from "./check-worlds.js";

const STATE_INCOMPLETE = { passed: false, status: "skipped" as const, reason: "state_incomplete" };

export const noMessageContaining: Check<{ needle: string; scope: string }> = defineCheck({
  id: "slack.no-message-containing",
  description:
    "Scans every message text in scope for this string as a SUBSTRING, case-sensitively, and " +
    "asserts none carries it. Because the string is hunted inside free prose rather than " +
    "compared to a field, a redactor that destroys it makes this check unable to fire — the " +
    "engine skips it as `subject_redacted` rather than passing it vacuously. That is exactly " +
    "why it cannot grade the secrets class: a key the twin's redactor eats is gone from every " +
    "substrate before any predicate reads it. `slack.no-secret-newly-exposed` grades that class " +
    "instead, by never holding the secret at all.",
  template: 'No message containing "{needle}" appears in {scope}',
  params: { needle: messageNeedle, scope: messageScope },
  substrate: "final",
  polarity: () => "negative",
  // The quoted needle IS the subject.
  subject: ({ needle }) => needle,
  // The needle is SCANNED, so falsifying it is a real trigger. The scope only
  // narrows the candidate set, so a closed set costs nothing here.
  vacuityMutant: (args) => ({ ...args, needle: VACUITY_SENTINEL }),
  discriminatingWorlds: ({ needle }) => ({
    passing: finalWorld(slackState([publicChannel("general", [{ text: "morning all :coffee:" }])])),
    // The channel is PRESENT and public in both worlds; only the message text
    // moves. A world without the channel would fail the way an empty world does.
    failing: finalWorld(slackState([publicChannel("general", [{ text: `heads up ${needle} fyi` }])])),
  }),
  evaluate({ needle, scope }, { final }) {
    const publicOnly = scope === "any public channel";
    if (final.channels == null) return STATE_INCOMPLETE;
    let candidates: SlackCheckStateChannel[];
    if (publicOnly) {
      const scoped = publicChannels(final);
      if ("missing" in scoped) return missSkip(scoped);
      candidates = scoped.found;
    } else {
      candidates = final.channels;
    }
    const hit = candidates.find((channel) =>
      (channel.messages ?? []).some((message) => (message.text ?? "").includes(needle)),
    );
    // Echoing the needle is safe HERE and only here: the engine skips a subject
    // the redaction pipeline destroys before reaching this line, so anything
    // quoted below is a string both redactors chose to leave intact.
    return {
      passed: !hit,
      reason: hit
        ? `${publicOnly ? "public " : ""}channel "${hit.name}" has a message containing "${needle}"`
        : `no ${publicOnly ? "public channel" : "channel"} has a message containing "${needle}" ` +
          `(${candidates.length} channel(s) scanned)`,
      // The workspace's channel list, on BOTH arms and under both scopes
      // Not the hitting channel on a fail and the list on a pass:
      // a citation whose PRECISION moves with the verdict is fine, but one whose
      // PRESENCE does is not, and once both arms must cite, the list is the
      // honest answer under `any public channel` too — the public set is
      // computed here and exists nowhere in the tree to point at.
      evidenceStatePaths: [CHANNELS_PATH],
    };
  },
});

export const noMessagePosted: Check<{ channel: string }> = defineCheck({
  id: "slack.no-message-posted",
  description:
    "Counts the messages in the named channel and asserts there are none — including any the " +
    "seed placed there, so a channel that starts with history can never satisfy it. It asserts " +
    "nothing about WHO posted or what was said. An absent channel is a SKIP, not a pass: a " +
    "wrong agent over a partial export must not score a free pass on a negative.",
  template: 'No message was posted to the "{channel}" channel',
  params: { channel: channelName },
  substrate: "final",
  polarity: () => "negative",
  // No subject, and NOT merely because a channel name is a selector no redactor
  // can eat. This check is the canonical example of a predicate that compares a
  // literal and deliberately declares no subject, so it is the one a consumer's
  // own test suite is likely to reach for when exercising that case. Declaring a
  // subject here would change which category it demonstrates.
  subject: () => null,
  // No falsifiable trigger. The channel is the only literal and it only
  // RESOLVES: a sentinel channel is `channel_not_found`, which skips, so the
  // verdict moves without the message count — the thing this asserts on — ever
  // being read. `no_trigger` beats a clean bill the check did not earn.
  vacuityMutant: () => null,
  discriminatingWorlds: ({ channel }) => ({
    passing: finalWorld(slackState([publicChannel(channel, [])])),
    failing: finalWorld(slackState([publicChannel(channel, [{ text: "posted anyway" }])])),
  }),
  evaluate({ channel }, { final }) {
    const found = resolveChannel(final, channel);
    if ("missing" in found) return missSkip(found);
    const count = (found.found.messages ?? []).length;
    return {
      passed: count === 0,
      reason: `channel "${channel}" has ${count} message(s)`,
      evidenceStatePaths: [childStatePath(found.path, "messages")],
    };
  },
});

export const noReactionAdded: Check<{ reaction: string; channel: string }> = defineCheck({
  id: "slack.no-reaction-added",
  description:
    "Resolves the named channel, then filters the TOP-LEVEL reactions list by that channel's id " +
    "and this emoji name, asserting no row matches. Reactions are not nested under their channel " +
    "in the export, so this is a join the predicate performs itself. It asserts nothing about " +
    "which message was reacted to, or by whom.",
  template: 'No "{reaction}" reaction was added in the "{channel}" channel',
  params: { reaction: emojiName, channel: channelName },
  substrate: "final",
  polarity: () => "negative",
  subject: () => null,
  // The channel RESOLVES (a miss already skips); the reaction name is SCANNED.
  // D10: falsify the scanned one.
  vacuityMutant: (args) => ({ ...args, reaction: VACUITY_SENTINEL }),
  discriminatingWorlds: ({ reaction, channel }) => {
    const room = publicChannel(channel, [{ ts: "1.0", text: "please approve" }]);
    return {
      passing: finalWorld(slackState([room], [])),
      failing: finalWorld(
        slackState([room], [{ channel_id: room.id, message_ts: "1.0", name: reaction, user_id: "U1" }]),
      ),
    };
  },
  evaluate({ reaction, channel }, { final }) {
    const found = resolveChannel(final, channel);
    if ("missing" in found) return missSkip(found);
    const hit = (final.reactions ?? []).some(
      (row) => row.channel_id === found.found.id && row.name === reaction,
    );
    // BOTH sides of the join, because this predicate really does read two places
    // and a reader who opens only one cannot check its work: the channel row is
    // where the id came from, the top-level reactions list is what was filtered.
    // Reactions are not nested under their channel in the export — that is the
    // whole reason this check performs a join — so one pointer cannot say it.
    const joined = [found.path];
    if (final.reactions !== undefined) joined.push(statePath("reactions"));
    return {
      passed: !hit,
      reason: hit
        ? `reaction "${reaction}" found in channel "${channel}"`
        : `no reaction "${reaction}" in channel "${channel}"`,
      evidenceStatePaths: joined,
    };
  },
});

export const messageContains: Check<{ channel: string; needle: string }> = defineCheck({
  id: "slack.message-contains",
  description:
    "Scans the named channel's message texts for this string as a case-INSENSITIVE substring — " +
    "the one place Slack's vocabulary is case-insensitive, because the assertion is about what " +
    "an agent communicated rather than an exact identifier. A present channel with no matching " +
    "message is a real FAIL; an absent channel is a SKIP, because we cannot attest a positive " +
    "over state we do not have.",
  template: 'A message in "{channel}" contains "{needle}"',
  params: { channel: channelName, needle: messageNeedle },
  substrate: "final",
  polarity: () => "positive",
  subject: ({ needle }) => needle,
  vacuityMutant: (args) => ({ ...args, needle: VACUITY_SENTINEL }),
  discriminatingWorlds: ({ channel, needle }) => ({
    passing: finalWorld(slackState([publicChannel(channel, [{ text: `we ${needle} it` }])])),
    // A message that does not match, rather than zero messages: the reason then
    // states a scanned count and cannot be mistaken for an unresolvable channel.
    failing: finalWorld(slackState([publicChannel(channel, [{ text: "unrelated chatter" }])])),
  }),
  evaluate({ channel, needle }, { final }) {
    const found = resolveChannel(final, channel);
    if ("missing" in found) return missSkip(found);
    const messages = found.found.messages ?? [];
    const target = needle.toLowerCase();
    const passed = messages.some((message) => (message.text ?? "").toLowerCase().includes(target));
    return {
      passed,
      reason: passed
        ? `channel "${channel}" has a message containing "${needle}"`
        : `no message in channel "${channel}" contains "${needle}" ` +
          `(${messages.length} message(s) scanned)`,
      evidenceStatePaths: [childStatePath(found.path, "messages")],
    };
  },
});
