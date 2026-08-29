// SPDX-License-Identifier: Apache-2.0
// Verdict rendering per the design of record (CLI moments moment 01): words not
// scores, errored rows show no duration, the summary fraction excludes errored.
import { describe, expect, it } from "vitest";
import {
  reassuranceBox,
  summaryLines,
  trialLine,
  trialsHeaderLine,
  twinReadyLine,
  type TrialVerdict,
} from "../../../src/demo/render.js";
import { capacityLabel } from "../../../src/demo/capacity.js";
import {
  criterionPhrase,
  type CriterionResult,
} from "../../../src/hosted/evalResultView.js";

/** A scored trial — the shape every fraction-only assertion below needs and
 *  nothing more. */
const scored = (kind: "passed" | "failed", seconds: number): TrialVerdict =>
  ({
    kind,
    seconds,
    checks: { passed: kind === "passed" ? 2 : 1, total: 2 },
    ...(kind === "failed" ? { note: "n" } : {}),
  }) as TrialVerdict;

const advisoryRow = (text: string): CriterionResult => ({
  criterion: { type: "model", text },
  passed: false,
  skipped: true,
  reason: "1. The trace shows one POST to /issues/1/labels. 2. Therefore …",
  score_state: "advisory",
});

describe("reassurance box", () => {
  it("keeps the copy of record verbatim and names all three surfaces honestly", () => {
    const box = reassuranceBox().join("\n");
    expect(box).toContain("pome demo · running locally");
    // [DECISION] #5 — verbatim.
    expect(box).toContain("No signup. No API keys.");
    expect(box).toContain("Your repo and your data are never touched.");
    // The honest line: local twin, anonymous gateway, cloud evaluation.
    expect(box).toMatch(/twin runs on your machine/i);
    expect(box).toMatch(/anonymous demo gateway/i);
    expect(box).toMatch(/evaluated in pome cloud/i);
    // The reconciled copy must NOT resurrect the pre-decision claims.
    expect(box).not.toMatch(/runs entirely on your machine/i);
    expect(box).not.toMatch(/zero real API calls/i);
  });

  it("draws a closed border", () => {
    const lines = reassuranceBox();
    expect(lines[0]).toMatch(/^┌─+┐$/);
    expect(lines[lines.length - 1]).toMatch(/^└─+┘$/);
    for (const middle of lines.slice(1, -1)) {
      expect(middle.startsWith("│")).toBe(true);
      expect(middle.endsWith("│")).toBe(true);
    }
  });
});

describe("progress lines", () => {
  it("renders the twin + trials header lines per design", () => {
    expect(twinReadyLine(1.234)).toBe("spinning up github twin … ready (1.2s)");
    expect(trialsHeaderLine(5, "first-run-demo")).toBe(
      "running 5 isolated trials of first-run-demo …",
    );
  });
});

describe("trial verdict lines", () => {
  it("passed / failed use words + duration + the deterministic denominator", () => {
    // The fraction is the `[code]` denominator, and naming it is what makes
    // the narrator lines beneath legible as something other than a shortfall:
    // 2 of 2 checks passed, and three rows nobody scored sit beside them.
    expect(
      trialLine(1, { kind: "passed", seconds: 14.31, checks: { passed: 2, total: 2 } }),
    ).toBe("trial 1  ✓  passed   14.3s  2 of 2 checks");
    expect(
      trialLine(3, {
        kind: "failed",
        seconds: 15.94,
        note: "the comment never names the failing endpoint",
        checks: { passed: 1, total: 2 },
      }),
    ).toBe(
      "trial 3  ✗  failed   15.9s  1 of 2 checks  the comment never names the failing endpoint",
    );
  });

  it("counts checks, never a score", () => {
    // `2 of 2 checks` is a count of `[code]` criteria, not the 0-100 the
    // demo's design of record keeps off this surface.
    const line = trialLine(1, {
      kind: "passed",
      seconds: 14.31,
      checks: { passed: 2, total: 2 },
    });
    expect(line).not.toMatch(/\/100|\d+%/);
  });

  it("errored shows no duration and is marked excluded", () => {
    const line = trialLine(5, { kind: "errored", reason: "trial timed out" });
    expect(line).toBe("trial 5  ⚠  errored         trial timed out — excluded");
    expect(line).not.toMatch(/\d+\.\d+s/);
  });

  it("never renders a numeric score", () => {
    for (const line of [scored("passed", 2), scored("failed", 2)].map((v, i) =>
      trialLine(i + 1, v),
    )) {
      expect(line).not.toMatch(/\/100|\d+%/);
    }
  });
});

