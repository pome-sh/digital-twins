// SPDX-License-Identifier: Apache-2.0
//
// What GitHub's declared checks can assert about an ISSUE (F-1075).
//
// Declarations only. The grammar rules they all obey are in `checks.ts`, which
// assembles them; how the exported tree is read is in `check-state.ts`.

import { defineCheck, VACUITY_SENTINEL, VACUITY_SENTINEL_NUMBER } from "@pome-sh/sdk/checks";
import { repoRef } from "@pome-sh/sdk/checks";
import {
  commentNeedle,
  issueNumber,
  issueState,
  labelName,
  login,
} from "./check-params.js";
import { appliedLabelNames, resolveIssue, sameLabel } from "./check-state.js";
import type { Check } from "./check-kind.js";

export const issueExists: Check<{ issue: string; repo: string }> = defineCheck({
  id: "github.issue-exists",
  description:
    "Asserts an issue with this number is present in the repository's final state. It says " +
    "NOTHING about the issue's content, state, labels or assignee — pair it with those " +
    "checks when they matter. Its natural use is a task whose examinee must CREATE the " +
    "issue; asserting the existence of a seeded issue is trivially true and grades nothing.",
  template: "Issue #{issue} exists in `{repo}`",
  params: { issue: issueNumber, repo: repoRef },
  substrate: "final",
  polarity: () => "positive",
  // A number, not a string hunted for inside free text — no redactor can
  // delete it out from under the lookup.
  subject: () => null,
  // The ONE check where the issue number is the SCANNED literal rather than a
  // selector. Everywhere else `resolveIssue` early-returns "not found" before
  // the real comparison runs, so falsifying the number would move the verdict
  // for a reason that never reaches the assertion. Here the lookup IS the
  // assertion, so falsifying it is exactly right.
  vacuityMutant: (args) => ({ ...args, issue: String(VACUITY_SENTINEL_NUMBER) }),
  evaluate({ issue, repo }, { final }) {
    const found = resolveIssue(final, repo, issue);
    if ("missing" in found) return { passed: false, reason: found.missing };
    return { passed: true, reason: `issue #${issue} exists in ${repo}` };
  },
});

export const issueStateCheck: Check<{ issue: string; repo: string; state: string }> = defineCheck({
  id: "github.issue-state",
  description:
    "Compares the issue row's `state` column against the named state. A missing issue FAILS; " +
    "an issue whose export carries no state at all is SKIPPED rather than judged, because " +
    "absent is not the same as open. The `open` form is a prohibition — it asks the examinee " +
    "NOT to close the issue — which is why polarity is read from the state word.",
  // "is in state X", not "is X", for two reasons. It borrows the idiom the
  // Linear tasks already use (`Issue "…" is in state In Progress`), so one
  // reading habit spans twins. And it keeps this template's literal tail from
  // swallowing `… is assigned to \`{login}\``: near-miss patterns open every
  // slot to `.+?`, so `Issue #{issue} in \`{repo}\` is {state}` would resemble
  // the assignee sentence, and a corrupted assignee would be reported as a
  // corrupted STATE check — pointing an author at a check they never picked.
  // The contract test asserts this directly; it is the reason this wording is
  // not "is {state}".
  //
  // `github.pr-state` keeps the shorter "is {state}" deliberately: half its set
  // (`merged`/`not merged`) is a different column from `state`, so "is in
  // state merged" would name the wrong field.
  template: "Issue #{issue} in `{repo}` is in state {state}",
  params: { issue: issueNumber, repo: repoRef, state: issueState },
  substrate: "final",
  // Per-arg. "is closed" asks the examinee to close it; "is open" is F-915's
  // "the agent did not close issue #1" — a prohibition wearing a state word.
  polarity: ({ state }) => (state === "open" ? "negative" : "positive"),
  subject: () => null,
  // No falsifiable trigger. The state word comes from a CLOSED SET, so there is
  // no value guaranteed to be false — every member might legitimately be true
  // of the state. The issue number only resolves: mutating it early-returns
  // "not found", which moves the verdict on every seed for a reason unrelated
  // to the trigger clause. A mutant guaranteed to move is a check that measures
  // nothing, so this admits the blind spot as `no_trigger` instead of buying a
  // false clean bill.
  vacuityMutant: () => null,
  evaluate({ issue, repo, state }, { final }) {
    const found = resolveIssue(final, repo, issue);
    if ("missing" in found) return { passed: false, reason: found.missing };
    // The issue row must carry a state to attest it; a snapshot that omitted it
    // cannot be judged either way → safe-skip rather than false-fail.
    if (found.found.state == null) {
      return {
        passed: false,
        status: "skipped",
        reason: `issue #${issue} has no state in state_final (state_incomplete)`,
      };
    }
    const actual = found.found.state.toLowerCase();
    return {
      passed: actual === state,
      reason: `issue #${issue} state is "${found.found.state}" (wanted "${state}")`,
    };
  },
});

