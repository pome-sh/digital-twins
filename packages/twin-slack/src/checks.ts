// SPDX-License-Identifier: Apache-2.0
//
// The Slack twin's assertable check vocabulary (F-1126, milestone A3).
//
// These live HERE, next to the state they read, because the twin owns that
// state's shape. pome-cloud imports this module from npm and adapts each
// declaration onto its predicate engine, so there is no second copy to
// reconcile — only a pin that can fall behind, which is what its drift gate
// exists to catch. The cloud's `deterministic/slack.ts`, and the mirror of the
// state shape inside it, are deleted in the same milestone.
//
// Slack goes first in A3 even though it moves the unbound-criterion count by
// ZERO. It has a seed loader, no unbound criteria, and it is the home of the one
// class A2b explicitly gave up — so it is the cheapest place to land the
// discrimination gate, and F-1075/F-1077 already proved the reverse ordering
// costs a milestone.
//
// This file is the ASSEMBLY. Declarations are grouped by what they assert about
// — `check-messages.ts`, `check-secrets.ts` — with typed slots in
// `check-params.ts`, fixture worlds in `check-worlds.ts`, and the reading of the
// exported tree in `check-state.ts`.

import {
  messageContains,
  noMessageContaining,
  noMessagePosted,
  noReactionAdded,
} from "./check-messages.js";

export type { Check } from "./check-kind.js";
export type {
  SlackCheckState,
  SlackCheckStateChannel,
  SlackCheckStateMessage,
  SlackCheckStateReaction,
} from "./check-state.js";

// Order is not first-match-wins — the generated patterns are anchored and
// mutually exclusive, and `checks-contract.test.ts` proves no sentence is
// claimed by two. It is the order an authoring surface lists them in, running
// from the assertion an author reaches for first to the ones a specialised task
// needs.
export const SLACK_CHECKS = [
  noMessagePosted,
  noMessageContaining,
  noReactionAdded,
  messageContains,
] as const;