describe("summary", () => {
  it("excludes errored trials from the fraction and names the errored reason", () => {
    const lines = summaryLines({
      verdicts: [
        scored("passed", 14.3),
        scored("passed", 12.1),
        scored("failed", 15.9),
        scored("failed", 13.5),
        { kind: "errored", reason: "gateway timeout" },
      ],
      failingCriterionPhrase: "the comment never names the failing endpoint",
      failingCriterionCount: 2,
      previewUrl: "https://app.pome.sh/demo/grp_abc123",
    });
    expect(lines[0]).toBe("─────");
    expect(lines[1]).toBe(
      "2 of 4 passed · 1 trial errored on gateway timeout, excluded from the fraction",
    );
    expect(lines[2]).toBe(
      "the comment never names the failing endpoint in 2 of 4 — start there",
    );
    expect(lines[3]).toBe("see the full breakdown — read-only, still no account:");
    expect(lines[4]).toBe("→ https://app.pome.sh/demo/grp_abc123");
  });

  it("renders a clean fraction when nothing errored", () => {
    const lines = summaryLines({
      verdicts: [
        scored("passed", 1),
        scored("passed", 1),
        scored("passed", 1),
        scored("failed", 1),
        scored("passed", 1),
      ],
      previewUrl: "https://app.pome.sh/demo/grp_x",
    });
    expect(lines[1]).toBe("4 of 5 passed");
    expect(lines.join("\n")).toContain("→ https://app.pome.sh/demo/grp_x");
  });

  it("omits the start-there line when nothing failed", () => {
    const lines = summaryLines({
      verdicts: [scored("passed", 1), scored("passed", 1)],
      previewUrl: "https://app.pome.sh/demo/grp_x",
    });
    expect(lines.join("\n")).not.toContain("start there");
  });

  it("states honestly when no trial produced a verdict (no preview link)", () => {
    const lines = summaryLines({
      verdicts: [
        { kind: "errored", reason: "trial timed out" },
        { kind: "errored", reason: "trial timed out" },
      ],
      previewUrl: "https://app.pome.sh/demo/grp_x",
    });
    expect(lines[1]).toBe(
      "no trials were evaluated · 2 trials errored on trial timed out, excluded from the fraction",
    );
    expect(lines.join("\n")).not.toContain("app.pome.sh/demo");
  });

  // F-1754 — the narrator's rows are what the demo exists to SHOW: an advisory
  // reading beside a deterministic fraction. This surface printed neither.
  it("prints the narrator's readings once, beside the fraction", () => {
    const lines = summaryLines({
      verdicts: [scored("passed", 1), scored("passed", 1)],
      // Two trials of the same task — the same three criteria, twice.
      narrated: [
        advisoryRow("The `bug` label went to the 500-error issue and no other."),
        advisoryRow("No other issue was modified and no new label was created."),
        advisoryRow("The `bug` label went to the 500-error issue and no other."),
        advisoryRow("No other issue was modified and no new label was created."),
      ],
      previewUrl: "https://app.pome.sh/demo/grp_x",
    });
    expect(lines[1]).toBe("2 of 2 passed");
    // Deduped: the criteria belong to the task, not to a trial.
    expect(lines[2]).toBe("the narrator also read these, and scored none of them:");
    expect(lines[3]).toBe(
      "  ~ advisory · the `bug` label went to the 500-error issue and no other",
    );
    expect(lines[4]).toBe(
      "  ~ advisory · no other issue was modified and no new label was created",
    );
    expect(lines[5]).toBe("see the full breakdown — read-only, still no account:");
    // Not a shortfall and not a gap.
    for (const line of lines.slice(2, 5)) {
      expect(line).not.toMatch(/[✓✗⚠]/);
      expect(line).not.toMatch(/^\s*- /);
    }
    // The narrator's prose belongs on the share page.
    expect(lines.join("\n")).not.toContain("The trace shows one POST");
  });

  it("says nothing about the narrator when a run has no narrated rows", () => {
    const lines = summaryLines({
      verdicts: [scored("passed", 1)],
      previewUrl: "https://app.pome.sh/demo/grp_x",
    });
    expect(lines.join("\n")).not.toContain("narrator");
    expect(lines.join("\n")).not.toContain("~");
  });
});

describe("criterionPhrase", () => {
  it("takes the first clause, lower-cases the lead, caps length", () => {
    const phrase = criterionPhrase(
      "Exactly one comment was left on that issue, and it names the failing endpoint (POST /orders). Something else.",
    );
    expect(phrase.startsWith("exactly one comment was left on that issue")).toBe(true);
    expect(phrase).not.toContain("Something else");
    expect(phrase.length).toBeLessThanOrEqual(64);
    expect(phrase.endsWith("…")).toBe(true);
  });

  it("passes short criteria through intact (minus casing)", () => {
    expect(criterionPhrase("No new label was created.")).toBe(
      "no new label was created",
    );
  });
});

describe("at-capacity labels", () => {
  it("labels every kind honestly, never a stack trace", () => {
    expect(capacityLabel("daily_model_cap")).toMatch(/daily model budget .* try again tomorrow/);
    expect(capacityLabel("daily_judge_cap")).toMatch(/evaluation budget .* try again tomorrow/);
    expect(capacityLabel("demo_ip_llm_cap")).toMatch(/limit for this network/);
    expect(capacityLabel("demo_ip_mint_cap")).toMatch(/limit for this network/);
    expect(capacityLabel("session_llm_call_cap")).toMatch(/model-call ceiling/);
    expect(capacityLabel("unknown_capacity")).toBe(
      "the demo is at capacity today — try again tomorrow",
    );
    expect(capacityLabel("gateway_unavailable")).toMatch(/unavailable right now/);
  });
});
