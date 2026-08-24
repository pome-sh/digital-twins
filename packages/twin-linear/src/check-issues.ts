// SPDX-License-Identifier: Apache-2.0
//
// What Linear's declared checks can assert about an ISSUE ROW.
//
// Migrated from pome-cloud's `services/evaluators/deterministic/linear.ts`,
// where they were hand-written regexes over a cloud-side mirror of the state
// shape. Three things changed in the move, and each is load-bearing:
//
//   1. THE SUBJECT IS A PARAMETER, AND IT IS THE TITLE. The legacy patterns
//      keyed on `identifier` ("ENG-123") or `number`, and NOT ONE of the nine
//      shipped criteria uses either — every one names a title. The registries
//      and the tasks were built for each other and never once met. Title-keyed
//      is what authors actually wrote, and task 26's issue does not exist in the
//      seed at all, so it has no id to key on.
//   2. EVERY CHECK NAMES ITS TEAM. twin-github's repo rule, inherited rather
//      than argued away: `seed.ts:319-325` validates issue-title uniqueness PER
//      TEAM, so a title-keyed selector over a two-team world is exactly the
//      ambiguity that rule closes. twin-slack could argue the absence; Linear
//      cannot.
//   3. A MISSING SUBJECT FAILS. Measured on task 26: with a skip, three
//      unresolved criteria leave the denominator and the surviving github
//      criterion is a negative the seed already satisfies, so a do-nothing agent
//      scores 1/1 = 100%. See `docs/grading/linear-vocabulary.md` §3. The one
//      miss that skips is a TRUNCATED export, which the twin reports itself.
//
// `linear.issue-lifecycle` is NOT migrated. A declared `... is {lifecycle}`
// would near-miss every `is in state "..."` sentence and report a corrupted
// state criterion under the lifecycle check — pointing an author at a check
// they never picked, which is the exact hazard `github.issue-state`'s wording
// comment says its phrasing exists to avoid. It has zero corpus users, and
// `is in state "Done"` / `"Canceled"` re-expresses the cases that matter.
// Recorded as this migration's one narrowing rather than absorbed.

import { defineCheck, VACUITY_SENTINEL, VACUITY_SENTINEL_NUMBER } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";
import {
  estimatePoints,
  issueTitle,
  labelName,
  teamKey,
  userRef,
  workflowStateName,
} from "./check-params.js";
import {
  fieldPath,
  resolveIssue,
  resolveLabelNames,
  resolveUserLabels,
  resolveWorkflowStateName,
  unresolved,
  USERS_PATH,
} from "./check-state.js";
import { finalWorld, issueRow, linearState } from "./check-worlds.js";

export const issueExists: Check<{ title: string; team: string }> = defineCheck({
  id: "linear.issue-exists",
  description:
    "Asserts an unarchived issue with this exact title exists in the named team. Declared and " +
    "unused by the shipped corpus on purpose: `linear.issue-state` FAILS on a missing issue and " +
    "therefore subsumes this one, so a task carries the state criterion alone — twin-github " +
    "ships the same pair for the same reason. A vocabulary is what an author may pick from, not " +
    "what the corpus happens to exercise. Title matching is EXACT and archived issues do not " +
    "count, so an examinee that renames or archives the issue fails this.",
  template: 'An issue titled "{title}" exists in `{team}`',
  params: { title: issueTitle, team: teamKey },
  substrate: "final",
  polarity: () => "positive",
  // The only check where the title IS the assertion rather than the selector,
  // which is why it is the only one that declares the title as its subject.
  subject: ({ title }) => title,
  vacuityMutant: (args) => ({ ...args, title: VACUITY_SENTINEL }),
  discriminatingWorlds: ({ title }) => ({
    // The team is present in both worlds; only the issue moves. `linearState`
    // always fills teams, so the failing world's reason is "no issue with that
    // title in `ENG`" rather than the empty world's "team not found" — which is
    // what arm 3 rejects.
    passing: finalWorld(linearState([issueRow(title)])),
    failing: finalWorld(linearState([issueRow("a different issue entirely")])),
  }),
  evaluate({ title, team }, { final }) {
    const issue = resolveIssue(final, team, title);
    if ("missing" in issue) return unresolved(issue);
    // Echoing the title is safe HERE and only here: this check declares it as
    // its subject, so the engine skipped the criterion as `subject_redacted`
    // before reaching this line if a redactor would have destroyed it.
    // The ROW itself: here the lookup IS the assertion, so the address the
    // resolution walked to is exactly what produced the verdict.
    return {
      passed: true,
      reason: `an issue titled "${title}" exists in \`${team}\``,
      evidenceStatePaths: [issue.path],
    };
  },
});

