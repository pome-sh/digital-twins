// SPDX-License-Identifier: Apache-2.0
// The `/seed` subpath, not the package root: a schema is data, and the
// roots carry each twin's domain + server. See `parseTask.ts`'s note.
import { seedSchema as githubSeedStateSchema } from "@pome-sh/twin-github/seed";
import { gmailSeedSchema as gmailSeedStateSchema } from "@pome-sh/twin-gmail/seed";
import { linearSeedSchema as linearSeedStateSchema } from "@pome-sh/twin-linear/seed";
// Criterion kinds are owned by the published contract. The markdown marker
// grammar is `[code]`/`[model]`; `criterionSchema`'s tolerant input
// (legacy `D`/`P` enum values) exists only for 0.3.0-era persisted artifacts,
// never for scenario markdown. The former local criterion-kind fork is
// retired here (M6 — one published contract).
import { criterionSchema, normalizeTaskConfigKeys } from "../contract/index.js";
import { z } from "zod";

export { criterionSchema };

// The published contract's
// criterion, plus the one thing this parser has to say about it that the
// contract does not carry yet.
//
// `alwaysScored` marks a criterion that must be graded even when the SEED
// already satisfies it — the inverse-task escape hatch for pome-cloud's
// seed-exclusion rule (see `apps/control-plane/src/services/evaluators/
// deterministic/pre-satisfied.ts` and `docs/grading/seed-exclusion.md`,
// pome-cloud). Authored as a marker keyword, `- [code:slack always-scored] …`,
// and read by `parseCriteria`.
//
// EXTENDED HERE rather than on `criterionSchema` itself, mirroring the choice
// the hosted mirror already made (`apps/mcp/src/task/taskSchema.ts`,
// pome-cloud): `criterionSchema` (`../contract/run.ts`) is the published wire
// contract shared with `CriterionResult` / verdict artifacts / every other
// consumer of a parsed Criterion, and a flag only the deterministic scorer
// reads does not need to widen every one of those. Extending keeps the field
// alive across this module's own `.parse()` without touching the wire shape
// everything else consumes.
export const taskCriterionSchema = criterionSchema.extend({
  alwaysScored: z.boolean().optional(),
});

// Which population a task belongs to. See `taskClassSchema` in
// ../contract/task.ts for what the three values mean and why the field is
// optional here but mandatory for the tasks THIS repo ships.
export const taskClassSchema = z.enum(["conformance", "restraint", "adversarial"]);

// The snake_case alias for `passThreshold` comes from the published contract
// (`normalizeTaskConfigKeys`, ../contract/task.ts) rather than being re-declared
// here. This parser's config schema and the contract's are two schemas — the
// contract carries `judge`, this one does not — but which spellings a hand-authored
// `## Config` block may use is one fact, and a parser that knew fewer of them than
// the contract would silently strip the key the contract accepts.
export const taskConfigSchema = z.preprocess(
  normalizeTaskConfigKeys,
  z.object({
    twins: z.array(z.string()).default(["github"]),
    class: taskClassSchema.optional(),
    timeout: z.number().int().positive().default(60),
    runs: z.number().int().positive().default(1),
    passThreshold: z.number().min(0).max(100).default(100)
  })
);

// ── THE SLACK AND STRIPE ARMS ARE HAND-WRITTEN MIRRORS, AND THEY DRIFT ──────
//
// Three of the five arms below import the twin's own schema and so cannot
// drift. slack and stripe cannot: both must be `.strict()` and the twins'
// schemas are not, and that strictness is load-bearing twice over — it makes the
// legacy `{ <twin>: { seed: … } }` wrapper fail loudly instead of parsing to an
// empty seed, and it stops the slack arm greedily matching a github or stripe
// seed inside `seedStateSchema`'s union.
//
// Both had drifted, measured 2026-08-27. slack's had never carried `emoji` (in
// the twin since #190), so a slack task seed using it was refused with
// `Unrecognized key`. stripe's lacked `refunds` and `balance_transactions` while
// carrying five fields the twin's seed schema does not have, so a task declaring
// `customers` parsed clean here and was dropped at boot. It had been fixed once
// before, for `files` (#432) — that fixed the instance.
//
// ⚠️ DERIVING THE KEY SET AT RUNTIME IS NOT AVAILABLE HERE. It was the first
// fix, and `scripts/lint/rules/twin-chunks.mjs` refused it: `@pome-sh/twin-stripe/seed`
// statically imports `./domain/schema.js` for `applySeed`, so it is NOT the
// zod-only leaf `registry.ts`'s header and that rule's own advice both call it,
// and a static import from this module puts stripe's domain in the graph
// `pome --version` loads. So the field LISTS stay written out here, in the
// TWIN's field order, and `cli/test/unit/task-seed-mirror.test.ts` is the gate:
// it imports both twins and fails the moment either key set moves. Tests are not
// in the CLI's runtime graph, so the derivation is free there.

// Scenario-level failure injection. Mirrors the packaged
// twin-stripe `failureInjectionRuleSchema` without importing it into the
// parser, so scenario validation stays decoupled from twin boot/runtime code.
export const stripeFailureInjectionRuleSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  attempt: z.number().int().positive(),
  mode: z.enum(["before_handler", "after_handler"]).default("after_handler"),
  status: z.number().int().min(100).max(599),
  body: z.unknown()
});