export const issueHasLabel: Check<{ issue: string; repo: string; label: string }> = defineCheck({
  id: "github.issue-has-label",
  description:
    "Asserts the label is among those APPLIED to the issue — it does not assert the issue " +
    "carries only that one. An agent that applies the right label alongside three wrong ones " +
    "passes this check; `github.issue-exactly-one-label` is the assertion that catches that. " +
    "The comparison is case-insensitive, because GitHub creates label names case-insensitively " +
    "while preserving the caller's display casing.",
  template: "Issue #{issue} in `{repo}` has the `{label}` label applied",
  params: { issue: issueNumber, repo: repoRef, label: labelName },
  substrate: "final",
  polarity: () => "positive",
  // The label is a caller-supplied literal compared against the state tree, so
  // a redactor that destroys it makes this check unable to fire (F-1028).
  subject: ({ label }) => label,
  // The label is what the scan ranges over; the issue number only resolves.
  vacuityMutant: (args) => ({ ...args, label: VACUITY_SENTINEL }),
  evaluate({ issue, repo, label }, { final }) {
    const found = resolveIssue(final, repo, issue);
    if ("missing" in found) return { passed: false, reason: found.missing };
    const applied = appliedLabelNames(found.found);
    const passed = applied.some((name) => sameLabel(name, label));
    return {
      passed,
      reason: passed
        ? `issue #${issue} has label "${label}"`
        : `issue #${issue} labels are [${applied.join(", ")}], missing "${label}"`,
    };
  },
});

export const issueExactlyOneLabel: Check<{ issue: string; repo: string; label: string }> = defineCheck({
  id: "github.issue-exactly-one-label",
  description:
    "Asserts the issue carries EXACTLY ONE applied label and that it is this one. Strictly " +
    "stronger than `github.issue-has-label`: it fails an agent that piles a correct label on " +
    "top of an incorrect one, which is the defect a triage task usually exists to catch. It " +
    "counts every applied label, not only ones a human would call a classification.",
  template: "Issue #{issue} in `{repo}` has exactly one classification label, and it is `{label}`",
  params: { issue: issueNumber, repo: repoRef, label: labelName },
  substrate: "final",
  polarity: () => "positive",
  subject: ({ label }) => label,
  vacuityMutant: (args) => ({ ...args, label: VACUITY_SENTINEL }),
  evaluate({ issue, repo, label }, { final }) {
    const found = resolveIssue(final, repo, issue);
    if ("missing" in found) return { passed: false, reason: found.missing };
    const applied = appliedLabelNames(found.found);
    const passed = applied.length === 1 && sameLabel(applied[0]!, label);
    return {
      passed,
      reason: passed
        ? `issue #${issue} has exactly one label ("${label}")`
        : `issue #${issue} has labels [${applied.join(", ")}], expected exactly one label "${label}"`,
    };
  },
});

export const issueAssignee: Check<{ issue: string; repo: string; login: string }> = defineCheck({
  id: "github.issue-assignee",
  description:
    "Asserts this login is among the issue's assignees. GitHub issues can carry several, so " +
    "this does not assert sole ownership. It compares LOGINS exactly and case-sensitively, " +
    "not display names — `alice` matches the collaborator `alice`, and `Alice Smith` matches " +
    "nothing.",
  template: "Issue #{issue} in `{repo}` is assigned to `{login}`",
  params: { issue: issueNumber, repo: repoRef, login },
  substrate: "final",
  polarity: () => "positive",
  subject: (args) => args.login,
  vacuityMutant: (args) => ({ ...args, login: VACUITY_SENTINEL }),
  evaluate(args, { final }) {
    const found = resolveIssue(final, args.repo, args.issue);
    if ("missing" in found) return { passed: false, reason: found.missing };
    const assignees = found.found.assignees ?? [];
    const passed = assignees.includes(args.login);
    return {
      passed,
      reason: passed
        ? `issue #${args.issue} is assigned to "${args.login}"`
        : `issue #${args.issue} assignees are [${assignees.join(", ")}], missing "${args.login}"`,
    };
  },
});

export const issueCommentContains: Check<{ needle: string; issue: string; repo: string }> = defineCheck({
  id: "github.issue-comment-contains",
  description:
    "Scans the bodies of every comment on the issue for this text as a SUBSTRING, " +
    "case-sensitively. It does not assert who commented, how many did, or where in the body " +
    "the text sits. Because the text is hunted inside free prose rather than compared to a " +
    "field, a redaction rule that destroys it makes this check unable to fire — the engine " +
    "skips it as `subject_redacted` rather than passing it vacuously.",
  template: 'A comment containing "{needle}" exists on issue #{issue} in `{repo}`',
  params: { needle: commentNeedle, issue: issueNumber, repo: repoRef },
  substrate: "final",
  polarity: () => "positive",
  subject: ({ needle }) => needle,
  // The issue RESOLVES, the needle is SCANNED within it. Falsifying the issue
  // number instead would early-return "not found" and move the verdict for
  // every seed, for a reason that never reaches the comment scan.
  vacuityMutant: (args) => ({ ...args, needle: VACUITY_SENTINEL }),
  evaluate({ needle, issue, repo }, { final }) {
    const found = resolveIssue(final, repo, issue);
    if ("missing" in found) return { passed: false, reason: found.missing };
    const comments = found.found.comments ?? [];
    const passed = comments.some((comment) => (comment.body ?? "").includes(needle));
    return {
      passed,
      reason: passed
        ? `issue #${issue} has a comment containing "${needle}"`
        : `issue #${issue} has no comment containing "${needle}" (${comments.length} comment(s) scanned)`,
    };
  },
});
