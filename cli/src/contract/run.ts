// SPDX-License-Identifier: Apache-2.0
/**
 * run — completed-run shape, criterion result, lane/step correlator output
 *
 * Consumed by:
 *   - `@pome-sh/evaluator` — produces CriterionResult, satisfaction_score
 *   - `pome-cloud` correlator — produces `{ lanes, steps }` from RecorderEvent[]
 *   - `pome-cloud` `runs` table writer — persists the full Run row
 *   - dashboard `/runs/:id` — renders lane-timeline + state-inspector + handoff card
 *
 * Lane/Step are flat parallel arrays on Run (not nested), aligning with the
 * `runs.lanes jsonb` + `runs.steps jsonb` two-column DB shape.
 * Cross-reference: `Lane.step_id` → `Step.id`; `Lane.request_ids[]` →
 * `RecorderEvent.request_id`.
 */

import { z } from "zod";
import { twinIdSchema } from "@pome-sh/wire";
import { LEGACY_CRITERION_KIND_MAP, normalizeTaskVocabKeys } from "./task-vocab.js";

// Judge model is a free-form string (BYOK Flavor #1, OpenAI-compatible endpoint
// passes through); not constrained at the schema level because the customer's
// gateway decides what model identifiers it accepts.
export const judgeModelSchema = z.string().min(1);
export type JudgeModel = z.infer<typeof judgeModelSchema>;

// Which server-side correlator produced a run's lanes/steps. Reconciled from
// pome-cloud /v1: OTEL M4/M6 clients distinguish heuristic legacy
// timelines from exact span-context timelines.
export const correlatorKindSchema = z.enum([
  "heuristic",
  "adapter_rich",
  "span_context",
]);
export type CorrelatorKind = z.infer<typeof correlatorKindSchema>;

// Criterion kind: `code` = deterministic/code-checked
// predicate (formerly `D`), `model` = LLM-judged (formerly `P`). The canonical
// enum is `code | model`; the INPUT schema below additionally accepts the
// 0.3.0-era `D` / `P` spellings and normalizes them at parse time (tolerant
// reader — shipped CLIs vendor 0.3.0 and keep sending D/P).
export const CRITERION_KINDS = ["code", "model"] as const;
export const criterionKindSchema = z.enum(CRITERION_KINDS);
export type CriterionKind = z.infer<typeof criterionKindSchema>;

// Single source of truth for the D/P→code/model rename is
// LEGACY_CRITERION_KIND_MAP in ./task-vocab.ts.
const criterionKindInputSchema = z
  .enum(["D", "P", "code", "model"])
  .transform((kind): CriterionKind =>
    kind === "D" || kind === "P" ? LEGACY_CRITERION_KIND_MAP[kind] : kind,
  );

export const criterionSchema = z.object({
  // Accepts D | P | code | model; parsed output is always code | model.
  type: criterionKindInputSchema,
  text: z.string().min(1),
  // Multi-twin (M3): the twin this criterion attributes to. Rides through the
  // D/P→code/model transform above untouched. Absent = the run's primary twin
  // (the session's twins[0]). Additive — single-twin runs omit it.
  twin: z.string().min(1).optional(),
});
export type Criterion = z.infer<typeof criterionSchema>;

