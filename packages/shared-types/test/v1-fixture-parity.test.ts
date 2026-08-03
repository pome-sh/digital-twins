// SPDX-License-Identifier: Apache-2.0
//
// FDRS-613 / M8 — canonical /v1 wire fixture corpus.
//
// Every JSON fixture under `test/fixtures/v1/<schema>/` MUST parse successfully
// under the twins schema keyed by its directory name. pome-twins is the source
// of truth for this corpus; cloud consumers validate against the published
// package contract instead of mirroring source bytes. This is intentionally
// parse-only: it catches represented required fields, enum narrowing, and other
// fixture-level wire incompatibilities, but it is not a proof of whole-schema
// equality.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ZodTypeAny } from "zod";
import { describe, expect, it } from "vitest";
import {
  createSessionRequestSchema,
  createSessionResponseSchema,
  otelEventSchema,
  planTierSchema,
  usageResponseSchema,
} from "../src/index.js";
import type { OtelEvent } from "../src/index.js";
import { runSchema } from "../src/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, "fixtures", "v1");

// Directory name → schema. Keep in lockstep with fixtures/v1/README.md.
// `event/` is absent on purpose: it is the one nested corpus (one directory per
// event KIND) and gets its own describe block at the bottom of this file.
//
// The `*TaskVocab` dirs (FDRS-653) hold NEW-vocabulary payloads (task_name /
// task_source / criterion code|model). They are twins-only until the FDRS-654
// consumer swap. The original dirs keep their 0.3.0-era (scenario_*) payloads
// on purpose: they now double as tolerant-reader proof.
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

// FDRS-653 — the 0.3.0-era corpus must not just PARSE, it must NORMALIZE to
// the W3 task vocabulary; new-vocab fixtures must round-trip unchanged.
describe("/v1 fixture corpus — task-vocab normalization (FDRS-653)", () => {
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

// ─────────────────────────────────────────────────────────────────────────────
// F-1201 — the event-kind corpus.
//
// `fixtures/v1/event/<Kind>/` is the only place a member of the event union is
// described by a wire payload rather than by its own schema. Before F-1201 the
// corpus was 18 session/run/plan shapes and nothing else, so M1 shipped
// `LlmTurnEvent` with no fixture anywhere while `check:trace-contract` stayed
// green — it compared bytes that could not move.
//
// The requirement is now stated twice, deliberately in two different languages:
//
//   - `scripts/emit-trace-contract.mjs` enumerates the union FROM ZOD at emit
//     time and refuses to emit when a member has no fixture. That is the CI gate.
//   - `EVENT_KINDS_NEEDING_A_FIXTURE` states the same list to the TYPE checker.
//     It is keyed by `OtelEvent["kind"]`, so adding or renaming a union member
//     fails `npm run typecheck` until this map moves with it.
//
// Neither derivation can see the other's input, and the first test below asserts
// they agree — so a bug in the zod walk surfaces as a disagreement rather than
// as a quietly shorter list of required kinds.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_KINDS_NEEDING_A_FIXTURE: Record<OtelEvent["kind"], true> = {
  TwinHttpEvent: true,
  LlmCallEvent: true,
  ToolUseEvent: true,
  ToolResultEvent: true,
  SubagentSpawnEvent: true,
  HookEvent: true,
  LlmTurnEvent: true,
  OtelSpanEvent: true,
};

/** `<Kind>/<name>.json` pairs under `fixtures/v1/event/`. */
function readEventCorpus(): { kindDir: string; file: string; row: unknown }[] {
  const root = join(corpusRoot, "event");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(root, entry.name))
        .filter((file) => file.endsWith(".json"))
        .map((file) => ({
          kindDir: entry.name,
          file,
          row: JSON.parse(readFileSync(join(root, entry.name, file), "utf8")) as unknown,
        })),
    );
}

describe("/v1 event-kind corpus (F-1201)", () => {
  const corpus = readEventCorpus();
  const kinds = Object.keys(EVENT_KINDS_NEEDING_A_FIXTURE);

  it("agrees with the kind list trace-contract.json derived from the zod union", () => {
    const contract = JSON.parse(
      readFileSync(join(here, "..", "trace-contract.json"), "utf8"),
    ) as { eventKinds: Record<string, string[]> };
    expect(Object.keys(contract.eventKinds).sort()).toEqual([...kinds].sort());
  });

  for (const kind of kinds) {
    it(`${kind}: has at least one fixture`, () => {
      expect(corpus.filter((f) => f.kindDir === kind).map((f) => f.file)).not.toEqual([]);
    });
  }

  for (const { kindDir, file, row } of corpus) {
    it(`event/${kindDir}/${file} parses under otelEventSchema and is filed by its kind`, () => {
      const result = otelEventSchema.safeParse(row);
      if (!result.success) {
        throw new Error(
          `event/${kindDir}/${file} failed to parse:\n${JSON.stringify(result.error.issues, null, 2)}`,
        );
      }
      // A fixture's directory is its kind — otherwise the corpus could report
      // full coverage while every file in it described the same variant.
      expect(result.data.kind).toBe(kindDir);
    });
  }

  // The only event-row fixture on the 0.3.0 step vocabulary. Its normalization
  // is asserted here because `twinHttpEventSchema` alone does NOT normalize —
  // only the exported `eventSchema` / `otelEventSchema` readers do.
  it("a TwinHttpEvent row on the 0.3.0 vocab normalizes scenario_step_id → task_step_id", () => {
    const raw = JSON.parse(
      readFileSync(
        join(corpusRoot, "event/TwinHttpEvent/idempotent-replay-legacy-step-vocab.json"),
        "utf8",
      ),
    ) as { scenario_step_id: string };
    const parsed = otelEventSchema.parse(raw);
    expect(parsed.kind).toBe("TwinHttpEvent");
    if (parsed.kind !== "TwinHttpEvent") return;
    expect(parsed.task_step_id).toBe(raw.scenario_step_id);
    // Preserved as-sent: a re-serialized row still parses under a 0.3.0 reader.
    expect(parsed.scenario_step_id).toBe(raw.scenario_step_id);
  });
});
