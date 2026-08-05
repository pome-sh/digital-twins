// SPDX-License-Identifier: Apache-2.0
//
// The barrel re-export identity is load-bearing: consumers import from
// `@pome-sh/shared-types`, not from the leaf files. If a re-export drifts
// (e.g. someone copies a schema into index.ts instead of re-exporting),
// these tests fail. Zod schemas must be referentially identical across the
// barrel and the leaf — otherwise discriminated unions and `instanceof`
// checks downstream silently break.

import { describe, expect, it } from "vitest";
import * as wire from "@pome-sh/wire";
import * as barrel from "../src/index.js";
import * as run from "../src/run.js";

// F-942 — the recorder-events / otel / redaction leaves moved to
// `@pome-sh/wire`; their leaf-vs-barrel identity is guarded in
// `packages/wire/test/export-surface.test.ts`. What this barrel must still prove
// is that re-exporting them through a PACKAGE boundary preserves identity —
// otherwise a second zod copy would break every discriminated union downstream.
describe("index.ts barrel re-exports @pome-sh/wire (same identity)", () => {
  it("re-exports recorderEventSchema", () => {
    expect(barrel.recorderEventSchema).toBe(wire.recorderEventSchema);
  });
  it("re-exports recorderFidelitySchema", () => {
    expect(barrel.recorderFidelitySchema).toBe(wire.recorderFidelitySchema);
  });
  it("re-exports twinIdSchema", () => {
    expect(barrel.twinIdSchema).toBe(wire.twinIdSchema);
  });
  it("re-exports stateDeltaSchema", () => {
    expect(barrel.stateDeltaSchema).toBe(wire.stateDeltaSchema);
  });
});

describe("index.ts barrel re-exports from run.ts", () => {
  it("re-exports runSchema (same identity)", () => {
    expect(barrel.runSchema).toBe(run.runSchema);
  });
  it("re-exports laneSchema", () => {
    expect(barrel.laneSchema).toBe(run.laneSchema);
  });
  it("re-exports stepSchema", () => {
    expect(barrel.stepSchema).toBe(run.stepSchema);
  });
  it("re-exports criterionResultSchema", () => {
    expect(barrel.criterionResultSchema).toBe(run.criterionResultSchema);
  });
  it("re-exports deterministicCriterionResultSchema", () => {
    expect(barrel.deterministicCriterionResultSchema).toBe(
      run.deterministicCriterionResultSchema
    );
  });
  it("re-exports probabilisticCriterionResultSchema", () => {
    expect(barrel.probabilisticCriterionResultSchema).toBe(
      run.probabilisticCriterionResultSchema
    );
  });
  it("re-exports criterionSchema (moved into run.ts)", () => {
    expect(barrel.criterionSchema).toBe(run.criterionSchema);
  });
  it("re-exports judgeModelSchema (moved into run.ts)", () => {
    expect(barrel.judgeModelSchema).toBe(run.judgeModelSchema);
  });
});
