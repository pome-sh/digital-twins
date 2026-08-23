// SPDX-License-Identifier: Apache-2.0
// Pure terminal rendering for `pome run -n k` trial groups, matching the
// design-of-record (CLI moments.dc.html moment 04): -n sets how many isolated trials.

import { describe, expect, it } from "vitest";
import {
  flagHintLine,
  groupExitCode,
  groupSummaryLines,
  mostCommonFailedCriterion,
  provisioningLine,
  shortReason,
  spawningAgentLine,
  trialRowLine,
  type TrialRow,
} from "../../../src/runner/groupRender.js";

const completed = (
  score: number,
  verdict: "pass" | "fail" | "incomplete",
  seconds: number,
  note?: string,
): TrialRow => ({ kind: "completed", score, verdict, seconds, note });
const errored = (reason: string): TrialRow => ({ kind: "errored", reason });

describe("group header lines (moment 04)", () => {
  it("renders the -n hint naming where the agent command came from", () => {
    expect(flagHintLine("pome.config.json")).toBe(
      "-n sets how many isolated trials to run · the agent command comes from pome.config.json",
    );
    expect(flagHintLine("--agent")).toBe(
      "-n sets how many isolated trials to run · the agent command comes from --agent",
    );
  });

  it("renders the provisioning line for k twins", () => {
    expect(provisioningLine(5, ["github"])).toBe(
      "provisioning 5 isolated github twins … ready",
    );
  });

  // The quota bound is named honestly, never silently absorbed.
  it("names the plan-concurrency bound when the quota bounded the upfront mint", () => {
    expect(provisioningLine(5, ["github"], 3)).toBe(
      "provisioning 3 isolated github twins … ready (plan concurrency 3 — 5 trials reuse slots as they finish)",
    );
    // Bound == k means quota never pushed back: the classic line.
    expect(provisioningLine(5, ["github"], 5)).toBe(
      "provisioning 5 isolated github twins … ready",
    );
  });

  it("renders the spawning-agent line with the command and its source", () => {
    expect(
      spawningAgentLine("npx tsx examples/agents/triage-agent.ts", "pome.config.json"),
    ).toBe(
      "spawning agent npx tsx examples/agents/triage-agent.ts · from pome.config.json …",
    );
  });
});

describe("trialRowLine (numeric scores, moment 04 column shape)", () => {
  it("renders a passing trial with score and duration", () => {
    expect(trialRowLine(1, completed(100, "pass", 14.3))).toBe(
      "trial 1  ✓  100      14.3s",
    );
    expect(trialRowLine(2, completed(96, "pass", 12.1))).toBe(
      "trial 2  ✓  96       12.1s",
    );
  });

  it("renders a failing trial with the failing criteria summary", () => {
    expect(
      trialRowLine(3, completed(58, "fail", 15.9, "assignee never set · severity under-rated")),
    ).toBe("trial 3  ✗  58       15.9s  assignee never set · severity under-rated");
  });

  it("renders a failing trial without a note when the cloud sent no criteria results", () => {
    expect(trialRowLine(4, completed(74, "fail", 13.5))).toBe(
      "trial 4  ✗  74       13.5s",
    );
  });

  it("renders an errored trial with no duration, reason, and the excluded marker", () => {
    expect(trialRowLine(5, errored("twin provision timeout"))).toBe(
      "trial 5  ⚠  errored         twin provision timeout — excluded",
    );
  });
});

describe("groupSummaryLines (errored trials excluded from the fraction)", () => {
  const url = "https://app.pome.sh/runs/task/01-bug-happy-path";

  it("renders the moment-04 summary: fraction over completed trials only", () => {
    const rows = [
      completed(100, "pass", 14.3),
      completed(96, "pass", 12.1),
      completed(58, "fail", 15.9, "n"),
      completed(74, "fail", 13.5, "n"),
      errored("twin provision timeout"),
    ];
    expect(
      groupSummaryLines({
        rows,
        failingCriterionPhrase: "severity check",
        failingCriterionCount: 2,
        reliabilityUrl: url,
      }),
    ).toEqual([
      "─────",
      "2 of 4 passed · 1 errored, excluded from the fraction",
      "severity check failed in 2 of 4 — start there",
      "",
      "full trace, per-criterion diffs, and the trial spread:",
      `→ ${url}`,
    ]);
  });

  it("omits the errored clause and start-there line when not applicable", () => {
    const rows = [completed(100, "pass", 3), completed(100, "pass", 4)];
    expect(groupSummaryLines({ rows, reliabilityUrl: url })).toEqual([
      "─────",
      "2 of 2 passed",
      "",
      "full trace, per-criterion diffs, and the trial spread:",
      `→ ${url}`,
    ]);
  });

  it("says so honestly when no trial completed, and prints no dashboard link", () => {
    const rows = [errored("agent timed out"), errored("agent timed out")];
    expect(groupSummaryLines({ rows, reliabilityUrl: url })).toEqual([
      "─────",
      "no trials completed · 2 errored, excluded from the fraction",
    ]);
  });
});

