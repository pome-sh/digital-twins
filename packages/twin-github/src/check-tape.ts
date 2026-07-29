// SPDX-License-Identifier: Apache-2.0
//
// What GitHub's declared checks can assert about the RUN — the recorded call
// tape rather than the exported end state (F-1076, settling D1's open half).
//
// Why this class has to exist at all: an unsupported call leaves NO STATE
// TRACE. The twin answers 501 and mutates nothing, so `state_final.json` is
// byte-identical whether the examinee reached for an unimplemented route or
// never tried. The runtime stamps `fidelity: "unsupported"` on the recorded
// event instead, and that stamp is the only place the fact survives.
//
// This check was a hand-written regex in pome-cloud until now. It stayed behind
// when F-1075 moved the other ten, for one reason: whether a declaration MAY
// read the tape was D1's open half, and declaring a substrate nothing supplied
// would have been a promise with no engine behind it.
//
// Declarations only. The grammar rules they obey are in `checks.ts`, which
// assembles them.

import { defineCheck } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";

export const noUnsupportedEndpoint: Check<Record<string, never>> = defineCheck({
  id: "github.no-unsupported-endpoint",
  description:
    "Scans the recorded call tape for any request the twin answered with " +
    'fidelity "unsupported" — a route it does not implement, answered 501. It asserts ' +
    "nothing about whether the run SUCCEEDED, and nothing about calls that were merely " +
    "rejected: a 404 or a 422 from a route the twin does implement is a semantic answer " +
    "and passes this check. The tape is scoped to this twin by the engine before the " +
    "check sees it, so an unsupported call to a DIFFERENT twin in a multi-twin session " +
    "cannot fail it.",
  // No slots. The corpus says this exact sentence in all ten places it appears,
  // and under position 2 an author PICKS the check rather than typing it — so
  // the legacy regex's optional twin word ("No unsupported GitHub endpoint was
  // called") and its plural/`were` variants are retired rather than ported,
  // exactly as F-1075 retired `issue-has-label-generic`.
  template: "No unsupported endpoint was called",
  params: {},
  substrate: "tape",
  // A prohibition. Nothing is required to happen; only the examinee reaching
  // for an unimplemented route can break it.
  polarity: () => "negative",
  // No caller-supplied literal is hunted for in any substrate, so there is
  // nothing a redactor could silently delete out from under this check.
  subject: () => null,
  // No capture groups, so the sentence carries no literal to falsify. The
  // trigger is "a call with fidelity=unsupported exists", which lives on the
  // tape and not in the sentence. Reported as `no_trigger`, never as clean.
  vacuityMutant: () => null,
  evaluate(_args, { tape }) {
    // The engine guards this before calling; the check guards too, so a
    // consumer that forgets gets a named skip rather than a vacuous pass. For a
    // NEGATIVE criterion that distinction is the whole ballgame — passing here
    // would be a clean bill of health issued over a tape nobody read.
    //
    // Note `null` and `[]` are deliberately different: an EMPTY tape is a real
    // world (the agent called nothing, so it called nothing unsupported) and
    // reaches a real verdict below.
    if (tape === null) return { passed: false, reason: "tape_missing", status: "skipped" };

    const unsupported = tape.filter((event) => event.fidelity === "unsupported");
    if (unsupported.length === 0) {
      // No evidence on the pass branch (F-980). This asserts a NEGATIVE over the
      // whole tape — "none of these calls was unsupported" — and a negative over
      // an empty set has no single call to point at. Citing all N inspected
      // calls would be a copy of the trace, not evidence.
      return {
        passed: true,
        reason: `no unsupported GitHub endpoint was called (${tape.length} call(s) inspected)`,
      };
    }

    // Cite the offenders. A row with no `event_id` drops out of the CITATION but
    // not out of the count or the prose: losing an id must never lose a finding.
    const evidenceEventIds = unsupported
      .map((event) => event.event_id)
      .filter((id): id is string => typeof id === "string" && id !== "");
    const outcome = {
      passed: false,
      reason:
        `${unsupported.length} unsupported GitHub call(s): ` +
        `[${unsupported.map((event) => event.path ?? "?").join(", ")}]`,
    };
    return evidenceEventIds.length > 0 ? { ...outcome, evidenceEventIds } : outcome;
  },
});
