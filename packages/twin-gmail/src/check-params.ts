// SPDX-License-Identifier: Apache-2.0
//
// The typed slots Gmail's declared checks fill (F-1128).
//
// They live in the twin, not the sdk, for the same reason the declarations do:
// the twin owns what a Gmail message id or label name may look like. Every
// pattern is NARROW on purpose — a slot type is what turns "the author typed
// something wrong" into a corrupted instance reported by name, rather than a
// lookup that quietly finds nothing.
//
// All patterns are capture-group-free; `defineCheck` throws otherwise, because
// every consumer reads capture group i+1 as slot i and one smuggled group hands
// each predicate its neighbour's argument.

import type { CheckParamType } from "@pome-sh/sdk/checks";

// Ids the twin mints (`nextId` → `msg_1`, `Label_3`, `draft_2`) and the ids a
// seed may pin (`msg_support`, `msg_parity`). No spaces and no dots, which is
// what separates this slot from `labelName` below.
export const messageId: CheckParamType = {
  name: "message",
  pattern: "[A-Za-z0-9_-]{1,128}",
  example: "msg_support",
  render: (value) => value,
  parse: (raw) => raw,
};

// A label REFERENCE: either the minted id (`Label_follow_up`) or a system label,
// whose id and display name are the same string (`INBOX`, `SENT`, `STARRED`).
// Deliberately excludes spaces — a label whose NAME has spaces is addressed by
// `labelName`, and keeping the two slots distinct is what stops
// `gmail.message-has-label` and `gmail.label-exists` claiming one sentence.
export const labelRef: CheckParamType = {
  name: "label",
  pattern: "[A-Za-z0-9_-]{1,128}",
  example: "STARRED",
  render: (value) => value,
  parse: (raw) => raw,
};

// A label's DISPLAY NAME, which Gmail permits spaces in (`Parity Complete`,
// `Follow Up`). Anchored to start on a word character so the template's
// surrounding literals cannot be eaten by a leading space.
export const labelName: CheckParamType = {
  name: "label",
  pattern: "[A-Za-z0-9][A-Za-z0-9 _-]{0,127}",
  example: "Parity Complete",
  render: (value) => value,
  parse: (raw) => raw,
};

// An addressee. Quote and backtick are excluded as well as whitespace so the
// slot cannot swallow a template's own delimiters.
export const emailAddress: CheckParamType = {
  name: "email",
  pattern: "[^\\s@\"'`]+@[^\\s@\"'`]+",
  example: "alice@example.com",
  render: (value) => value,
  parse: (raw) => raw,
};

// The same shape, named for the slot it fills — a mailbox is addressed by its
// email in every collection the export emits.
export const mailboxRef: CheckParamType = {
  name: "mailbox",
  pattern: "[^\\s@\"'`]+@[^\\s@\"'`]+",
  example: "pome-agent@pome-twin.test",
  render: (value) => value,
  parse: (raw) => raw,
};

// A bare digit count. Nine digits wide so `VACUITY_SENTINEL_NUMBER` re-binds:
// a mutant that stops matching evaluates to `unmatched`, which reads as "the
// verdict moved -> healthy" and blesses the very criterion the probe exists to
// catch.
export const exactCount: CheckParamType = {
  name: "count",
  pattern: "\\d{1,9}",
  example: "5",
  render: (value) => value,
  parse: (raw) => raw,
};

// Digits OR the English number words, because the corpus says both — `exactly 5
// messages` and `each of the five recipients`. Non-capturing, so the alternation
// costs no capture group.
export const countWord: CheckParamType = {
  name: "count",
  pattern:
    "(?:\\d{1,9}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)",
  example: "two",
  render: (value) => value,
  parse: (raw) => raw,
};

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** A `countWord` slot's value as a number, or null when it is neither. */
export function parseCount(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return NUMBER_WORDS[trimmed] ?? null;
}
