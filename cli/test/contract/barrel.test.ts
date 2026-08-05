// SPDX-License-Identifier: Apache-2.0
//
// The barrel re-export identity is load-bearing: consumers import from
// `cli/src/contract/index.ts`, not from the leaf files. If a re-export drifts
// (e.g. someone copies a schema into index.ts instead of re-exporting),
// these tests fail. Zod schemas must be referentially identical across the
// barrel and the leaf — otherwise discriminated unions and `instanceof`
// checks downstream silently break.

import { describe, expect, it } from "vitest";
import * as wire from "@pome-sh/wire";
import * as hub from "../../src/types/shared.js";
import * as barrel from "../../src/contract/index.js";
import * as run from "../../src/contract/run.js";

// F-942 — the recorder-events / otel / redaction leaves moved to
// `@pome-sh/wire`, so the contract barrel no longer carries them; their
// leaf-vs-barrel identity is guarded in
// `packages/wire/test/export-surface.test.ts`. What has to be proven HERE is the
// seam the CLI actually imports through: `src/types/shared.ts` merges two
// `export *`s, and a second zod copy behind either one would break every
// discriminated union in the recorder without breaking a type.
describe("src/types/shared.ts hub preserves identity across both halves", () => {
  it("re-exports @pome-sh/wire's schemas by reference", () => {
    expect(hub.recorderEventSchema).toBe(wire.recorderEventSchema);
    expect(hub.recorderFidelitySchema).toBe(wire.recorderFidelitySchema);
    expect(hub.twinIdSchema).toBe(wire.twinIdSchema);
    expect(hub.stateDeltaSchema).toBe(wire.stateDeltaSchema);
    expect(hub.otelEventSchema).toBe(wire.otelEventSchema);
    expect(hub.redactSecrets).toBe(wire.redactSecrets);
  });

  it("re-exports the contract barrel's schemas by reference", () => {
    expect(hub.runSchema).toBe(barrel.runSchema);
    expect(hub.manifestSchema).toBe(barrel.manifestSchema);
    expect(hub.createSessionRequestSchema).toBe(barrel.createSessionRequestSchema);
  });

  it("the two halves do not collide (every name resolves to exactly one owner)", () => {
    const overlap = Object.keys(wire).filter((name) => name in barrel);
    expect(overlap).toEqual([]);
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