// CriterionResult shape matches OSS evaluator's emit. The full Criterion is
// included by reference (not just text) so consumers render type-aware UI
// without rejoining. Discriminate on `criterion.type` (no separate `kind`
// field) — normalized to `code` / `model` (0.3.0 artifacts carrying `D` / `P`
// parse and normalize).
const baseCriterionResultSchema = z.object({
  criterion: criterionSchema,                  // full {type, text} object
  passed: z.boolean(),
  skipped: z.boolean(),                        // true if [code] fell back to [model] but the judge was unreachable, etc.
  reason: z.string(),                          // human-readable evidence
  // Why this row is out of the denominator, when `skipped` alone is too coarse.
  // The two values that carry meaning here are `ADVISORY_SCORE_STATE` and
  // `ABSTAINED_SCORE_STATE` (`@pome-sh/wire/run-completeness`), which the
  // narrator stamps on a `[model]` row it read but had no authority to score.
  //
  // NOT NAMED `outcome`: `hosted/evalResultView.ts`'s display model has
  // reserved that key on this same object for a disjoint vocabulary
  // (`passed | failed | skipped | errored`) since long before the narrator, and
  // reserved it for the CLOUD to fill. A cloud writing `advisory` into it would
  // hand `outcomeOf` a value outside its own union and render an advisory row
  // with the skipped glyph.
  //
  // ON THE BASE AND NOT ON ONE ARM, for the mirror image of the reason the arm
  // order below is what it is: an advisory row carries no `confidence` /
  // `judge_model`, so it fails the probabilistic arm and lands on the
  // DETERMINISTIC one — whose `.extend({})` is a plain `z.object` and would
  // strip an unknown key. Declared on one arm, the state would be discarded
  // before any consumer could read it, and the run would keep reading
  // INCOMPLETE with the exemption sitting there correct and dead.
  //
  // `z.string()` AND NOT THE CLOSED ENUM pome-cloud declares for the same
  // field, because the two sides of it have opposite jobs. pome-cloud PRODUCES
  // it and validates what it serves; the CLI CONSUMES it, and
  // `finalizeResponseSchema` is deliberately a tolerant reader (its own comment
  // says so: cloud may emit additive keys "that older/newer CLIs strip rather
  // than reject"). A closed enum here would turn a cloud that adds a third
  // score state into a hard parse failure of the ENTIRE /finalize response —
  // an unreadable run instead of an unrecognised field. The closed vocabulary
  // is applied by the PREDICATE that reads it (`isNarrated`), exactly as
  // `reason` is a plain string and `PRE_SATISFIED_REASON` is a comparison, so
  // an unrecognised spelling is not exempted from anything.
  score_state: z.string().optional(),
});

export const deterministicCriterionResultSchema = baseCriterionResultSchema.extend({
  // [code] adds nothing further; criterion.type === "code" identifies it.
});
export type DeterministicCriterionResult = z.infer<typeof deterministicCriterionResultSchema>;

export const probabilisticCriterionResultSchema = baseCriterionResultSchema.extend({
  confidence: z.number().min(0).max(1),
  judge_model: judgeModelSchema,
});
export type ProbabilisticCriterionResult = z.infer<typeof probabilisticCriterionResultSchema>;

// Probabilistic FIRST: it's the strict superset (requires confidence +
// judge_model). z.union tries branches in order and picks the first match.
// If deterministic were first, [model] payloads would parse cleanly but
// .extend({}) would silently strip the [model]-only fields — we'd persist them
// as null in runs.criteria_results JSON, breaking dashboard rendering of
// confidence + per-criterion judge_model. [code] payloads (no confidence /
// judge_model) fail probabilistic on the required fields and fall through.
export const criterionResultSchema = z.union([
  probabilisticCriterionResultSchema,
  deterministicCriterionResultSchema,
]);
export type CriterionResult = z.infer<typeof criterionResultSchema>;

// Step is the correlator's top-level grouping: one Step per agent assistant
// turn (adapter-rich path) or per heuristic-clustered HTTP burst (heuristic
// path). started_at/ended_at bound the contained events. label is null when
// heuristic-only (no assistant message to seed it from).
export const stepSchema = z.object({
  id: z.string(),                              // matches RecorderEvent.step_id
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  label: z.string().nullable(),
  lane_ids: z.array(z.string()),               // child lanes, render order
});
export type Step = z.infer<typeof stepSchema>;

// Lane is the correlator's per-step sub-grouping by twin + endpoint pattern.
// One lane = one horizontal track in lane-timeline UI. request_ids reference
// RecorderEvent.request_id back into events.jsonl (events are the source of
// truth; Lane just records which events belong here, time-ordered).
export const laneSchema = z.object({
  id: z.string(),
  step_id: z.string(),                         // parent Step.id
  twin: twinIdSchema,                          // matches RecorderEvent.twin
  label: z.string().nullable(),                // e.g. "POST /v1/refunds (3 calls)"
  request_ids: z.array(z.string()),            // RecorderEvent.request_id, time-ordered
});
export type Lane = z.infer<typeof laneSchema>;

