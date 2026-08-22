// SPDX-License-Identifier: Apache-2.0
//
// F-1201 — the event-kind corpus (the wire half of the former
// shared-types `v1-fixture-parity.test.ts`; the session/run/plan/usage half
// moved with its schemas to `cli/test/unit/wire/v1-fixture-parity.test.ts`).
//
// `test/fixtures/v1/event/<Kind>/` is the only place a member of the event union
// is described by a wire payload rather than by its own schema. Before F-1201
// the corpus was 18 session/run/plan shapes and nothing else, so M1 shipped
// `LlmTurnEvent` with no fixture anywhere while `check:trace-contract` stayed
// green — it compared bytes that could not move.
//
// The requirement is stated twice, deliberately in two different languages:
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
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { otelEventSchema } from "../src/index.js";
import type { OtelEvent } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(here, "fixtures", "v1");

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