export const issueState: Check<{ title: string; team: string; state: string }> = defineCheck({
  id: "linear.issue-state",
  description:
    "Resolves the issue by title within the named team, follows `stateId` to that team's " +
    "workflow-state row, and compares its NAME to the one given — case-insensitively, because a " +
    "workflow state name is prose an author retypes. An issue that is absent, archived, or " +
    "ambiguous FAILS, which is what makes this check subsume the existence assertion. A miss " +
    "inside a TRUNCATED export skips instead, because the twin reported that rows were dropped. " +
    "Workflow state names are user-defined per team, so the slot is free text rather than a " +
    "closed set.",
  // "is in state X", not "is X". Two reasons, both of which twin-github's
  // `issue-state` comment states while crediting this very idiom to the Linear
  // tasks: one reading habit spans twins, and the longer literal tail keeps
  // this template from near-missing `... is assigned to \`{user}\``.
  template: 'Issue "{title}" in `{team}` is in state "{state}"',
  params: { title: issueTitle, team: teamKey, state: workflowStateName },
  substrate: "final",
  // Positive on every shipped use. Unlike `github.issue-state` there is no
  // canonical "open" member to read a prohibition off, because the state names
  // belong to the workspace rather than to the API.
  polarity: () => "positive",
  // The state name is the value COMPARED against the state; title and team only
  // select.
  subject: ({ state }) => state,
  vacuityMutant: (args) => ({ ...args, state: VACUITY_SENTINEL }),
  discriminatingWorlds: ({ title, state }) => ({
    passing: finalWorld(linearState([issueRow(title, { stateName: state })])),
    // The team and the issue are PRESENT in both worlds; only the state moves.
    failing: finalWorld(linearState([issueRow(title, { stateName: "Backlog" })])),
  }),
  evaluate({ title, team, state }, { final }) {
    const issue = resolveIssue(final, team, title);
    if ("missing" in issue) return unresolved(issue);
    const name = resolveWorkflowStateName(final, issue.found);
    if ("missing" in name) return unresolved(name);
    return {
      passed: name.found.toLowerCase() === state.toLowerCase(),
      reason: `issue state is "${name.found}" (wanted "${state}")`,
      // BOTH ends of trap 1's join. An issue has no state string — it has a
      // `stateId` into the team's own workflow catalog — so a reader handed only
      // the issue row would find an opaque id, and one handed only the catalog
      // row would not know which issue pointed at it.
      evidenceStatePaths: [fieldPath(issue.path, issue.found, "stateId"), name.path],
    };
  },
});

export const issueHasLabel: Check<{ title: string; team: string; label: string }> = defineCheck({
  id: "linear.issue-has-label",
  description:
    "Resolves the issue, joins its `labelIds` to the workspace label catalog, and asserts the " +
    "named label is among them — case-insensitively, as the legacy rule's comparison was. The " +
    "join is the point: this export carries label IDS where the seed writes names and " +
    "twin-github writes objects, so one concept has three shapes and only this one is exported. " +
    "A label id with no catalog row is a partial export and SKIPS rather than failing.",
  template: 'Issue "{title}" in `{team}` has label "{label}"',
  params: { title: issueTitle, team: teamKey, label: labelName },
  substrate: "final",
  polarity: () => "positive",
  subject: ({ label }) => label,
  vacuityMutant: (args) => ({ ...args, label: VACUITY_SENTINEL }),
  discriminatingWorlds: ({ title, label }) => ({
    passing: finalWorld(linearState([issueRow(title, { labelNames: [label] })], [], [label])),
    // The issue is present and resolvable in both; only its labels move.
    failing: finalWorld(linearState([issueRow(title, { labelNames: [] })], [], [label])),
  }),
  evaluate({ title, team, label }, { final }) {
    const issue = resolveIssue(final, team, title);
    if ("missing" in issue) return unresolved(issue);
    const names = resolveLabelNames(final, issue.found);
    if ("missing" in names) return unresolved(names);
    return {
      passed: names.found.has(label.toLowerCase()),
      reason: `issue carries ${names.found.size} label(s) (wanted "${label}")`,
      // Trap 2's join, both ends: `labelIds` on the row, names in the catalog.
      evidenceStatePaths: [fieldPath(issue.path, issue.found, "labelIds"), names.path],
    };
  },
});

