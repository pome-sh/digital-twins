// SPDX-License-Identifier: Apache-2.0
//
// What Gmail's declared checks can assert about the RUN — the recorded call tape
// rather than the exported end state (F-1128).
//
// Why this class has to exist at all: an unsupported call leaves NO STATE TRACE.
// The twin answers 501 and mutates nothing, so `state_final.json` is
// byte-identical whether the examinee reached for an unimplemented route or
// never tried. The runtime stamps `fidelity: "unsupported"` on the recorded
// event instead, and that stamp is the only place the fact survives.
//
// This was the SHARED `unsupportedEndpointRule` in pome-cloud, registered by
// gmail and linear alike. Deleting `deterministic/gmail.ts` takes gmail's
// registration with it, so the declaration has to carry the assertion across or
// the criterion falls out of the vocabulary. `endpoints.ts` stays in the cloud
// for linear, which is still undeclared.

import { defineCheck } from "@pome-sh/sdk/checks";
import type { Check } from "./check-kind.js";
import { tapeWorld } from "./check-worlds.js";

export const noUnsupportedEndpoint: Check<Record<string, never>> = defineCheck({
  id: "gmail.no-unsupported-endpoint",
  description:
    "Scans the recorded call tape for any request the twin answered with " +
    'fidelity "unsupported" — a route it does not implement, answered 501. It asserts nothing ' +
    "about whether the run SUCCEEDED, and nothing about calls that were merely rejected: a 404 " +
    "or a 422 from a route the twin does implement is a semantic answer and passes this check. " +
    "The tape is scoped to this twin by the engine before the check sees it, so an unsupported " +
    "call to a DIFFERENT twin in a multi-twin session cannot fail it — which matters here, " +
    "because a single task may run gmail and github together.",
  // No slots, and no twin word. The legacy cloud rule accepted "No unsupported
  // Gmail endpoint was called" alongside the bare form, plus plural and `were`
  // variants, because an author typed English. Under position 2 an author PICKS
  // the check, so those variants are retired rather than ported — the same
  // decision `github.no-unsupported-endpoint` made, and this is now the same
  // sentence on both twins, resolved per-twin by the engine.
  template: "No unsupported endpoint was called",
  params: {},
  substrate: "tape",
  // A prohibition. Nothing is required to happen; only the examinee reaching for
  // an unimplemented route can break it.
  polarity: () => "negative",
  // No caller-supplied literal is hunted for in any substrate, so there is
  // nothing a redactor could silently delete out from under this check.
  subject: () => null,
  // No slots, so the sentence carries no literal to falsify. The trigger is "a
  // call with fidelity=unsupported exists", which lives on the tape and not in
  // the sentence. Reported as `no_trigger`, never as clean.
  vacuityMutant: () => null,
  discriminatingWorlds: () => ({
    passing: tapeWorld([
      {
        twin: "gmail",
        method: "GET",
        path: "/gmail/v1/users/me/messages",
        status: 200,
        fidelity: "semantic",
        event_id: "evt_ok",
      },
    ]),
    failing: tapeWorld([
      {
        twin: "gmail",
        method: "POST",
        path: "/gmail/v1/users/me/watch",
        status: 501,
        fidelity: "unsupported",
        event_id: "evt_bad",
      },
    ]),
  }),
  evaluate(_args, { tape }) {
    // The engine guards this before calling; the check guards too, so a consumer
    // that forgets gets a named skip rather than a vacuous pass. For a NEGATIVE
    // criterion that distinction is the whole ballgame — passing here would be a
    // clean bill of health issued over a tape nobody read.
    //
    // Note `null` and `[]` are deliberately different: an EMPTY tape is a real
    // world (the agent called nothing, so it called nothing unsupported) and
    // reaches a real verdict below.
    if (tape === null) return { passed: false, reason: "tape_missing", status: "skipped" };

    const unsupported = tape.filter((event) => event.fidelity === "unsupported");
    if (unsupported.length === 0) {
      // No evidence on the pass branch (F-980). This asserts a NEGATIVE over the
      // whole tape and a negative over an empty set has no single call to point
      // at; citing all N inspected calls would be a copy of the trace.
      return {
        passed: true,
        reason: `no unsupported Gmail endpoint was called (${tape.length} call(s) inspected)`,
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
        `${unsupported.length} unsupported Gmail call(s): ` +
        `[${unsupported.map((event) => event.path ?? "?").join(", ")}]`,
    };
    return evidenceEventIds.length > 0 ? { ...outcome, evidenceEventIds } : outcome;
  },
});
