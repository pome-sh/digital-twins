// SPDX-License-Identifier: Apache-2.0
//
// The barrel: all five twins' grading vocabularies and seed contracts, plus the
// DSL they are written in, under one specifier.
//
// Every twin names its seed helpers the same three things (`parseSeed`,
// `seedSchema`/`<twin>SeedSchema`, `defaultSeedState`/`defaultSeed`), which is
// unambiguous when they arrive from five different packages and a collision the
// moment they arrive from one. So the barrel PREFIXES them by twin, and the
// per-twin subpaths (`@pome-sh/checks/github`) keep the original names for a
// call site that only wants one twin.
//
// `resolveTwinChecks` in pome-cloud wants all five check arrays at once and is
// the reason the barrel exists at all; `TWIN_CHECKS` gives it the keyed record
// directly rather than making it rebuild one from five imports.
export * from "./dsl.js";

export { GITHUB_CHECKS } from "@pome-sh/twin-github/checks";
export { GMAIL_CHECKS } from "@pome-sh/twin-gmail/checks";
export { LINEAR_CHECKS } from "@pome-sh/twin-linear/checks";
export { SLACK_CHECKS } from "@pome-sh/twin-slack/checks";
export { STRIPE_CHECKS } from "@pome-sh/twin-stripe/checks";

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
} from "@pome-sh/twin-github/checks";
export type {
  GmailCheckState,
  GmailCheckStateDraft,
  GmailCheckStateLabel,
  GmailCheckStateMailbox,
  GmailCheckStateMessage,
  GmailCheckStateMessageLabel,
} from "@pome-sh/twin-gmail/checks";
export type {
  LinearCheckState,
  LinearCheckStateComment,
  LinearCheckStateIssue,
  LinearCheckStateLabel,
  LinearCheckStateTeam,
  LinearCheckStateUser,
  LinearCheckStateWorkflowState,
} from "@pome-sh/twin-linear/checks";
export type {
  SlackCheckState,
  SlackCheckStateChannel,
  SlackCheckStateMessage,
  SlackCheckStateReaction,
} from "@pome-sh/twin-slack/checks";
export type {
  StripeCheckState,
  StripeCheckStateBalanceTransaction,
  StripeCheckStateCharge,
  StripeCheckStateEvent,
  StripeCheckStatePaymentIntent,
  StripeCheckStateRefund,
} from "@pome-sh/twin-stripe/checks";

export {
  defaultSeedState as defaultGitHubSeed,
  parseSeed as parseGitHubSeed,
  seedSchema as githubSeedSchema,
} from "@pome-sh/twin-github/seed";
export {
  defaultSeedState as defaultGmailSeed,
  gmailSeedSchema,
  parseSeed as parseGmailSeed,
} from "@pome-sh/twin-gmail/seed";
export {
  defaultSeedState as defaultLinearSeed,
  linearSeedSchema,
  parseSeed as parseLinearSeed,
} from "@pome-sh/twin-linear/seed";
export {
  defaultSeedState as defaultSlackSeed,
  parseSeed as parseSlackSeed,
  seedSchema as slackSeedSchema,
} from "@pome-sh/twin-slack/seed";
export {
  defaultSeed as defaultStripeSeed,
  parseSeed as parseStripeSeed,
  seedSchema as stripeSeedSchema,
} from "@pome-sh/twin-stripe/seed";

export type { ParsedGitHubStateSeed } from "@pome-sh/twin-github/seed";
export type { ParsedGmailStateSeed } from "@pome-sh/twin-gmail/seed";
export type { ParsedLinearStateSeed } from "@pome-sh/twin-linear/seed";
export type { SeedState as ParsedStripeStateSeed } from "@pome-sh/twin-stripe/seed";

import { GITHUB_CHECKS } from "@pome-sh/twin-github/checks";
import { GMAIL_CHECKS } from "@pome-sh/twin-gmail/checks";
import { LINEAR_CHECKS } from "@pome-sh/twin-linear/checks";
import { SLACK_CHECKS } from "@pome-sh/twin-slack/checks";
import { STRIPE_CHECKS } from "@pome-sh/twin-stripe/checks";

/**
 * The five first-party twin ids, in the order `config/first-party-twins.json`
 * declares them. `scripts/check-first-party-twin-registration.mjs` compares this
 * against the canonical list, so a sixth twin whose vocabulary is missing here
 * is a named CI failure rather than a criterion that silently never binds.
 */
export const CHECKS_TWIN_NAMES = ["github", "slack", "stripe", "gmail", "linear"] as const;

export type ChecksTwinName = (typeof CHECKS_TWIN_NAMES)[number];

/**
 * Every twin's vocabulary, keyed by twin id — what a resolver wants when it is
 * handed a criterion and a twin name and has to find the matching declaration.
 *
 * Typed as the loose `readonly unknown[]` union rather than a single check type
 * on purpose: the five arrays are `Check<TState, TArgs>[]` over five DIFFERENT
 * `TState`s, and collapsing them to one element type would erase exactly the
 * state typing `resolveTwinChecks` relies on. Reach for the per-twin export when
 * you need the precise element type.
 */
export const TWIN_CHECKS = {
  github: GITHUB_CHECKS,
  slack: SLACK_CHECKS,
  stripe: STRIPE_CHECKS,
  gmail: GMAIL_CHECKS,
  linear: LINEAR_CHECKS,
} as const satisfies Record<ChecksTwinName, readonly unknown[]>;
