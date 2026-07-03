// SPDX-License-Identifier: Apache-2.0
// Shared verdict-rendering helpers for `pome run` / `pome eval` (FDRS-656
// review: these were byte-identical copies in main.ts and eval.ts).

import type { Score } from "../evaluator/score.js";
import { scoreStatus } from "../evaluator/score.js";

// FDRS-591/611 per-criterion marker: ✓ passed, ✗ failed, - skipped, ! errored.
export function markerFor(
  outcome: "passed" | "failed" | "skipped" | "errored",
): string {
  switch (outcome) {
    case "passed":
      return "✓";
    case "failed":
      return "✗";
    case "errored":
      return "!";
    default:
      return "-";
  }
}

export function scoreCountsSummary(score: Score): string {
  return `${score.passed ?? 0} passed, ${score.failed ?? 0} failed, ${score.skipped ?? 0} skipped, ${score.errored ?? 0} errored`;
}

export function runScoreLine(
  score: Score,
  passThreshold: number,
  unevaluatedNumericLabel: string,
): string {
  const status = scoreStatus(score, passThreshold);
  if (status === "unevaluated") {
    return `score: un-evaluated (cannot pass) — ${scoreCountsSummary(score)}; ${unevaluatedNumericLabel}: ${score.satisfaction}/100`;
  }
  return `score: ${score.satisfaction}/100`;
}
