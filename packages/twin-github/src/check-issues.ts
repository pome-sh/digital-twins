// SPDX-License-Identifier: Apache-2.0
//
// What GitHub's declared checks can assert about an ISSUE (F-1075).
//
// Declarations only. The grammar rules they all obey are in `checks.ts`, which
// assembles them; how the exported tree is read is in `check-state.ts`.

import { childStatePath, defineCheck, VACUITY_SENTINEL, VACUITY_SENTINEL_NUMBER } from "@pome-sh/sdk/checks";
import { repoRef } from "@pome-sh/sdk/checks";
import {
  commentNeedle,
  issueNumber,
  issueState,
  labelName,
  login,
} from "./check-params.js";
import { appliedLabelNames, missOutcome, resolveIssue, sameLabel } from "./check-state.js";
import { finalWorld, repoState } from "./check-worlds.js";
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
  // The repo is PRESENT in both worlds; only the issue moves. A world without
  // the repo would fail the way an EMPTY world does, which arm 3 rejects.
  discriminatingWorlds: ({ issue }) => ({
    passing: finalWorld(repoState({ issues: [{ number: Number(issue) }] })),
    failing: finalWorld(repoState({ issues: [{ number: Number(issue) + 1 }] })),
  }),
  evaluate({ issue, repo }, { final }) {
    const found = resolveIssue(final, repo, issue);
    if ("missing" in found) return missOutcome(found);
    // The ISSUE itself, not a field on it — here the lookup is the assertion, so
    // the row's own address is exactly what produced the verdict (F-1197).
    return {
      passed: true,
      reason: `issue #${issue} exists in ${repo}`,
      evidenceStatePaths: [found.path],
    };
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
  // Per-arg. "is closed" asks the examinee to close it; "is open" is the twin's
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
  // The closed set costs the vacuity mutant but not this: a world can simply
  // hold the other member.
  discriminatingWorlds: ({ issue, state }) => ({
    passing: finalWorld(repoState({ issues: [{ number: Number(issue), state }] })),
    failing: finalWorld(
      repoState({ issues: [{ number: Number(issue), state: state === "closed" ? "open" : "closed" }] }),
    ),
  }),
  evaluate({ issue, repo, state }, { final }) {
    const found = resolveIssue(final, repo, issue);
    if ("missing" in found) return missOutcome(found);
    // The issue row must carry a state to attest it; a snapshot that omitted it
    // cannot be judged either way → safe-skip rather than false-fail.
    if (found.found.state == null) {
      return {
        passed: false,
        status: "skipped",
        reason: `issue #${issue} has no state in state_final (state_incomplete)`,
        // The ROW, not `…/state` — the field this branch exists for is the one
        // that is absent, and a pointer at it would not resolve. Pointing at the
        // row is what lets a reader see the gap for themselves instead of taking
        // the reason's word for it.
        evidenceStatePaths: [found.path],
      };
    }
    const actual = found.found.state.toLowerCase();
    return {
      passed: actual === state,
      reason: `issue #${issue} state is "${found.found.state}" (wanted "${state}")`,
      evidenceStatePaths: [childStatePath(found.path, "state")],
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
  // a redactor that destroys it makes this check unable to fire.
  subject: ({ label }) => label,
  // The label is what the scan ranges over; the issue number only resolves.
  vacuityMutant: (args) => ({ ...args, label: VACUITY_SENTINEL }),
  // `labels` are ROW OBJECTS, not strings. The failing world carries a DIFFERENT
  // label rather than none, so its reason names a non-empty applied set and
  // cannot be mistaken for a missing issue.
  discriminatingWorlds: ({ issue, label }) => ({
    passing: finalWorld(repoState({ issues: [{ number: Number(issue), labels: [{ name: label }] }] })),
    failing: finalWorld(
      repoState({ issues: [{ number: Number(issue), labels: [{ name: "unrelated" }] }] }),
    ),
  }),
  evaluate({ issue, repo, label }, { final }) {
    const found = resolveIssue(final, repo, issue);
    if ("missing" in found) return missOutcome(found);
    const applied = appliedLabelNames(found.found);
    const passed = applied.some((name) => sameLabel(name, label));
    return {
      passed,
      reason: passed
        ? `issue #${issue} has label "${label}"`
        : `issue #${issue} labels are [${applied.join(", ")}], missing "${label}"`,
      // The APPLIED set, which is the set this check scanned — not the repo's
      // label definitions, which is the neighbouring set `no-new-labels` reads
      // and the one this check's description exists to keep it distinct from.
      evidenceStatePaths: [childStatePath(found.path, "labels")],
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
  // The failing world holds the RIGHT label plus one more — the defect this
  // check exists to catch, and precisely the one `issue-has-label` passes.
  discriminatingWorlds: ({ issue, label }) => ({
    passing: finalWorld(repoState({ issues: [{ number: Number(issue), labels: [{ name: label }] }] })),
    failing: finalWorld(
      repoState({ issues: [{ number: Number(issue), labels: [{ name: label }, { name: "extra" }] }] }),
    ),
  }),
  evaluate({ issue, repo, label }, { final }) {
    const found = resolveIssue(final, repo, issue);
    if ("missing" in found) return missOutcome(found);
    const applied = appliedLabelNames(found.found);
    const passed = applied.length === 1 && sameLabel(applied[0]!, label);
    return {
      passed,
      reason: passed
        ? `issue #${issue} has exactly one label ("${label}")`
        : `issue #${issue} has labels [${applied.join(", ")}], expected exactly one label "${label}"`,
      // The same pointer `issue-has-label` cites, because both read the same
      // field — the difference between them is the assertion, not the address.
      evidenceStatePaths: [childStatePath(found.path, "labels")],
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
  // `assignees` really is `string[]` of logins here, while its label neighbours
  // are row objects — the domain resolves it through a separate join.
  discriminatingWorlds: ({ issue, login: wanted }) => ({
    passing: finalWorld(repoState({ issues: [{ number: Number(issue), assignees: [wanted] }] })),
    failing: finalWorld(repoState({ issues: [{ number: Number(issue), assignees: ["someone-else"] }] })),
  }),
  evaluate(args, { final }) {
    const found = resolveIssue(final, args.repo, args.issue);
    if ("missing" in found) return missOutcome(found);
    const assignees = found.found.assignees ?? [];
    const passed = assignees.includes(args.login);
    return {
      passed,
      reason: passed
        ? `issue #${args.issue} is assigned to "${args.login}"`
        : `issue #${args.issue} assignees are [${assignees.join(", ")}], missing "${args.login}"`,
      evidenceStatePaths: [childStatePath(found.path, "assignees")],
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
  // A comment that does not contain the needle, rather than zero comments: the
  // reason then states a scanned count, which distinguishes it from an
  // unresolvable issue.
  discriminatingWorlds: ({ issue, needle }) => ({
    passing: finalWorld(
      repoState({ issues: [{ number: Number(issue), comments: [{ body: `left pad ${needle} right pad` }] }] }),
    ),
    failing: finalWorld(
      repoState({ issues: [{ number: Number(issue), comments: [{ body: "unrelated chatter" }] }] }),
    ),
  }),
  evaluate({ needle, issue, repo }, { final }) {
    const found = resolveIssue(final, repo, issue);
    if ("missing" in found) return missOutcome(found);
    const comments = found.found.comments ?? [];
    const passed = comments.some((comment) => (comment.body ?? "").includes(needle));
    return {
      passed,
      reason: passed
        ? `issue #${issue} has a comment containing "${needle}"`
        : `issue #${issue} has no comment containing "${needle}" (${comments.length} comment(s) scanned)`,
      // The whole comment list, not the matching comment. The check scans every
      // body, so the list is what it read — and on the FAILING side there is no
      // matching row to point at, which would leave the citation present on a
      // pass and absent on a fail. A pointer that appears only when the verdict
      // is good is worse than none: its absence would read as a verdict class.
      evidenceStatePaths: [childStatePath(found.path, "comments")],
    };
  },
});
