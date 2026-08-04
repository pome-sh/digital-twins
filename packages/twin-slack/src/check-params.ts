// SPDX-License-Identifier: Apache-2.0
//
// The typed slots Slack's declared checks fill (F-1126).
//
// They live in the twin, not the sdk, for the same reason the declarations do:
// the twin owns what a Slack channel name or emoji name may look like. Every
// pattern is NARROW on purpose — a slot type is what turns "the author typed
// something wrong" into a corrupted instance reported by name, rather than a
// lookup that quietly finds nothing.
//
// All patterns are capture-group-free; `defineCheck` throws otherwise, because
// every consumer reads capture group i+1 as slot i and one smuggled group hands
// each predicate its neighbour's argument.

import { oneOf, type CheckParamType } from "@pome-sh/sdk/checks";

// Slack's own constraint, from `seedSchema` (`seed.ts:8`): lowercase
// alphanumerics, underscore and hyphen, up to 80. Templates quote it, and the
// resolver strips a leading `#`, so the slot itself carries neither.
export const channelName: CheckParamType = {
  name: "channel",
  pattern: "[a-z0-9_-]{1,80}",
  example: "general",
  render: (value) => value,
  parse: (raw) => raw,
};

// Double-quote delimited in its template, so the quote is the only exclusion.
// This is the slot whose value is SCANNED inside free prose rather than compared
// to a field, which is why its checks declare it as their `subject`.
export const messageNeedle: CheckParamType = {
  name: "needle",
  pattern: '[^"\\n]+',
  example: "shipped",
  render: (value) => value,
  parse: (raw) => raw,
};

// A Slack emoji name, from `seedSchema`'s own regex. Compared to the reaction
// row's `name` column exactly — no colons: the legacy regex tolerated `:x:`
// because an author typed English, and under position 2 nothing is typed.
export const emojiName: CheckParamType = {
  name: "reaction",
  pattern: "[a-z0-9_+-]{1,100}",
  example: "white_check_mark",
  render: (value) => value,
  parse: (raw) => raw,
};

// The legacy rule's OPTIONAL `(public )?` capture, as a closed set.
//
// One check rather than two, because the two sentences differ only in scope and
// splitting them would put two claimants on one predicate — which is what the D6
// collision arm exists to forbid. `oneOf` is non-capturing, so the slot costs no
// capture group.
//
// It costs the vacuity mutant nothing either: the falsifiable slot on that check
// is `needle`, not this. A closed set only kills a mutant when it is the ONLY
// scanned slot.
export const messageScope = oneOf(
  "scope",
  ["any channel", "any public channel"],
  "any public channel",
);