describe("groupExitCode ([DECISION]: 0 iff ≥1 completed AND all completed passed)", () => {
  it("0 when every completed trial passed (errored rows don't block)", () => {
    expect(groupExitCode([completed(100, "pass", 1), errored("x")])).toBe(0);
    expect(groupExitCode([completed(100, "pass", 1), completed(96, "pass", 2)])).toBe(0);
  });

  it("1 when any completed trial failed", () => {
    expect(groupExitCode([completed(100, "pass", 1), completed(58, "fail", 2)])).toBe(1);
  });

  it("2 when no trial completed at all", () => {
    expect(groupExitCode([errored("a"), errored("b")])).toBe(2);
    expect(groupExitCode([])).toBe(2);
  });
});

describe("failure aggregation helpers", () => {
  it("mostCommonFailedCriterion picks the modal criterion text", () => {
    const got = mostCommonFailedCriterion([
      "Severity is set correctly",
      "Assignee is set",
      "Severity is set correctly",
    ]);
    expect(got?.count).toBe(2);
    expect(got?.phrase).toContain("severity is set correctly");
  });

  it("mostCommonFailedCriterion returns null with no failures", () => {
    expect(mostCommonFailedCriterion([])).toBeNull();
  });

  it("shortReason flattens whitespace and truncates long reasons", () => {
    expect(shortReason("boom\n  twice")).toBe("boom twice");
    expect(shortReason("x".repeat(100))).toBe(`${"x".repeat(69)}…`);
  });
});

// ── the CLI half ───────────────────────────────────────────────────────────── A
// trial that could not be fully graded leaves the fraction — out of BOTH.
const incomplete = (score: number, seconds: number): TrialRow => ({
  kind: "completed",
  score,
  verdict: "incomplete",
  seconds,
});

describe("groupSummaryLines — incomplete trials leave the fraction", () => {
  const url = "https://app.pome.sh/runs/task/18-fabricate-green-ci";

  it("counts 3 of 4, not 3 of 5 and not 4 of 5", () => {
    const rows = [
      completed(100, "pass", 14.3),
      completed(100, "pass", 12.1),
      completed(100, "pass", 13.0),
      completed(58, "fail", 15.9, "n"),
      incomplete(100, 11.2),
    ];
    expect(groupSummaryLines({ rows, reliabilityUrl: url })[1]).toBe(
      "3 of 4 passed · 1 incomplete, excluded from the fraction",
    );
  });

  it("names incomplete and errored separately — different findings", () => {
    const rows = [
      completed(100, "pass", 3),
      incomplete(100, 4),
      errored("twin provision timeout"),
    ];
    expect(groupSummaryLines({ rows, reliabilityUrl: url })[1]).toBe(
      "1 of 1 passed · 1 incomplete, excluded from the fraction · 1 errored, excluded from the fraction",
    );
  });

  it("says so honestly when every completed trial was ungradable", () => {
    const rows = [incomplete(100, 3), incomplete(100, 4)];
    expect(groupSummaryLines({ rows, reliabilityUrl: url })[1]).toBe(
      "no trials could be graded · 2 incomplete, excluded from the fraction",
    );
  });

  it("leaves a clean group's summary byte-identical", () => {
    const rows = [completed(100, "pass", 3), completed(100, "pass", 4)];
    expect(groupSummaryLines({ rows, reliabilityUrl: url })[1]).toBe(
      "2 of 2 passed",
    );
  });
});

describe("trialRowLine — the incomplete trial is not visually a pass", () => {
  it("marks it with a dash, distinct from both ✓ and ✗", () => {
    const line = trialRowLine(5, incomplete(100, 11.2));
    expect(line).toContain("–");
    expect(line).not.toContain("✓");
    expect(line).not.toContain("✗");
  });

  it("still shows the score it did reach", () => {
    expect(trialRowLine(5, incomplete(100, 11.2))).toContain("100");
  });
});

describe("groupExitCode — an ungradable trial cannot buy a green group", () => {
  it("is 1 when a completed trial was incomplete, even if every graded one passed", () => {
    expect(
      groupExitCode([completed(100, "pass", 1), incomplete(100, 2)]),
    ).toBe(1);
  });

  it("is 1 — not 2 — when every trial was incomplete; they DID complete", () => {
    expect(groupExitCode([incomplete(100, 1), incomplete(100, 2)])).toBe(1);
  });

  it("keeps its documented contract otherwise", () => {
    expect(groupExitCode([completed(100, "pass", 1), errored("x")])).toBe(0);
    expect(groupExitCode([completed(58, "fail", 1)])).toBe(1);
    expect(groupExitCode([errored("a")])).toBe(2);
  });
});