// `.strict()` at the top level: unknown keys (notably the legacy
// `stripe: { seed: ... }` wrapper) fail parsing loudly
// instead of silently being stripped to an empty seed.
//
// `customers` / `products` / `prices` / `events` / `balances` used to be listed
// here and are gone: the stripe twin's seed schema has never had them, so a task
// declaring one parsed clean here and then reached a twin that dropped it. No
// task in this repo used any of the five.
export const stripeSeedStateSchema = z
  .object({
    api_keys: z
      .array(
        z.object({
          key: z.string().min(1).default("sk_test_pome_default"),
          sid: z.string().min(1).default("default"),
          account_id: z.string().min(1).optional()
        })
      )
      .default([]),
    failure_injection: z.array(stripeFailureInjectionRuleSchema).default([]),
    payment_intents: z.array(z.record(z.string(), z.unknown())).default([]),
    charges: z.array(z.record(z.string(), z.unknown())).default([]),
    refunds: z.array(z.record(z.string(), z.unknown())).default([]),
    balance_transactions: z.array(z.record(z.string(), z.unknown())).default([])
  })
  .strict();

// Slack seed shape (`{ team?, users: [...], channels: [...] }`).
// Kept LOCAL and permissive (arrays of records) for the same reason the Stripe
// schema is — the scenario parser shouldn't take a structural dep on twin
// internals; the vendored `cli/src/twin-slack` `parseSeed` does the strict,
// regex-level validation at boot. `.strict()` is load-bearing: it makes this
// arm reject any object carrying a GitHub (`repositories`) or Stripe
// (`api_keys`, `charges`, …) discriminator, so placing it FIRST in the union
// (below) can't greedily mis-match a non-Slack seed.
//
// `files` and `emoji` are the reason the key set is derived. Both are fields the
// twin declares; `files` was added by hand after a slack seed that used it
// failed to parse (#432), and `emoji` never was — so it kept failing, for two
// releases, with `Unrecognized key: "emoji"`.
export const slackSeedStateSchema = z
  .object({
    team: z.record(z.string(), z.unknown()).optional(),
    users: z.array(z.record(z.string(), z.unknown())).default([]),
    channels: z.array(z.record(z.string(), z.unknown())).default([]),
    files: z.array(z.record(z.string(), z.unknown())).default([]),
    emoji: z.array(z.record(z.string(), z.unknown())).default([])
  })
  .strict();

// Slack scenarios use the Slack seed shape (`{ users, channels, ... }`).
// Multi-twin scenarios are not a current requirement; the wrapped
// `{ <twin>: { seed: ... } }` form was rejected here to keep one canonical
// shape that twin parsers already speak natively. parseTask disambiguates
// the union by `config.twins`.
//
// Slack arm is FIRST because it was the only `.strict()` arm: a GitHub/Stripe
// seed carries keys it rejects, so it never mis-matches them; while a Slack
// seed would otherwise have been silently key-stripped by the then-non-strict
// GitHub arm. Every arm is strict now (F-1689 for the three twin schemas), so
// the ordering no longer carries that weight — it is kept because a union's
// error message names the LAST arm it tried, and the arms are unchanged.
export const seedStateSchema = z.union([
  gmailSeedStateSchema,
  slackSeedStateSchema,
  linearSeedStateSchema,
  githubSeedStateSchema,
  stripeSeedStateSchema
]);

// Multi-twin (M3): a per-twin seed envelope `{ <twin>: <flat seed> }`, produced
// ONLY for scenarios whose `config.twins` has >1 entry (the envelope-iff-multi-twin
// rule, decided from `twins` alone — never by sniffing the seed shape). Each value
// is one twin's flat seed, the same shapes `seedStateSchema` unions. Single-twin
// scenarios keep the flat shape byte-identical. parseTask builds and validates
// the envelope value-by-value with each twin's own schema; this record is the outer
// shape taskSchema re-validates against.
export const seedEnvelopeSchema = z.record(z.string(), seedStateSchema);

export const taskSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  setup: z.string().default(""),
  prompt: z.string().min(1),
  expectedBehavior: z.string().default(""),
  criteria: z.array(taskCriterionSchema).min(1),
  config: taskConfigSchema,
  // Flat single-twin seed OR the multi-twin per-twin envelope. Flat is tried
  // first so single-twin seeds match their strict arms; the envelope only
  // matches when the flat union can't (its keys are twin ids, not seed fields).
  seedState: z.union([seedStateSchema, seedEnvelopeSchema])
});

export type Criterion = z.infer<typeof taskCriterionSchema>;
export type TaskConfig = z.infer<typeof taskConfigSchema>;
export type GithubSeedState = z.infer<typeof githubSeedStateSchema>;
export type StripeSeedState = z.infer<typeof stripeSeedStateSchema>;
export type SlackSeedState = z.infer<typeof slackSeedStateSchema>;
export type GmailSeedState = z.infer<typeof gmailSeedStateSchema>;
export type LinearSeedState = z.infer<typeof linearSeedStateSchema>;
export type StripeFailureInjectionRule = z.infer<typeof stripeFailureInjectionRuleSchema>;
export type SeedState = z.infer<typeof seedStateSchema>;
export type SeedEnvelope = z.infer<typeof seedEnvelopeSchema>;
export type Task = z.infer<typeof taskSchema>;
