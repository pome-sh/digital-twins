// SPDX-License-Identifier: Apache-2.0
//
// The packaged demo task has to be GRADABLE, not merely well-formed.
//
// F-1749: `first-run-demo` shipped three `[model]` criteria and zero `[code]`.
// That parsed, bound and rendered fine — and since the narrator flip took
// `[model]` out of the score denominator it left `total_required === 0`, so
// every trial of the advertised zero-auth door reported "cloud could not
// evaluate the trace". The task was never wrong; it was unscoreable.
//
// So the assertion this file exists to make is about the DENOMINATOR: the
// packaged task must declare at least one `[code]` criterion, and every one it
// declares must bind to a check the graders already publish. A criterion that
// binds nothing is the same zero denominator wearing a different hat.
//
// The other half — that the bundled agent's correct walk actually SATISFIES
// these criteria against the twin's exported state — cannot be read off the
// markdown and is asserted in `test/e2e/demo-e2e.test.ts`, where the real twin,
// the real agent and the real capture path run.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { auditCodeCriteria } from "../../../src/cli/criterion-binding.js";
import { DEMO_TASK_NAME, demoTaskPath } from "../../../src/demo/task.js";
import { parseTask } from "../../../src/task/parseTask.js";

async function packagedDemoTask() {
  const markdown = await readFile(demoTaskPath(), "utf8");
  const sidecar = JSON.parse(
    await readFile(demoTaskPath().replace(/\.md$/, ".seed.json"), "utf8"),
  ) as unknown;
  return { markdown, task: parseTask(markdown, DEMO_TASK_NAME, sidecar) };
}

describe("packaged first-run-demo task — scoreability (F-1749)", () => {
  it("declares at least one [code] criterion, so a graded trial has a denominator", async () => {
    const { task } = await packagedDemoTask();
    const code = task.criteria.filter((c) => c.type === "code");
    expect(code.length).toBeGreaterThan(0);
  });

  it("binds every [code] criterion to an already-published check", async () => {
    const { markdown } = await packagedDemoTask();
    const audit = auditCodeCriteria(markdown);
    // `findings` is the unbound/corrupted set — a criterion in it grades
    // nothing, which is the defect this file guards against.
    expect(audit.findings).toEqual([]);
    expect(audit.unanswerable).toEqual([]);
    expect(audit.bound).toBeGreaterThan(0);
  });

  it("keeps the three [model] criteria — the advisory narrative the demo exists to show", async () => {
    const { task } = await packagedDemoTask();
    const model = task.criteria.filter((c) => c.type === "model");
    expect(model).toHaveLength(3);
  });

  // The [code] rows come first so the demo share page reads a deterministic
  // fraction before the advisory prose that qualifies it.
  it("lists the [code] criteria ahead of the [model] ones", async () => {
    const { task } = await packagedDemoTask();
    const kinds = task.criteria.map((c) => c.type);
    expect(kinds).toEqual([...kinds].sort((a, b) => (a === b ? 0 : a === "code" ? -1 : 1)));
  });
});
