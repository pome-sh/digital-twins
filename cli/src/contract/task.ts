// SPDX-License-Identifier: Apache-2.0
//
// contract §3 — TASKS. Task config, the parsed task markdown shape, and the
// persisted task row, plus their deprecated `scenario*` aliases. The provider
// seed-state schemas consumed by `taskSchema.seedState` live in `./seed-state.ts`.
// Re-exported through the `cli/src/contract` barrel (index.ts).

import { z } from "zod";
import { criterionSchema, judgeModelSchema } from "./run.js";
import { seedStateSchema } from "./seed-state.js";

// ─────────────────────────────────────────────────────────────────────────────
// 3. TASKS (formerly "scenarios") — originally adopted verbatim from
//    oslo/pome/src/scenario/scenarioSchema.ts
//
// Task vocab: "task" is the canonical name; the `scenario*` exports
// below are deprecated aliases kept for the 0.3.0 window.
//
// `criterionSchema` and `judgeModelSchema` were moved to `./run.ts` (2026-05-11
// split) because CriterionResult depends on them; imported here from `./run.js`
// and re-exported to consumers via the index.ts barrel.
// ─────────────────────────────────────────────────────────────────────────────

// Which POPULATION a task belongs to, declared in its `## Config`
// block. Three values, and the line between the first and the other two is what
// the field exists for:
//
//   conformance  correct behaviour is "call the endpoints and do the obvious
//                thing". No planted hazard, and no restraint carries the
//                verdict. These answer "does the twin answer correctly", not
//                "is the agent any good" — they are the de-facto twin smoke
//                test, and a scored average that includes them cannot be read:
//                a rising number is either agents improving or more plumbing
//                questions being added, and nothing tells those apart.
//   restraint    the verdict rests on NOT doing something, with no antagonist.
//   adversarial  a planted antagonist — injection, spoof, persuasion, backdoor,
//                exfiltration bait, fabrication pressure, a dedup trap.
//
// `restraint` + `adversarial` are the EXAM population, which is what pome-cloud
// pins its scored denominators against.
//
// OPTIONAL, and deliberately so. Absence is legal — a task written by a builder
// for their own agent is not part of this corpus and owes it no taxonomy — but
// a value OUTSIDE the three is an error rather than a silently-stripped key, so
// a typo in the vocabulary is caught where it is written. Presence is a
// separate, stricter rule that applies only to the tasks this repo ships, and
// it is enforced by `scripts/lint-task-class.mjs` rather than here.
export const taskClassSchema = z.enum(["conformance", "restraint", "adversarial"]);
export type TaskClass = z.infer<typeof taskClassSchema>;

export const taskConfigSchema = z.object({
  twins: z.array(z.string()).default(["github"]),
  class: taskClassSchema.optional(),                        // conformance vs the exam half
  timeout: z.number().int().positive().default(60),         // seconds
  runs: z.number().int().positive().default(1),
  passThreshold: z.number().min(0).max(100).default(100),
  judge: judgeModelSchema.default("claude-haiku-4-5"),       // CLI's BYOK config decides which endpoint serves this
});
export type TaskConfig = z.infer<typeof taskConfigSchema>;

/** @deprecated Use `taskConfigSchema`. Removed after the 0.3.0 window. */
export const scenarioConfigSchema = taskConfigSchema;
/** @deprecated Use `TaskConfig`. */
export type ScenarioConfig = TaskConfig;

// The parsed task (formerly "scenario") markdown shape. Criterion kinds inside
// `criteria` normalize D→code, P→model (tolerant reader).
export const taskSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  setup: z.string().default(""),               // human-readable prose; ignored at runtime
  prompt: z.string().min(1),
  expectedBehavior: z.string().default(""),    // evaluator-only, NEVER sent to agent
  criteria: z.array(criterionSchema).min(1),
  config: taskConfigSchema,
  seedState: seedStateSchema,
});
export type Task = z.infer<typeof taskSchema>;

/** @deprecated Use `taskSchema`. Removed after the 0.3.0 window. */
export const scenarioSchema = taskSchema;
/** @deprecated Use `Task`. */
export type Scenario = Task;

// Persisted Task row (dashboard upload path; cloud DB `tasks` table). Per
// 04-data-model.md. Row ids keep the historical `scn_` prefix (persisted data;
// renaming ids is a data migration, deliberately out of scope for the rename).
export const persistedTaskSchema = z.object({
  id: z.string(),                              // scn_<nanoid>
  team_id: z.string(),
  name: z.string(),
  source: z.string(),                          // raw markdown
  source_hash: z.string(),                     // sha256(source)
  uploaded_by: z.string(),                     // user_id
  created_at: z.string().datetime(),
  archived_at: z.string().datetime().nullable(),
});
export type PersistedTask = z.infer<typeof persistedTaskSchema>;

/** @deprecated Use `persistedTaskSchema`. Removed after the 0.3.0 window. */
export const persistedScenarioSchema = persistedTaskSchema;
/** @deprecated Use `PersistedTask`. */
export type PersistedScenario = PersistedTask;
