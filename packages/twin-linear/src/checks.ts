// SPDX-License-Identifier: Apache-2.0
//
// The Linear twin's assertable check vocabulary (F-1129, milestone A3).
//
// These live HERE, next to the state they read, because the twin owns that
// state's shape. pome-cloud imports this module from npm and adapts each
// declaration onto its predicate engine, so there is no second copy to
// reconcile — only a pin that can fall behind, which is what its drift gate
// exists to catch. The cloud's `deterministic/linear.ts`, including its
// hand-maintained mirror of the state shape whose header records a manual
// audit "verified against source, 2026-07-25", is deleted in the same
// milestone. That audit is the artifact this file retires.
//
// Linear is the LAST of A3's four vocabularies, and the one that answered the
// two questions the earlier three left open:
//
//   * A rendered sentence cannot carry a pronoun. Six of the nine shipped
//     criteria named their subject with "that issue", with no subject at all,
//     or by pointing at the seed. Under position 2 an author picks a check and
//     fills its parameters, and `evaluate(args, substrate)` receives only its
//     own args — so there is no mechanism by which "that issue" could resolve.
//     Every check therefore takes an explicit title, and the three task files
//     were rewritten to say so.
//   * twin-github FAILS on a selector miss and twin-slack SKIPS. Linear does
//     both, split by evidence rather than by taste — see `check-state.ts`.
//
// This file is the ASSEMBLY. Declarations group by what they assert about
// (`check-issues.ts`, `check-comments.ts`, `check-tape.ts`), with typed slots in
// `check-params.ts`, fixture worlds in `check-worlds.ts`, and the reading of the
// exported tree in `check-state.ts`.

import {
  issueAssignee,
  issueEstimate,
  issueExists,
  issueHasLabel,
  issueState,
} from "./check-issues.js";

export type { Check } from "./check-kind.js";
export type {
  LinearCheckState,
  LinearCheckStateComment,
  LinearCheckStateIssue,
  LinearCheckStateLabel,
  LinearCheckStateTeam,
  LinearCheckStateUser,
  LinearCheckStateWorkflowState,
} from "./check-state.js";

// Order is not first-match-wins — the generated patterns are anchored and
// mutually exclusive, and `checks-contract.test.ts` proves no sentence is
// claimed by two. It is the order an authoring surface lists them in, running
// from the assertion an author reaches for first to the ones a specialised task
// needs.
export const LINEAR_CHECKS = [
  issueExists,
  issueState,
  issueHasLabel,
  issueEstimate,
  issueAssignee,
] as const;
