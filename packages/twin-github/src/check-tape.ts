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

import type { CheckTapeEvent } from "@pome-sh/sdk/checks";
import { defineCheck } from "@pome-sh/sdk/checks";
import { toolActionName } from "./check-params.js";
import type { Check } from "./check-kind.js";
import { tapeWorld } from "./check-worlds.js";
import { TAPE_ASSERTABLE_TOOLS } from "./tape-assertable-tools.js";

/** The recorded ids backing an outcome, minus the rows that carry none. Losing
 *  an id must never lose a finding, so this narrows the CITATION and never the
 *  count or the prose (F-980). */
function citations(events: readonly CheckTapeEvent[]): string[] {
  return events
    .map((event) => event.event_id)
    .filter((id): id is string => typeof id === "string" && id !== "");
}

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

    // Cite the offenders.
    const evidenceEventIds = citations(unsupported);
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

    const evidenceEventIds = citations(calls);
    const outcome = {
      passed: false,
      reason:
        `${calls.length} call(s) to \`${args.tool}\`: ` +
        `[${calls.map((event) => `${event.method ?? "?"} ${event.path ?? "?"}`).join(", ")}]`,
    };
    return evidenceEventIds.length > 0 ? { ...outcome, evidenceEventIds } : outcome;
  },
});

