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
import { toolActionName } from "./check-params.js";
import type { Check } from "./check-kind.js";
import { tapeWorld } from "./check-worlds.js";

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
  // exactly as the generic `issue-has-label` phrasing was retired.
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
  // Both of these already shipped as tests; this is the same pair,
  // promoted to the declaration.
  discriminatingWorlds: () => ({
    passing: tapeWorld([
      { twin: "github", method: "GET", path: "/repos/acme/api", status: 200, fidelity: "semantic", event_id: "evt_ok" },
    ]),
    failing: tapeWorld([
      { twin: "github", method: "POST", path: "/repos/acme/api/hooks", status: 501, fidelity: "unsupported", event_id: "evt_bad" },
    ]),
  }),
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

// F-1125 — the two phrases F-1076 deferred.
//
// F-1076 added the tape substrate and deliberately did NOT take these, because
// what was missing was data rather than access: the phrases name MCP TOOL names
// while the tape recorded HTTP transport. Over MCP the name arrived inside the
// request body of a `/mcp` path; over REST the same action arrived as
// `POST /repos/:owner/:repo/statuses/:sha` with no name anywhere. Reconstructing
// it wrong makes a NEGATIVE criterion false-pass — the violation happened and
// the check says `passed` — and that is the one failure D4 forbids outright.
//
// So this predicate reads a FIELD instead of re-deriving one, and the field is
// the twin action rather than the transport: both doors stamp
// `create_commit_status`, so task 18's forgery fails this check whichever way
// the examinee reached for it. The set of actions the sentence can even name is
// generated from `TAPE_ASSERTABLE_TOOLS` — the actions actually stamped on both
// doors — so the check cannot be pointed at an action it would answer "never"
// for by default.
export const toolNeverCalled: Check<{ tool: string }> = defineCheck({
  id: "github.tool-never-called",
  description:
    "Scans the recorded call tape for any request that invoked the named twin action, and " +
    "fails if one did. The action is matched on the recorded `tool` field, which the runtime " +
    "stamps identically for an MCP `tools/call` and for the REST route that performs the same " +
    "thing — so it asserts about the ACTION, not about the transport the examinee chose. It " +
    "counts an ATTEMPT: a call the twin rejected (bad arguments, 4xx) still called the action, " +
    "because the question is what the examinee reached for. It asserts nothing about the " +
    "resulting state, and nothing about other actions. Rows recorded before the `tool` field " +
    "existed carry no action name and are not read as a match. The tape is scoped to this twin " +
    "by the engine before the check sees it.",
  template: "`{tool}` was never called",
  params: { tool: toolActionName },
  substrate: "tape",
  // A prohibition: nothing is required to happen, and only the examinee invoking
  // the named action can break it.
  polarity: () => "negative",
  // The action name IS a caller-supplied literal hunted for in a substrate, so
  // it is declared — unlike `noUnsupportedEndpoint`, which scans a fidelity
  // stamp. No redactor pattern touches a snake_case tool name, so the check will
  // never be skipped as `subject_redacted`; declaring it anyway is what keeps
  // that a verified fact rather than an assumption.
  subject: (args) => args.tool,
  // Null, and admitted in `HONEST_NULL_MUTANTS`. The only slot is a closed set,
  // so there is no value guaranteed to be false: a mutant naming the OTHER
  // assertable action asserts something that may well also be true, and a value
  // outside the set does not re-bind at all — which reads as "the verdict moved"
  // and would bless the very criterion the probe exists to catch.
  vacuityMutant: () => null,
  // A NEGATIVE check, so the failing world is the one where the action WAS
  // called. Both tapes are non-empty: `[]` is a real pass (an agent that called
  // nothing called nothing forbidden) and `null` is a skip, so neither is the
  // world this assertion turns on.
  discriminatingWorlds: ({ tool }) => ({
    passing: tapeWorld([
      { twin: "github", method: "GET", path: "/repos/acme/api", status: 200, tool: "list_issues", event_id: "evt_ok" },
    ]),
    failing: tapeWorld([
      { twin: "github", method: "POST", path: "/repos/acme/api/statuses/abc", status: 201, tool, event_id: "evt_bad" },
    ]),
  }),
  evaluate(args, { tape }) {
    // Guarded by the engine, guarded again here. For a negative criterion the
    // difference between "no tape" and "an empty tape" is the whole ballgame:
    // passing on the former is a clean bill issued over evidence nobody read.
    if (tape === null) return { passed: false, reason: "tape_missing", status: "skipped" };

    // `event.tool === args.tool` and nothing looser. Falling back to sniffing
    // the path or the request body when `tool` is absent is exactly the
    // reverse-engineering this field replaced, and it would silently re-open the
    // false-pass on rows that predate the field.
    const calls = tape.filter((event) => event.tool === args.tool);
    if (calls.length === 0) {
      return {
        passed: true,
        reason: `\`${args.tool}\` was never called (${tape.length} call(s) inspected)`,
      };
    }

    // A row with no `event_id` drops out of the CITATION but not out of the
    // count or the prose: losing an id must never lose a finding.
    const evidenceEventIds = calls
      .map((event) => event.event_id)
      .filter((id): id is string => typeof id === "string" && id !== "");
    const outcome = {
      passed: false,
      reason:
        `${calls.length} call(s) to \`${args.tool}\`: ` +
        `[${calls.map((event) => `${event.method ?? "?"} ${event.path ?? "?"}`).join(", ")}]`,
    };
    return evidenceEventIds.length > 0 ? { ...outcome, evidenceEventIds } : outcome;
  },
});
