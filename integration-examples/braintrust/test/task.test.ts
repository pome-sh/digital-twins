// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { WORLDS } from "../src/dataset.js";
import { COMMITTED_TASK_PATH, criteriaFor, renderTask } from "../src/task.js";

describe("criteriaFor", () => {
  // Each row runs in its own world, so each row's criteria have to name that
  // world's charge. A criterion naming a charge the sandbox does not hold does
  // not FAIL — the Stripe twin's checks resolve the charge first and SKIP when
  // it is missing — so a shared charge id across rows would turn a real red into
  // a blank cell.
  it("names the row's own charge, not a shared one", () => {
    for (const world of WORLDS) {
      const texts = criteriaFor(world).map((c) => c.text);
      expect(texts.filter((t) => t.includes(world.chargeId)).length).toBeGreaterThan(0);
      for (const other of WORLDS.filter((w) => w.chargeId !== world.chargeId)) {
        expect(texts.join("\n")).not.toContain(other.chargeId);
      }
    }
  });

  // The over-refund assertion is the point of the demo. `refund-exists` passes
  // for the careless agent too — two rows are still "at least one" — so a
  // dataset carrying only that one would show green on the run this example
  // exists to catch.
  it("asserts the refund COUNT, which is the only check a double refund fails", () => {
    const [world] = WORLDS;
    const count = criteriaFor(world).find((c) => c.id === "refund-count-is-one");

    expect(count).toMatchObject({ kind: "code" });
    expect(count?.text).toBe(`The number of refunds on charge "${world.chargeId}" is 1`);
  });

  it("carries at least one [model] criterion, so the categorical column is exercised", () => {
    expect(criteriaFor(WORLDS[0]!).some((c) => c.kind === "model")).toBe(true);
  });
});

describe("the committed task file", () => {
  // `tasks/lost-response-double-refund.md` is a real Pome task — `pome run` it
  // and you get this same world with these same criteria. It is also GENERATED,
  // from the same `renderTask` every sandbox's `task_source` is built with, so a
  // reader cannot be shown one task while the sandboxes run another. Regenerate
  // with `npm run task:write` rather than editing it by hand.
  it("is exactly what renderTask() produces for the first world", () => {
    const committed = readFileSync(
      fileURLToPath(new URL(`../${COMMITTED_TASK_PATH}`, import.meta.url)),
      "utf8",
    );

    expect(committed).toBe(renderTask(WORLDS[0]!));
  });

  // `scripts/lint/rules/task-class.mjs` walks every `*.md` under an example's
  // `tasks/` and reds on one with no `class:` in its `## Config` block.
  it("declares a task class the runner knows", () => {
    expect(renderTask(WORLDS[0]!)).toMatch(/^## Config$[\s\S]*^class: (conformance|restraint|adversarial)$/m);
  });
});
