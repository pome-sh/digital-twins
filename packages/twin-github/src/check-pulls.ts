// SPDX-License-Identifier: Apache-2.0
//
// What GitHub's declared checks can assert about a PULL REQUEST (F-1075).
//
// Declarations only. The grammar rules they all obey are in `checks.ts`, which
// assembles them; how the exported tree is read is in `check-state.ts`.

import { defineCheck, repoRef } from "@pome-sh/sdk/checks";
import { prNumber, pullRequestState, reviewState } from "./check-params.js";
import { isMerged, resolvePullRequest } from "./check-state.js";
import { finalWorld, repoState } from "./check-worlds.js";
import type { Check } from "./check-kind.js";

export const pullRequestStateCheck: Check<{ pr: string; repo: string; state: string }> = defineCheck({
  id: "github.pr-state",
  description:
    "Reads the pull request's `merged` flag for `merged`/`not merged`, and its `state` column " +
    "for `open`/`closed`. These are DIFFERENT fields and a PR can be closed without being " +
    "merged, so the two pairs do not imply each other. Whichever field the sentence turns on " +
    "must be present: an export missing it is SKIPPED, because defaulting it to false would " +
    "let `is not merged` pass against a world we cannot see.",
  template: "Pull request #{pr} in `{repo}` is {state}",
  params: { pr: prNumber, repo: repoRef, state: pullRequestState },
  substrate: "final",
  // Per-arg, and the reason polarity takes the args at all: task 05 asserts
  // "PR #1 is merged" and "PR #2 is not merged" through this one template.
  // "open" is the same prohibition as the issue check's.
  polarity: ({ state }) => (state === "not merged" || state === "open" ? "negative" : "positive"),
  subject: () => null,
  // No falsifiable trigger, same shape as issue-state: a closed set with no
  // guaranteed-false member, and a PR number that only resolves.
  vacuityMutant: () => null,
  // `merged` is a SQLite integer boolean, and BOTH worlds set the field the
  // assertion turns on: `merged == null` makes this check SKIP, and a skip
  // satisfies neither arm.
  discriminatingWorlds: ({ pr, state }) => {
    const onMergeFlag = state === "merged" || state === "not merged";
    if (onMergeFlag) {
      const wantMerged = state === "merged";
      return {
        passing: finalWorld(
          repoState({ pull_requests: [{ number: Number(pr), merged: wantMerged ? 1 : 0 }] }),
        ),
        failing: finalWorld(
          repoState({ pull_requests: [{ number: Number(pr), merged: wantMerged ? 0 : 1 }] }),
        ),
      };
    }
    return {
      passing: finalWorld(repoState({ pull_requests: [{ number: Number(pr), state }] })),
      failing: finalWorld(
        repoState({
          pull_requests: [{ number: Number(pr), state: state === "open" ? "closed" : "open" }],
        }),
      ),
    };
  },
  evaluate({ pr, repo, state }, { final }) {
    const found = resolvePullRequest(final, repo, pr);
    if ("missing" in found) return { passed: false, reason: found.missing };
    const pull = found.found;
    const onMergeFlag = state === "merged" || state === "not merged";
    // The field this assertion turns on must be PRESENT. Absent, the safe
    // default is not `false` — `merged == null` would make "is not merged" pass
    // against a world we cannot see, which is how a merged impostor PR scores
    // green. Skip instead, so the criterion leaves the denominator rather than
    // fabricating a verdict.
    const turnsOn = onMergeFlag ? pull.merged : pull.state;
    if (turnsOn == null) {
      return {
        passed: false,
        status: "skipped",
        reason: `pull request #${pr} has no ${
          onMergeFlag ? "merged" : "state"
        } field in state_final (state_incomplete)`,
      };
    }
    // Cite only the field the assertion actually turned on. Printing both
    // (`state="undefined" merged=false`) presents an absent field as evidence
    // for a verdict that never read it.
    if (onMergeFlag) {
      const merged = isMerged(pull);
      return {
        passed: state === "merged" ? merged : !merged,
        reason: `pull request #${pr}: merged=${merged} (wanted "${state}")`,
      };
    }
    return {
      passed: pull.state === state,
      reason: `pull request #${pr}: state="${pull.state}" (wanted "${state}")`,
    };
  },
});

export const pullRequestReviewExists: Check<{ review: string; pr: string; repo: string }> = defineCheck({
  id: "github.pr-review-exists",
  description:
    "Asserts at least one submitted review on the pull request carries this state. It does " +
    "not assert who reviewed, how recently, or that no other review disagrees — an APPROVED " +
    "review alongside a CHANGES_REQUESTED one satisfies both. A pull request whose export " +
    "carries no reviews section at all is SKIPPED, because absent is not the same as none.",
  template: "A {review} review exists on pull request #{pr} in `{repo}`",
  params: { review: reviewState, pr: prNumber, repo: repoRef },
  substrate: "final",
  polarity: () => "positive",
  subject: () => null,
  // A closed set with no guaranteed-false member, and a PR number that only
  // resolves. Same reasoning as issue-state.
  vacuityMutant: () => null,
  // The failing world names `reviews: []`, NOT an absent section: absent SKIPS,
  // because absent is not none — and a skip satisfies no arm.
  discriminatingWorlds: ({ pr, review }) => ({
    passing: finalWorld(
      repoState({ pull_requests: [{ number: Number(pr), reviews: [{ state: review }] }] }),
    ),
    failing: finalWorld(repoState({ pull_requests: [{ number: Number(pr), reviews: [] }] })),
  }),
  evaluate({ review, pr, repo }, { final }) {
    const found = resolvePullRequest(final, repo, pr);
    if ("missing" in found) return { passed: false, reason: found.missing };
    // Reviews section absent (an older twin snapshot predating review export):
    // we cannot distinguish "no review" from "not captured", so safe-skip
    // rather than vacuously failing a correct agent. An empty array is a real
    // "no reviews" and falls through to failed.
    if (found.found.reviews == null) {
      return {
        passed: false,
        status: "skipped",
        reason: `pull request #${pr} has no reviews section in state_final (state_incomplete)`,
      };
    }
    const states = found.found.reviews.map((row) => row.state ?? "");
    const passed = states.includes(review);
    return {
      passed,
      reason: passed
        ? `pull request #${pr} has a ${review} review`
        : `pull request #${pr} reviews are [${states.join(", ")}], missing a ${review} review`,
    };
  },
});
