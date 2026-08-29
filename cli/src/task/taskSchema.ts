// SPDX-License-Identifier: Apache-2.0
// The `/seed` subpath, not the package root: a schema is data, and the
// roots carry each twin's domain + server. See `parseTask.ts`'s note.
import { seedSchema as githubSeedStateSchema } from "@pome-sh/twin-github/seed";
// slack and stripe are imported as well as re-exported: `seedStateSchema`
// below needs the values. See the block above for why they stopped being
// hand-written mirrors.
import { seedSchema as slackSeedSchema } from "@pome-sh/twin-slack/seed";
import { seedSchema as stripeSeedSchema } from "@pome-sh/twin-stripe/seed";
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

// ── EVERY ARM IS THE TWIN'S OWN SCHEMA NOW ─────────────────────────────────
//
// slack and stripe were the two hand-written mirrors, for one reason: both had
// to be `.strict()` and the twins' schemas were not. That strictness was
// load-bearing twice over — it makes the legacy `{ <twin>: { seed: … } }`
// wrapper fail loudly instead of parsing to an empty seed, and it stops the
// slack arm greedily matching a github or stripe seed inside
// `seedStateSchema`'s union below. F-1689 made all five twin schemas strict at
// every level, which removed the reason.
//
// The mirrors drifted at BOTH layers while they lived. #488 fixed the top-level
// key sets (slack had never carried `emoji`, in the twin since #190; stripe
// lacked `refunds`/`balance_transactions` and carried five keys the twin has
// never had). What #488 could not fix is what the rows UNDER those keys said:
// they stayed `z.record(z.string(), z.unknown())`, an open map validating
// nothing. Measured 2026-08-29, that let this parser bless a world the twin then
// refused to boot —
//
//     { charges: [{ id: "ch_1" }] }                  parsed here, refused there
//     { charges: [{ …, amount_refunfed: 20000 }] }   parsed here, refused there
//     { channels: [{ name: "eng", mesages: [] }] }   parsed here, refused there
//
// — which reads to the author as `pome eval` blessing their task and the run
// failing anyway.
//
// STRIPE COULD NOT BE IMPORTED UNTIL F-584 SPLIT ITS SEED MODULE. Deriving the
// key set here was tried first and `scripts/lint/rules/twin-chunks.mjs` refused
// it: `@pome-sh/twin-stripe/seed` statically imported `./domain/schema.js` for
// `applySeed`, so it was NOT the zod-only leaf `registry.ts`'s header and that
// rule's own advice both called it. The write half now lives in
// `packages/twin-stripe/src/apply-seed.ts` and the rule ASSERTS the leaf claim
// for all five twins, so this import is checked rather than merely allowed.
export { seedSchema as slackSeedStateSchema } from "@pome-sh/twin-slack/seed";
export { seedSchema as stripeSeedStateSchema } from "@pome-sh/twin-stripe/seed";

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
  slackSeedSchema,
  linearSeedStateSchema,
  githubSeedStateSchema,
  stripeSeedSchema
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
export type StripeSeedState = z.infer<typeof stripeSeedSchema>;
export type SlackSeedState = z.infer<typeof slackSeedSchema>;
export type GmailSeedState = z.infer<typeof gmailSeedStateSchema>;
export type LinearSeedState = z.infer<typeof linearSeedStateSchema>;
export type SeedState = z.infer<typeof seedStateSchema>;
export type SeedEnvelope = z.infer<typeof seedEnvelopeSchema>;
export type Task = z.infer<typeof taskSchema>;
