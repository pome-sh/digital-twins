// SPDX-License-Identifier: Apache-2.0
// M8 — canonical /v1 wire fixture corpus (the cloud control-plane half; the event-kind
// half is `packages/wire/test/v1-event-corpus.test.ts`).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ZodTypeAny } from "zod";
import { describe, expect, it } from "vitest";
import {
  createSessionRequestSchema,
  createSessionResponseSchema,
  planTierSchema,
  usageResponseSchema,
} from "../../../src/contract/index.js";
import { runSchema } from "../../../src/contract/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, "..", "..", "fixtures", "contract", "v1");

// Directory name → schema. Keep in lockstep with fixtures/contract/v1/README.md.
const SCHEMA_BY_DIR: Record<string, ZodTypeAny> = {
  planTier: planTierSchema,
  createSessionRequest: createSessionRequestSchema,
  createSessionRequestTaskVocab: createSessionRequestSchema,
  createSessionResponse: createSessionResponseSchema,
  usage: usageResponseSchema,
  run: runSchema,
  runTaskVocab: runSchema,
};

describe("/v1 fixture-corpus parity (twins schema)", () => {
  for (const [dir, schema] of Object.entries(SCHEMA_BY_DIR)) {
    const dirPath = join(corpusRoot, dir);
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".json"));

    it(`${dir}: has at least one fixture`, () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
      it(`${dir}/${file} parses under the twins schema`, () => {
        const raw = JSON.parse(readFileSync(join(dirPath, file), "utf8"));
        const result = schema.safeParse(raw);
        if (!result.success) {
          throw new Error(
            `${dir}/${file} failed to parse:\n${JSON.stringify(result.error.issues, null, 2)}`,
          );
        }
        expect(result.success).toBe(true);
      });
    }
  }
});

// The 0.3.0-era corpus must not just PARSE, it must NORMALIZE to
// the task vocabulary; new-vocab fixtures must round-trip unchanged.
describe("/v1 fixture corpus — task-vocab normalization", () => {
  const readFixture = (dir: string, file: string) =>
    JSON.parse(readFileSync(join(corpusRoot, dir, file), "utf8"));

  it("0.3.0 run fixtures normalize scenario_* → task_* (old keys dropped)", () => {
    for (const file of ["legacy-minimal.json", "full-production.json"]) {
      const raw = readFixture("run", file);
      const parsed = runSchema.parse(raw);
      expect(parsed.task_name).toBe(raw.scenario_name);
      expect(parsed.task_hash).toBe(raw.scenario_hash);
      expect(parsed).not.toHaveProperty("scenario_name");
      expect(parsed).not.toHaveProperty("scenario_hash");
      expect(parsed).not.toHaveProperty("promoted_scenario_id");
      if (raw.promoted_scenario_id !== undefined) {
        expect(parsed.promoted_task_id).toBe(raw.promoted_scenario_id);
      }
    }
  });

  it("0.3.0 run fixture criterion kinds normalize D→code, P→model", () => {
    const raw = readFixture("run", "full-production.json");
    const parsed = runSchema.parse(raw);
    const kinds = parsed.criteria_results.map((r) => r.criterion.type);
    expect(kinds).toEqual(["model"]); // fixture carries a single P criterion
    expect(kinds.every((k) => k === "code" || k === "model")).toBe(true);
  });

  it("new-vocab run fixture round-trips (task_* keys and code|model preserved)", () => {
    const raw = readFixture("runTaskVocab", "full-production-task-vocab.json");
    const parsed = runSchema.parse(raw);
    expect(parsed.task_name).toBe(raw.task_name);
    expect(parsed.task_hash).toBe(raw.task_hash);
    expect(parsed.promoted_task_id).toBe(raw.promoted_task_id);
    expect(parsed.criteria_results.map((r) => r.criterion.type)).toEqual([
      "model",
      "code",
    ]);
    // Re-parse of the serialized output is stable (idempotent normalization).
    expect(runSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("0.3.0 createSessionRequest fixtures normalize scenario_source/scenario_id → task_*", () => {
    const bySource = createSessionRequestSchema.parse(
      readFixture("createSessionRequest", "scenario-source-github.json"),
    );
    expect(bySource.task_source).toBeDefined();
    expect(bySource).not.toHaveProperty("scenario_source");

    const byId = createSessionRequestSchema.parse(
      readFixture("createSessionRequest", "stored-scenario.json"),
    );
    expect(byId.task_id).toBe("scn_abc123");
    expect(byId).not.toHaveProperty("scenario_id");
  });
});
