// SPDX-License-Identifier: Apache-2.0
//
// The GitHub twin's assertable check vocabulary (F-1073, widened in F-1075).
//
// These live HERE, next to the state they read, because the twin owns that
// state's shape. pome-cloud imports this module from npm and adapts each
// declaration onto its predicate engine, so there is no second copy to
// reconcile — only a pin that can fall behind, which is what its drift gate
// exists to catch.
//
// This file is the ASSEMBLY. The declarations themselves are grouped by the
// entity they assert about — `check-issues.ts`, `check-pulls.ts`,
// `check-repos.ts` — with the typed slots in `check-params.ts` and the reading
// of the exported tree in `check-state.ts`.
//
// F-1075 moved the remaining ten GitHub predicates here from
// `apps/control-plane/.../deterministic/github.ts`, where they were regexes.
// Three things changed in the move, and each is load-bearing:
//
//   1. THE REGEX IS GONE. The matcher is generated from `template`, so a
//      declaration and its pattern cannot drift. An author never types the
//      sentence, so binding cannot fail (position 2, ratified 2026-07-27).
//
//   2. EVERY CHECK NAMES ITS REPO. The legacy patterns took `in owner/repo` as
//      an OPTIONAL qualifier and, when it was absent, scanned repos
//      first-match-wins. That is a latent wrong-match: a multi-repo world
//      reuses issue numbers, and the criterion would silently grade whichever
//      repo sorted first. Under a picked check the repo costs the author
//      nothing — the picker asks for it — so the ambiguity is simply removed.
//      It also matches `no-new-labels`, which has always named its repo, and
//      for the same reason: the repo is what tells a reader WHICH scope is
//      being asserted. `checks-contract.test.ts` asserts it of every check.
//
//   3. TWO PHRASINGS BECAME ONE CHECK. The legacy registry carried both
//      `issue-has-label` ("has the `bug` label") and `issue-has-label-generic`
//      ("has label bug") for one predicate, because free English arrives in
//      more than one word order. Nothing renders the second one now, so it is
//      retired rather than ported.
//
// F-1076 brought the last one home. `No unsupported endpoint was called` reads
// the call TAPE, and until D1's open half was settled there was no substrate to
// declare — the promise would have had no engine behind it. There is one now:
// `check-tape.ts` holds the declaration, and the consuming engine REFUSES to
// evaluate it against a tape it was not given rather than skipping silently.
//
// So github now has no hand-written predicate left anywhere.

import {
  issueAssignee,
  issueCommentContains,
  issueExactlyOneLabel,
  issueExists,
  issueHasLabel,
  issueStateCheck,
} from "./check-issues.js";
import {
  pullRequestCommentExists,
  pullRequestReviewExists,
  pullRequestStateCheck,
} from "./check-pulls.js";
import { commitStatus, fileExists, noNewIssues, noNewLabels } from "./check-repos.js";
import { noUnsupportedEndpoint, toolNeverCalled, toolWasCalled } from "./check-tape.js";

export type { Check } from "./check-kind.js";
export type {
  GitHubCheckState,
  GitHubCheckStateComment,
  GitHubCheckStateCommitStatus,
  GitHubCheckStateFile,
  GitHubCheckStateIssue,
  GitHubCheckStateLabel,
  GitHubCheckStatePullRequest,
  GitHubCheckStateRepo,
  GitHubCheckStateReview,
} from "./check-state.js";

// Order is not first-match-wins here — the generated patterns are anchored and
// mutually exclusive, and `checks-contract.test.ts` proves no sentence is
// claimed by two checks. It is the order an authoring surface lists them in, so
// it runs from the assertion an author reaches for first to the ones a
// specialised task needs.
export const GITHUB_CHECKS = [
  issueExists,
  issueStateCheck,
  issueHasLabel,
  issueExactlyOneLabel,
  issueAssignee,
  issueCommentContains,
  // The two repo-scoped deltas sit together, right after the issue assertions
  // they are the negatives of: `no-new-issues` is what `issue-exists` cannot
  // say, and an author reaching for one usually wants to see the other.
  noNewIssues,
  noNewLabels,
  pullRequestStateCheck,
  pullRequestCommentExists,
  pullRequestReviewExists,
  fileExists,
  commitStatus,
  // Last, because the listing order runs from the assertion an author reaches
  // for first to the ones a specialised task needs — and these are the only ones
  // that assert about the RUN rather than the world it left behind.
  noUnsupportedEndpoint,
  toolNeverCalled,
  // F-1338. Adjacent to its prohibition for the reason the two repo-scoped
  // deltas sit together above: an author reaching for one usually wants to see
  // the other, and these two are the same predicate read in opposite
  // directions off one closed set of actions. It is appended rather than
  // slotted in front so the existing listing order does not move.
  toolWasCalled,
] as const;