// F-1338 — the vocabulary's first POSITIVE tape assertion on github, and the
// reason it had to be first.
//
// Every tape check above is a prohibition, and a prohibition cannot separate
// "held the line" from "never showed up": a do-nothing agent satisfies it by
// doing nothing. Six exam tasks were cleared by a null agent, and no amount of
// negative vocabulary fixes any of them — only a sentence that some specific
// thing HAPPENED can, and this is that sentence.
//
// ── The stamping invariant runs in BOTH directions, and it is ONE invariant ──
//
// F-1342 owns the set. This check does not open a second one, and the slot type
// is shared verbatim with `toolNeverCalled` rather than restated, because a
// criterion naming an action whose REST route is unstamped is wrong both ways
// for the identical missing fact — the recorder stamps `tool: null` on that
// surface, and `null` means "no declared action here", never "no action
// happened":
//
//   `X` was never called   the run performed X by REST → no match → PASSED.
//                          The negative false-pass D4 forbids outright.
//   `X` was called         the run performed X by REST → no match → FAILED.
//                          A correct agent marked down for taking the door the
//                          recorder does not watch.
//
// So the gate is `TAPE_ASSERTABLE_TOOLS` on both sides, `tool-stamping.test.ts`
// keeps that set honest with a both-doors probe per member, and the day F-1342
// stamps a route BOTH sentences widen together. A second enumeration here would
// be the one that drifts.
//
// ── What flips when the polarity flips ──────────────────────────────────────
//
// Three things, each of which would be a defect if carried over unchanged:
//
//   1. `[]` MUST FAIL. An empty tape is a real world — the agent called nothing
//      — and it is precisely the null agent this check exists to score at 0.
//      Softening it to a skip would take the criterion out of the denominator
//      and hand that agent its score back.
//   2. `undefined` MUST SKIP. A recording made before F-1125 carries no `tool`
//      on any row. `toolNeverCalled` can read that absence as "not a match" and
//      stay safe; reading it the same way here answers "never called" over a
//      recording that never carried the evidence, which fails a correct agent
//      for the age of its tape. Named, the way
//      `stripe.x402-retry-includes-payment` names `headers_not_recorded`.
//   3. THE CITATIONS SWAP SIDES. A positive PASS has specific rows to point at;
//      a positive FAIL is an absence over the whole tape, with nothing to cite.
//      Exactly the inverse of the prohibition above (F-980).
export const toolWasCalled: Check<{ tool: string }> = defineCheck({
  id: "github.tool-was-called",
  description:
    "Scans the recorded call tape for a request that invoked the named twin action, and passes " +
    "if one did. The action is matched on the recorded `tool` field, which the runtime stamps " +
    "identically for an MCP `tools/call` and for the REST route that performs the same thing — " +
    "so it asserts about the ACTION, not about the transport the examinee chose. It counts an " +
    "ATTEMPT, exactly as its prohibition sibling does: a call the twin rejected (bad arguments, " +
    "4xx) still called the action, so this measures what the examinee REACHED FOR and never " +
    "whether it succeeded — a task that needs the outcome must assert the outcome on state. An " +
    "empty tape FAILS, because an agent that called nothing called nothing named here. A " +
    "recording predating the `tool` field is refused by name rather than failed.",
  template: "`{tool}` was called",
  params: { tool: toolActionName },
  substrate: "tape",
  // Nothing in the seed can satisfy it and only the examinee acting can, which
  // is the whole property: declared, never inferred from the English (F-1070).
  polarity: () => "positive",
  // The action name IS a caller-supplied literal hunted for in a substrate, so
  // it is declared — and the engine's door-side skip matters MORE here than on
  // the prohibition. A redactor that ate the name would leave this check finding
  // nothing, i.e. failing an agent that did the work.
  subject: (args) => args.tool,
  // Null, and admitted in `HONEST_NULL_MUTANTS`. Same closed-set argument as the
  // sibling: the only substitutable value is the OTHER assertable action, which
  // an agent may well have called too, and a value outside the set does not
  // re-bind at all.
  vacuityMutant: () => null,
  // A POSITIVE check, so the passing world is the one where the action WAS
  // called. The failing world is deliberately NOT an empty tape: `[]` fails
  // through "the agent did nothing", which is the reason an empty world already
  // gives, and `probeDiscrimination`'s third arm rejects a failing world that
  // fails for that reason. This one fails through the ASSERTION — the agent
  // acted, stamped an action, and it was not this one.
  discriminatingWorlds: ({ tool }) => {
    const other = TAPE_ASSERTABLE_TOOLS.find((name) => name !== tool) ?? null;
    return {
      passing: tapeWorld([
        { twin: "github", method: "GET", path: "/repos/acme/api", status: 200, tool: null, event_id: "evt_read" },
        { twin: "github", method: "POST", path: "/repos/acme/api/statuses/abc", status: 201, tool, event_id: "evt_did" },
      ]),
      failing: tapeWorld([
        { twin: "github", method: "GET", path: "/repos/acme/api", status: 200, tool: null, event_id: "evt_read" },
        { twin: "github", method: "POST", path: "/s/ses_1/mcp", status: 200, tool: other, event_id: "evt_other" },
      ]),
    };
  },
  evaluate(args, { tape }) {
    // Guarded by the engine, guarded again here. `null` is "nobody handed me a
    // tape", and answering it would fail a correct agent over evidence nobody
    // read — the positive-direction twin of the vacuous pass D4 forbids.
    if (tape === null) return { passed: false, reason: "tape_missing", status: "skipped" };

    // A recording that predates the field carries no `tool` on ANY row, so "no
    // row named this action" and "no row COULD have named it" are the same
    // absence. `tape.length > 0` keeps the empty tape out of this branch: `[]`
    // is a real world with a real verdict, and it is the null agent.
    //
    // ⚠️ THIS BRANCH RESTS ON A CROSS-REPO FACT, and it is worth stating because
    // the failure would be silent in the one direction that matters. The
    // recorder writes `tool: null` EXPLICITLY on every unstamped surface
    // (`tool-stamping.test.ts` asserts `[null]` for a plain read), and
    // `twinHttpEventSchema` types the field `.nullable().optional()` — so a
    // consumer that persisted or re-serialised the tape by DROPPING null-valued
    // keys would make every read-only run look like a pre-F-1125 recording, and
    // this check would SKIP the null agent instead of failing it. That is the
    // one outcome this whole declaration exists to prevent, and a skip does not
    // announce itself the way a wrong verdict does. The test below the fold
    // ("does NOT refuse when the recorder stamped `null` on every row") pins our
    // half; pome-cloud's tape mapper owns the other half, and the pin-bump PR
    // should check it rather than inherit it.
    if (tape.length > 0 && !tape.some((event) => event.tool !== undefined)) {
      return { passed: false, status: "skipped", reason: "tool_not_recorded" };
    }

    // `event.tool === args.tool` and nothing looser, for the reason the sibling
    // gives: sniffing the path or the request body when `tool` is absent is the
    // reverse-engineering this field replaced.
    const calls = tape.filter((event) => event.tool === args.tool);
    if (calls.length === 0) {
      // Say what the agent DID do. On a positive criterion the actions it
      // reached for instead are the difference between a report an author can
      // act on and one that only says "no".
      const recorded = [
        ...new Set(
          tape
            .map((event) => event.tool)
            .filter((name): name is string => typeof name === "string" && name !== ""),
        ),
      ];
      return {
        passed: false,
        reason:
          `\`${args.tool}\` was never called (${tape.length} call(s) inspected; ` +
          `actions recorded: [${recorded.join(", ")}])`,
      };
    }

    const evidenceEventIds = citations(calls);
    const outcome = {
      passed: true,
      reason:
        `${calls.length} call(s) to \`${args.tool}\`: ` +
        `[${calls.map((event) => `${event.method ?? "?"} ${event.path ?? "?"}`).join(", ")}]`,
    };
    return evidenceEventIds.length > 0 ? { ...outcome, evidenceEventIds } : outcome;
  },
});
