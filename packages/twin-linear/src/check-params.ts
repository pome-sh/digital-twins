// SPDX-License-Identifier: Apache-2.0
//
// The typed slots Linear's declared checks fill (F-1129).
//
// They live in the twin, not the sdk, for the same reason the declarations do:
// the twin owns what a Linear team key or workflow state name may look like.
// Every pattern is capture-group-free — `defineCheck` throws otherwise, because
// each consumer reads capture group i+1 as slot i and one smuggled group hands
// every predicate its neighbour's argument.
//
// NO SLOT MAY SIT AT THE END OF A TEMPLATE UNBOUNDED. The contract suite
// requires that `"${rendered} and also something else"` does not match, and an
// anchored `[^"\n]+` in terminal position would swallow the suffix. Every
// free-text slot below is delimited by a quote or a backtick in the templates
// that use it — which is also why Linear's state slot is quoted where
// `github.issue-state`'s is bare.

import type { CheckParamType } from "@pome-sh/sdk/checks";

// Double-quote delimited. Linear puts no constraint on an issue title beyond
// non-empty, so the quote is the only exclusion.
export const issueTitle: CheckParamType = {
  name: "title",
  pattern: '[^"\\n]+',
  example: "Orders 500 after deploy",
  render: (value) => value,
  parse: (raw) => raw,
};

// Linear's own team-key constraint, from `seedSchema` (`seed.ts`):
// /^[A-Z][A-Z0-9]*$/.
//
// This is the SCOPE slot twin-github's repo rule requires of every state check,
// and Linear inherits that rule rather than arguing it away as twin-slack did:
// `seed.ts:319-325` validates issue-title uniqueness PER TEAM, so a title-keyed
// selector over a two-team world is exactly the ambiguity the rule closes.
//
// Its shape is also why a reason string may quote it — an uppercase
// alphanumeric run matches no pattern in either redactor.
export const teamKey: CheckParamType = {
  name: "team",
  pattern: "[A-Z][A-Z0-9]*",
  example: "ENG",
  render: (value) => value,
  parse: (raw) => raw,
};

// NOT a closed set, where `github.issue-state`'s is. GitHub has exactly two
// issue states; Linear workflow state names are user-defined per team
// (`seed.ts` `teams[].states[].name` is free text), so a closed alternation
// would silently exclude every custom workflow. The template quotes it, which
// is what keeps a free-text slot safe in terminal position.
export const workflowStateName: CheckParamType = {
  name: "state",
  pattern: '[^"\\n]+',
  example: "In Progress",
  render: (value) => value,
  parse: (raw) => raw,
};

export const labelName: CheckParamType = {
  name: "label",
  pattern: '[^"\\n]+',
  example: "Agent",
  render: (value) => value,
  parse: (raw) => raw,
};

// A bare integer, no leading zeros, so `render(parse(x))` round-trips.
// `VACUITY_SENTINEL_NUMBER` (987654321) satisfies this pattern, which is what
// lets this slot carry a real mutant rather than an admitted null.
export const estimatePoints: CheckParamType = {
  name: "estimate",
  pattern: "0|[1-9][0-9]*",
  example: "2",
  render: (value) => value,
  parse: (raw) => raw,
};

// Backtick-delimited, matching `github.issue-assignee`'s `{login}`. The legacy
// rule matched a user by email, name OR displayName and this keeps all three —
// which is exactly why its check declares this as its `subject`: the team's
// `PII_PATTERNS` eats an email that the twin's own `SCRUB_STEPS` leaves alone,
// so without the declaration the criterion could never fire.
export const userRef: CheckParamType = {
  name: "user",
  pattern: "[^`\\n]+",
  example: "dev@pome-twin.test",
  render: (value) => value,
  parse: (raw) => raw,
};

// The value SCANNED inside free prose rather than compared to a field, which is
// why its check declares it as `subject` — twin-slack's `messageNeedle`
// precedent.
export const commentNeedle: CheckParamType = {
  name: "needle",
  pattern: '[^"\\n]+',
  example: "triage",
  render: (value) => value,
  parse: (raw) => raw,
};