export const issueEstimate: Check<{ title: string; team: string; estimate: string }> = defineCheck({
  id: "linear.issue-estimate",
  description:
    "Resolves the issue and compares its `estimate` column to the number given. An UNSET " +
    "estimate is a real FAIL, not a skip: an unestimated issue is exactly the state this " +
    "assertion exists to rule out.",
  template: 'Issue "{title}" in `{team}` has estimate {estimate}',
  params: { title: issueTitle, team: teamKey, estimate: estimatePoints },
  substrate: "final",
  polarity: () => "positive",
  // The single null in the subject column, and for twin-slack's emoji-name
  // reason rather than an exemption: a bare integer of at most three digits
  // matches no pattern in `redactSecrets` (key prefixes, 13-19-digit runs) or
  // in a team's `PII_PATTERNS` (emails, phones). A value no redactor can eat is
  // not a subject, and declaring one would only narrow the corpus gate's
  // whole-phrase fallback for nothing.
  subject: () => null,
  // D10's second allowlist entry ever, and the argument is stripe's unchanged:
  // here the number IS the scanned value, and the title is the selector.
  vacuityMutant: (args) => ({ ...args, estimate: String(VACUITY_SENTINEL_NUMBER) }),
  discriminatingWorlds: ({ title, estimate }) => ({
    passing: finalWorld(linearState([issueRow(title, { estimate: Number(estimate) })])),
    failing: finalWorld(linearState([issueRow(title, { estimate: null })])),
  }),
  evaluate({ title, team, estimate }, { final }) {
    const issue = resolveIssue(final, team, title);
    if ("missing" in issue) return unresolved(issue);
    const actual = issue.found.estimate ?? null;
    return {
      passed: actual === Number(estimate),
      reason: `issue estimate is ${actual === null ? "unset" : actual} (wanted ${estimate})`,
      // `fieldPath`, not a bare `…/estimate`: an UNSET estimate is the verdict
      // this check exists to deliver, and on an export that omits the column
      // entirely a pointer at it would resolve to nothing — stripping the
      // affordance from exactly the row a reader wants to open.
      evidenceStatePaths: [fieldPath(issue.path, issue.found, "estimate")],
    };
  },
});

export const issueAssignee: Check<{ title: string; team: string; user: string }> = defineCheck({
  id: "linear.issue-assignee",
  description:
    "Resolves the issue, then its assignee, and matches the given reference against that user's " +
    "email, name OR displayName — every spelling the legacy rule accepted. An UNASSIGNED issue " +
    "is a real FAIL. Declared with no shipped corpus user, carrying a legacy capability forward. " +
    "This is the check whose `subject` earns its keep: an email reference is destroyed by a " +
    "team's `PII_PATTERNS`, which the twin's own redactor has no equivalent of, so without the " +
    "declaration the criterion would silently be unable to fire.",
  template: 'Issue "{title}" in `{team}` is assigned to `{user}`',
  params: { title: issueTitle, team: teamKey, user: userRef },
  substrate: "final",
  polarity: () => "positive",
  subject: ({ user }) => user,
  vacuityMutant: (args) => ({ ...args, user: VACUITY_SENTINEL }),
  discriminatingWorlds: ({ title }) => ({
    // The issue resolves in both worlds; only the assignee moves.
    passing: finalWorld(linearState([issueRow(title, { assigneeId: "user_dev" })])),
    failing: finalWorld(linearState([issueRow(title)])),
  }),
  evaluate({ title, team, user }, { final }) {
    const issue = resolveIssue(final, team, title);
    if ("missing" in issue) return unresolved(issue);
    const labels = resolveUserLabels(final, issue.found.assigneeId);
    // The issue row on both arms. An unassigned issue has no user row to point
    // at, so citing `/users` only when one resolved would make the citation's
    // PRESENCE track the verdict — and its absence would start reading as
    // "unassigned", which is a verdict class the pointer must not encode.
    const assignment = [fieldPath(issue.path, issue.found, "assigneeId")];
    if (labels.length === 0) {
      return { passed: false, reason: "issue has no assignee", evidenceStatePaths: assignment };
    }
    if (final.users != null) assignment.push(USERS_PATH);
    return {
      passed: labels.some((l) => l.toLowerCase() === user.toLowerCase()),
      // Safe to quote: `user` is this check's declared subject.
      reason: `issue is assigned to \`${labels[0]}\` (wanted \`${user}\`)`,
      evidenceStatePaths: assignment,
    };
  },
});
