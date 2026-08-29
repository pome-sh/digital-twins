// SPDX-License-Identifier: Apache-2.0
// A narrated row RENDERS as narrative.
//
// The arithmetic half of this already shipped: `scoreFromFinalizeResponse`
// stopped counting an advisory row as an abstention, so a mixed-criteria run
// scores off its `[code]` denominator and passes. The terminal did not follow.
// `outcomeOf` maps a narrated row to `"skipped"` — deliberately, so it stays
// inside the `skipped` tally the exemptions are subtracted FROM — and
// `markerFor` renders `"skipped"` with `-`, the glyph that means "the grader
// never reached this criterion". So the demo's own `[model]` rows printed as
// three instrument gaps beside a passing fraction: the exact conflation the
// narrator states exist to remove, one surface downstream of where it was fixed.
//
// Read `score_state`, never `outcome` — F-591 reserved that key for the
// disjoint four-state display vocabulary, which is why widening `outcomeOf`
// is not the fix and a marker chosen off `isNarrated` is.

import { ABSTAINED_SCORE_STATE, ADVISORY_SCORE_STATE } from "@pome-sh/wire/run-completeness";
import { describe, expect, it } from "vitest";
import type { CriterionResult } from "../../../src/contract/index.js";
import {
  criterionMarker,
  markerFor,
  NARRATED_MARKER,
  narratorStateLabel,
  narratorSuffix,
  outcomeOf,
  PRE_SATISFIED_REASON,
  twinSkipSuffix,
} from "../../../src/hosted/evalResultView.js";

const advisory = (text = "the label went to the right issue"): CriterionResult => ({
  criterion: { type: "model", text },
  passed: false,
  skipped: true,
  reason: "the trace shows one POST to /issues/1/labels with {\"labels\":[\"bug\"]}",
  score_state: ADVISORY_SCORE_STATE,
});

const abstained = (text = "the refund was explained"): CriterionResult => ({
  criterion: { type: "model", text },
  passed: false,
  skipped: true,
  reason: "no refund was requested in this run",
  score_state: ABSTAINED_SCORE_STATE,
});

// The negative control, and the whole reason the marker is chosen off
// `score_state` rather than off `skipped`: on the two booleans this row is
// indistinguishable from the two above.
const instrumentGap = (text = "the tool call was recorded"): CriterionResult => ({
  criterion: { type: "model", text },
  passed: false,
  skipped: true,
  reason: "tool_not_recorded",
});

const passed = (text = "issue #1 carries exactly one label"): CriterionResult => ({
  criterion: { type: "code", text },
  passed: true,
  skipped: false,
  reason: "issue #1 has exactly one label (\"bug\")",
});

const failed = (text = "a comment names POST /orders"): CriterionResult => ({
  criterion: { type: "code", text },
  passed: false,
  skipped: false,
  reason: "no comment on issue #1 contains \"POST /orders\"",
});

describe("the narrator's row marker", () => {
  it("is none of the four verdict glyphs", () => {
    // ✓/✗ are verdicts about the criterion and `-`/`!` are statements about the
    // grader. A narrated row is a fifth thing, so it gets a fifth glyph.
    const verdictGlyphs = (["passed", "failed", "skipped", "errored"] as const).map(
      markerFor,
    );
    expect(verdictGlyphs).not.toContain(NARRATED_MARKER);
  });

  it("marks an advisory and an abstained row with it", () => {
    expect(criterionMarker(advisory())).toBe(NARRATED_MARKER);
    expect(criterionMarker(abstained())).toBe(NARRATED_MARKER);
  });

  it("leaves every other row on the four-state marker it already had", () => {
    expect(criterionMarker(passed())).toBe("✓");
    expect(criterionMarker(failed())).toBe("✗");
    // The negative control keeps the instrument-gap glyph — a bare `skipped`
    // with no `score_state` is still a criterion the grader never reached.
    expect(criterionMarker(instrumentGap())).toBe("-");
    expect(
      criterionMarker({ ...instrumentGap(), reason: PRE_SATISFIED_REASON }),
    ).toBe("-");
  });

  it("does not disturb the four-state vocabulary it sits beside", () => {
    // `outcomeOf` still maps a narrated row to `skipped`: the exemptions are
    // SUBTRACTED from that tally, so a row that left it would be subtracted
    // twice. The marker is chosen beside `outcomeOf`, never by widening it.
    expect(outcomeOf(advisory())).toBe("skipped");
    expect(outcomeOf(abstained())).toBe("skipped");
  });
});

describe("the narrator's row label", () => {
  it("names which of the two states the row is in", () => {
    expect(narratorStateLabel(advisory())).toBe("advisory");
    expect(narratorStateLabel(abstained())).toBe("abstained");
  });

  it("names nothing on a row the narrator did not name", () => {
    expect(narratorStateLabel(passed())).toBeNull();
    expect(narratorStateLabel(instrumentGap())).toBeNull();
    // An unrecognised spelling is not a narrator state. Printing it would
    // fabricate one out of a field the CLI reads tolerantly on purpose.
    expect(
      narratorStateLabel({ ...instrumentGap(), score_state: "advisorial" }),
    ).toBeNull();
    // …and a `score_state` on a row that was not skipped is ignored, the way
    // the wire reduction ignores it.
    expect(
      narratorStateLabel({ ...passed(), score_state: ADVISORY_SCORE_STATE }),
    ).toBeNull();
  });

  it("says what the state MEANS in the row's trailing clause", () => {
    expect(narratorSuffix(advisory())).toContain("advisory");
    expect(narratorSuffix(advisory())).toMatch(/never scored/);
    expect(narratorSuffix(abstained())).toContain("abstained");
    expect(narratorSuffix(abstained())).toMatch(/nothing in this run to read/);
    // Every other row keeps the line it had.
    expect(narratorSuffix(passed())).toBe("");
    expect(narratorSuffix(instrumentGap())).toBe("");
  });
});

describe("the twin suffix on a narrated row", () => {
  it("stops claiming the twin's timeline came up empty", () => {
    // `twinSkipSuffix` explains WHICH twin's timeline was empty when a
    // criterion could not be evaluated. On a narrated row nothing came up
    // empty — the narrator read the row and reported having no score authority
    // over it — so the suffix would be a second instrument-gap claim wearing
    // the twin's name.
    const twinTagged: CriterionResult = {
      ...advisory(),
      criterion: { type: "model", text: "the label went to the right issue", twin: "github" },
    };
    expect(twinSkipSuffix(twinTagged)).toBe("");
    // The genuine gap still names its twin.
    expect(
      twinSkipSuffix({
        ...instrumentGap(),
        criterion: { type: "model", text: "the tool call was recorded", twin: "github" },
      }),
    ).toBe(" (twin: github)");
  });
});
