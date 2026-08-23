// SPDX-License-Identifier: Apache-2.0
//
// What Linear's declared checks can assert about COMMENTS.
//
// The threaded-reply check is the vocabulary's only `seed+final` member, and it
// is a delta for a reason task 25 states in its own prompt: "Reply in-thread to
// the EXISTING comment." A final-only reading — "some comment on this issue has
// a parentId" — is satisfied by an agent that posts a root comment and then
// replies to itself, which is not the behaviour the task examines. Comparing
// against the seed is what makes "the existing comment" mean something the
// grader can see.
//
// It also replaces a criterion that named an internal id
// ("A reply comment exists with parentId equal to the seeded root comment").
// Under position 2 an author picks a check and fills its parameters, so a
// sentence cannot reach into the seed for an identifier it never typed.

import { defineCheck, VACUITY_SENTINEL } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";
import { commentNeedle, issueTitle, teamKey } from "./check-params.js";
import { COMMENTS_PATH, resolveComments, resolveIssue, unresolved } from "./check-state.js";
import { deltaWorld, finalWorld, issueRow, linearState } from "./check-worlds.js";

export const issueCommentContains: Check<{ title: string; team: string; needle: string }> =
  defineCheck({
    id: "linear.issue-comment-contains",
    description:
      "Resolves the issue and scans the body of every comment on it for this string as a " +
      "SUBSTRING, case-sensitively. Because the string is hunted inside free prose rather than " +
      "compared to a field, a redactor that destroys it makes this check unable to fire — the " +
      "engine skips it as `subject_redacted` rather than passing it vacuously. Choose the " +
      "needle every honest phrasing would share, not the whole sentence you imagine the agent " +
      'writing: a task wanting a GitHub cross-reference is served by "#1", where "GitHub issue ' +
      '#1" fails an agent that wrote "linked from acme/api#1".',
    template: 'A comment on issue "{title}" in `{team}` contains "{needle}"',
    params: { title: issueTitle, team: teamKey, needle: commentNeedle },
    substrate: "final",
    polarity: () => "positive",
    // The needle is SCANNED inside prose, so it is the subject — twin-slack's
    // `messageNeedle` precedent, and the reason a redacted needle becomes an
    // honest skip rather than a silent failure.
    subject: ({ needle }) => needle,
    vacuityMutant: (args) => ({ ...args, needle: VACUITY_SENTINEL }),
    discriminatingWorlds: ({ title, needle }) => ({
      passing: finalWorld(
        linearState(
          [issueRow(title)],
          [{ id: "c1", issueId: "issue_1", parentId: null, body: `see ${needle}` }],
        ),
      ),
      // The issue AND a comment are present in both worlds; only the body
      // moves. A world with no comments would still fail, but for a reason
      // closer to the empty world's than to the assertion's.
      failing: finalWorld(
        linearState(
          [issueRow(title)],
          [{ id: "c1", issueId: "issue_1", parentId: null, body: "nothing relevant here" }],
        ),
      ),
    }),
    evaluate({ title, team, needle }, { final }) {
      const issue = resolveIssue(final, team, title);
      if ("missing" in issue) return unresolved(issue);
      const comments = resolveComments(final, issue.found);
      if ("missing" in comments) return unresolved(comments);
      const hit = comments.found.some((c) => (c.body ?? "").includes(needle));
      // Echoing the needle is safe HERE and only here: the engine skips a
      // subject the redaction pipeline destroys before reaching this line, so
      // anything quoted below is a string both redactors chose to leave intact.
      return {
        passed: hit,
        reason: hit
          ? `a comment contains "${needle}"`
          : `no comment contains "${needle}" (${comments.found.length} comment(s) scanned)`,
        evidenceStatePaths: [comments.path],
      };
    },
  });

export const issueThreadedReply: Check<{ title: string; team: string }> = defineCheck({
  id: "linear.issue-threaded-reply",
  description:
    "Asserts a comment exists on this issue whose `parentId` names a comment that was ALREADY " +
    "THERE IN THE SEED. Needs the seed: it is a delta, not a state assertion, and the delta is " +
    "what separates replying inside an existing thread from posting a comment and replying to " +
    "yourself. It asserts nothing about what the reply says, or who wrote it.",
  template: 'A threaded reply to a seeded comment exists on issue "{title}" in `{team}`',
  params: { title: issueTitle, team: teamKey },
  substrate: "seed+final",
  polarity: () => "positive",
  // No caller-supplied literal reaches an assertion: title and team only
  // select, and the predicate compares ids it read out of the two substrates.
  subject: () => null,
  // Ledgered. Both slots only SELECT, so there is nothing in the sentence to
  // falsify — the trigger is a parentId relation between two substrates.
  vacuityMutant: () => null,
  discriminatingWorlds: ({ title }) => {
    const seededRoot = { id: "root", issueId: "issue_1", parentId: null, body: "reply here" };
    const seed = linearState([issueRow(title)], [seededRoot]);
    return {
      passing: deltaWorld(
        seed,
        linearState(
          [issueRow(title)],
          [seededRoot, { id: "reply", issueId: "issue_1", parentId: "root", body: "on it" }],
        ),
      ),
      // The issue and the seeded root are present in both worlds; only the
      // reply's PARENT moves. This agent commented — just not in the thread.
      failing: deltaWorld(
        seed,
        linearState(
          [issueRow(title)],
          [seededRoot, { id: "own", issueId: "issue_1", parentId: null, body: "on it" }],
        ),
      ),
    };
  },
  evaluate({ title, team }, { seed, final }) {
    // The engine guards this before calling; the check guards too, so a
    // consumer that forgets gets a named skip rather than a vacuous pass.
    if (seed === null) return { passed: false, reason: "seed_missing", status: "skipped" };

    // SEED-side refusals cite nothing, deliberately. `unresolved` carries the
    // pointer the lookup walked, and these two walked the SEED — a pointer
    // always addresses `final` (see the sdk's `check-state-path.ts`), so passing
    // one through here would send a reader into the tree the report does not
    // render, at a path that may well resolve to something unrelated. Dropping
    // the citation is the honest degradation; the reason still names the miss.
    const seedIssue = resolveIssue(seed, team, title);
    if ("missing" in seedIssue) return unresolved({ ...seedIssue, searched: undefined });
    const seedComments = resolveComments(seed, seedIssue.found);
    if ("missing" in seedComments) return unresolved({ ...seedComments, searched: undefined });
    const seeded = new Set(
      seedComments.found.map((c) => c.id).filter((id): id is string => typeof id === "string"),
    );

    const finalIssue = resolveIssue(final, team, title);
    if ("missing" in finalIssue) return unresolved(finalIssue);
    const finalComments = resolveComments(final, finalIssue.found);
    if ("missing" in finalComments) return unresolved(finalComments);

    const replies = finalComments.found.filter(
      (c) => typeof c.parentId === "string" && seeded.has(c.parentId),
    );
    return {
      passed: replies.length > 0,
      reason:
        `${replies.length} repl${replies.length === 1 ? "y" : "ies"} to a seeded comment ` +
        `(${seeded.size} seeded comment(s), ${finalComments.found.length} at finish)`,
      // The FINAL comment list only. This is a delta over two trees and the
      // reader has one on screen; a pointer into the seed would send them to the
      // tree the report does not render (see the sdk's `check-state-path.ts`).
      // The reason carries the seed side.
      evidenceStatePaths: [COMMENTS_PATH],
    };
  },
});