// Canonical Run row. Task vocab: `task_name` / `task_hash` /
// `promoted_task_id` are the canonical wire keys (cloud DB: `tasks` table,
// `runs.task_name`). The exported `runSchema` below wraps this object in the
// tolerant-reader preprocess so 0.3.0-era rows carrying `scenario_name` /
// `scenario_hash` / `promoted_scenario_id` parse and normalize.
const runObjectSchema = z.object({
  id: z.string(),                              // run_<nanoid>
  session_id: z.string(),
  team_id: z.string(),
  task_name: z.string(),                       // 0.3.0 alias: scenario_name
  task_hash: z.string(),                       // sha256 of source markdown; 0.3.0 alias: scenario_hash
  satisfaction_score: z.number().int().min(0).max(100),  // CLI-computed (BYOK Flavor #1)
  criteria_results: z.array(criterionResultSchema),
  trace_s3_key: z.string().nullable(),         // s3 key for events.jsonl (hosted only)
  state_s3_key: z.string().nullable(),         // s3 key for state_final.json
  meta_s3_key: z.string().nullable(),
  duration_ms: z.number().int(),
  agent_model: z.string(),                     // which model the agent used (informational)
  judge_model: judgeModelSchema,               // which model judged [model] criteria (free-form)
  judge_tokens_in: z.number().int().min(0).nullable(),
  judge_tokens_out: z.number().int().min(0).nullable(),
  // ── Reconciled from pome-cloud /v1 wire truth (all additive with
  // defaults so pre-existing Run constructors stay valid) ────────────────────
  // Sim deep-telemetry — per-run agent telemetry rollup, computed at finalize
  // from the agent's independently-correlated `gen_ai` span tree. Null = no
  // instrumentation / legacy / twin-only sim (dashboard renders `·`, never `0`).
  agent_tokens_in: z.number().int().min(0).nullable().default(null),
  agent_tokens_out: z.number().int().min(0).nullable().default(null),
  agent_latency_p50_ms: z.number().int().min(0).nullable().default(null),
  agent_latency_p95_ms: z.number().int().min(0).nullable().default(null),
  agent_latency_max_ms: z.number().int().min(0).nullable().default(null),
  agent_error_count: z.number().int().min(0).nullable().default(null),
  agent_telemetry_span_count: z.number().int().min(0).nullable().default(null),
  // Which server-side correlator produced lanes/steps.
  correlator_kind: correlatorKindSchema.default("heuristic"),
  // M0.2 — which surface this run belongs to. 'simulation' =
  // CLI/staging scenario run (default for every legacy row); 'production' = an
  // ingested OTLP production trace (M2).
  environment: z.enum(["production", "simulation"]).default("simulation"),
  // M0.5 — replay loop linkage (prod-run → task → replay-run).
  // Canonical key; 0.3.0 alias: promoted_scenario_id.
  promoted_task_id: z.string().nullable().default(null),
  replay_run_id: z.string().nullable().default(null),
  // Storage key for the tar-and-upload state archive the replay engine seeds a
  // sandbox from. Null when no archive was captured.
  state_archive_s3_key: z.string().nullable().default(null),
  // Correlator output. Empty arrays for legacy runs (pre-M3i / pre-M4-1).
  lanes: z.array(laneSchema).default([]),
  steps: z.array(stepSchema).default([]),
  // Server-generated by the managed judge (ADR-013). 1-2 sentence concise
  // narrative of the run. Null for pre-ADR-013 rows / legacy /result runs.
  summary: z.string().nullable().default(null),
  // Originally CLI-generated (BYOK Flavor #1). Null on --no-fix-prompt opt-out,
  // LLM endpoint failure, or legacy pre-M4-1 runs.
  fix_prompt: z.string().nullable().default(null),
  // Storage KEY (path) of the raw events.jsonl blob — NOT a URL (dashboard mints
  // a signed GET URL on read). Relaxed from `.url()` to match the
  // pome-cloud shape, since persisted storage keys are not URLs. Null in
  // self-host mode, on upload failure, --no-upload opt-out, or legacy runs.
  events_jsonl_url: z.string().nullable().default(null),
  created_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable(),
});

// Tolerant reader: accepts both the 0.3.0 `scenario_*` and the
// canonical `task_*` keys and normalizes to the new vocabulary. When both are
// present, the canonical key wins. The parsed output carries `task_*` only.
export const runSchema = z.preprocess(normalizeTaskVocabKeys, runObjectSchema);
export type Run = z.infer<typeof runSchema>;
