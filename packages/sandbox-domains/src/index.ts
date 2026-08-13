// SPDX-License-Identifier: Apache-2.0
//
// The barrel: all five twins' domain runtimes under one specifier.
//
// Every twin names its pieces the same things — `parseSeed`, `migrate`,
// `resetDatabase`, `Check` — which is unambiguous when they arrive from five
// different packages and a collision the moment they arrive from one. So the
// barrel PREFIXES them by twin, and the per-twin subpaths
// (`@pome-sh/sandbox-domains/github`) keep the original names for a call site that
// only wants one twin. Same split, and the same reason, as
// `packages/checks/src/index.ts`.
//
// `lib/twin-state.ts` in pome-cloud boots all five at once and is the reason
// this barrel exists at all; `SANDBOX_DOMAINS` gives it the keyed record directly
// rather than making it rebuild one from five imports.

export {
  GitHubDomain,
  openGitHubCloneDatabase,
  resetDatabase as resetGitHubDatabase,
  GITHUB_CHECKS,
  defaultSeedState as defaultGitHubSeed,
  parseSeed as parseGitHubSeed,
  seedSchema as githubSeedSchema,
} from "./github.js";
export type {
  Check as GitHubCheck,
  GitHubCloneDatabase,
  GitHubStateSeed,
  ParsedGitHubStateSeed,
} from "./github.js";

export {
  GmailDomain,
  openGmailTwinDatabase,
  migrate as migrateGmailDatabase,
  resetDatabase as resetGmailDatabase,
  GMAIL_CHECKS,
  defaultSeedState as defaultGmailSeed,
  gmailSeedSchema,
  parseSeed as parseGmailSeed,
} from "./gmail.js";
export type {
  Check as GmailCheck,
  GmailStateSeed,
  GmailTwinDatabase,
  ParsedGmailStateSeed,
} from "./gmail.js";

export {
  LinearDomain,
  openLinearTwinDatabase,
  migrate as migrateLinearDatabase,
  resetDatabase as resetLinearDatabase,
  LINEAR_CHECKS,
  defaultSeedState as defaultLinearSeed,
  linearSeedSchema,
  parseSeed as parseLinearSeed,
} from "./linear.js";
export type {
  Check as LinearCheck,
  LinearStateSeed,
  LinearTwinDatabase,
  ParsedLinearStateSeed,
} from "./linear.js";

export {
  SlackDomain,
  openSlackTwinDatabase,
  migrate as migrateSlackDatabase,
  resetDatabase as resetSlackDatabase,
  SLACK_CHECKS,
  defaultSeedState as defaultSlackSeed,
  parseSeed as parseSlackSeed,
  seedSchema as slackSeedSchema,
} from "./slack.js";
export type {
  Check as SlackCheck,
  SlackStateSeed,
  SlackTwinDatabase,
} from "./slack.js";

export {
  StripeDomain,
  openTwinStripeDatabase,
  migrate as migrateStripeDatabase,
  resetDatabase as resetStripeDatabase,
  STRIPE_CHECKS,
  applySeed as applyStripeSeed,
  defaultSeed as defaultStripeSeed,
  parseSeed as parseStripeSeed,
  seedSchema as stripeSeedSchema,
} from "./stripe.js";
export type {
  Check as StripeCheck,
  SeedState as ParsedStripeStateSeed,
  TwinStripeDatabase,
} from "./stripe.js";

// The tape-row wrapper, re-exported from the barrel as well as from `./server`
// so a consumer replacing a frozen `@pome-sh/sdk` import has one specifier to
// move to rather than two (F-1527 retires that pin in both pome-cloud
// manifests).
export { toTwinHttpEventRow } from "./server.js";
export type { RecorderEvent } from "./server.js";

import { GitHubDomain, openGitHubCloneDatabase } from "./github.js";
import { GmailDomain, openGmailTwinDatabase } from "./gmail.js";
import { LinearDomain, openLinearTwinDatabase } from "./linear.js";
import { SlackDomain, openSlackTwinDatabase } from "./slack.js";
import { StripeDomain, openTwinStripeDatabase } from "./stripe.js";

/**
 * The five first-party twin ids, in the order `config/first-party-twins.json`
 * declares them. `scripts/check-first-party-twin-registration.mjs` compares
 * this against the canonical list, so a sixth twin whose runtime is missing
 * here is a named CI failure rather than a twin pome-cloud silently cannot
 * boot — the same guarantee `CHECKS_TWIN_NAMES` gives the vocabulary half.
 */
export const SANDBOX_DOMAIN_NAMES = ["github", "slack", "stripe", "gmail", "linear"] as const;

export type SandboxDomainName = (typeof SANDBOX_DOMAIN_NAMES)[number];

/**
 * Every twin's domain constructor and database opener, keyed by twin id — what
 * a boot path wants when it is handed a twin name rather than knowing it.
 *
 * Deliberately NOT collapsed to a common element type: the five domains have
 * five different constructor signatures over five different database shapes,
 * and a shared supertype would erase exactly the typing `lib/twin-state.ts`
 * relies on when it reaches into a domain. Reach for the per-twin export when
 * the twin is known.
 */
export const SANDBOX_DOMAINS = {
  github: { Domain: GitHubDomain, openDatabase: openGitHubCloneDatabase },
  slack: { Domain: SlackDomain, openDatabase: openSlackTwinDatabase },
  stripe: { Domain: StripeDomain, openDatabase: openTwinStripeDatabase },
  gmail: { Domain: GmailDomain, openDatabase: openGmailTwinDatabase },
  linear: { Domain: LinearDomain, openDatabase: openLinearTwinDatabase },
} as const satisfies Record<SandboxDomainName, { Domain: unknown; openDatabase: unknown }>;
