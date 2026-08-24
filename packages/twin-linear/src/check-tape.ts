// SPDX-License-Identifier: Apache-2.0
//
// What Linear's declared checks can assert about the RUN — the recorded call
// tape rather than the exported end state.
//
// Why this class has to exist at all: an unsupported call leaves NO STATE
// TRACE. The twin answers 501 and mutates nothing, so `state_final.json` is
// byte-identical whether the examinee reached for an unimplemented route or
// never tried. The runtime stamps `fidelity: "unsupported"` on the recorded
// event instead, and that stamp is the only place the fact survives.
//
// NO TWIN WORD IN THE TEMPLATE, matching `github.no-unsupported-endpoint`
// exactly. The legacy cloud-side rule took the twin word as an OPTIONAL
// qualifier ("No unsupported Linear endpoint was called") along with plural and
// `were` variants, because an author typed English. Under position 2 an author
// PICKS the check, so the variants are retired rather than ported. Two twins
// may share a template — ids differ, and `resolveTwinRules` is per-twin — and
// no shipped Linear criterion says this sentence today, so nothing in the
// corpus moves.

import { defineCheck } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";
import { tapeWorld } from "./check-worlds.js";

export const noUnsupportedEndpoint: Check<Record<string, never>> = defineCheck({
  id: "linear.no-unsupported-endpoint",
  description:
    "Scans the recorded call tape for any request the twin answered with fidelity " +
    '"unsupported" — a route it does not implement, answered 501. It asserts nothing about ' +
    "whether the run SUCCEEDED, and nothing about calls that were merely rejected: a 404 or a " +
    "422 from a route the twin does implement is a semantic answer and passes. The tape is " +
    "scoped to this twin by the engine before the check sees it, so an unsupported call to a " +
    "different twin in a multi-twin session cannot fail it.",
  template: "No unsupported endpoint was called",
  params: {},
  substrate: "tape",
  // A prohibition. Nothing is required to happen; only the examinee reaching
  // for an unimplemented route can break it.
  polarity: () => "negative",
  // No caller-supplied literal is hunted for in any substrate, so there is
  // nothing a redactor could silently delete out from under this check.
  subject: () => null,
  // Ledgered. No slots, so the sentence carries no literal to falsify — the
  // trigger is a fidelity stamp on the tape, which no mutation of the criterion
  // text can reach.
  vacuityMutant: () => null,
  discriminatingWorlds: () => ({
    passing: tapeWorld([
      {
        twin: "linear",
        method: "POST",
        path: "/graphql",
        status: 200,
        fidelity: "semantic",
        event_id: "evt_ok",
      },
    ]),
    failing: tapeWorld([
      {
        twin: "linear",
        method: "POST",
        path: "/graphql",
        status: 501,
        fidelity: "unsupported",
        event_id: "evt_bad",
      },
    ]),
  }),
  evaluate(_args, { tape }) {
    // The engine guards this before calling; the check guards too, so a
    // consumer that forgets gets a named skip rather than a vacuous pass. For a
    // NEGATIVE criterion that distinction is the whole ballgame — passing here
    // would be a clean bill of health issued over a tape nobody read.
    //
    // `null` and `[]` are deliberately different: an EMPTY tape is a real world
    // (the agent called nothing, so it called nothing unsupported).
    if (tape === null) return { passed: false, reason: "tape_missing", status: "skipped" };

    const unsupported = tape.filter((event) => event.fidelity === "unsupported");
    if (unsupported.length === 0) {
      // No evidence on the pass branch. This asserts a NEGATIVE over
      // the whole tape, and a negative over an empty set has no single call to
      // point at; citing all N inspected calls would be a copy of the trace.
      return {
        passed: true,
        reason: `no unsupported endpoint was called (${tape.length} call(s) inspected)`,
      };
    }

    // Cite the offenders. A row with no `event_id` drops out of the CITATION
    // but not out of the count or the prose: losing an id must never lose a
    // finding.
    const evidenceEventIds = unsupported
      .map((event) => event.event_id)
      .filter((id): id is string => typeof id === "string" && id !== "");
    return {
      passed: false,
      reason: `${unsupported.length} unsupported call(s): ${unsupported
        .map((e) => `${e.method ?? "?"} ${e.path ?? "?"}`)
        .join(", ")}`,
      ...(evidenceEventIds.length > 0 ? { evidenceEventIds } : {}),
    };
  },
});
