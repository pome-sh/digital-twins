import { describe, expect, it } from "vitest";
import {
  checkNearMissPattern,
  checkPattern,
  checksDigest,
  defineCheck,
  oneOf,
  parseCheck,
  renderCheck,
  repoRef,
  templateSlots,
  type CheckDefinition,
  type CheckParamType,
  type CheckTapeEvent
} from "../src/checks.js";

const noNewLabels: CheckDefinition<unknown, { repo: string }> = defineCheck({
  id: "example.no-new-labels",
  description: "Compares the repo's label definitions in the seed against the final state.",
  template: "No new labels were created in `{repo}`",
  params: { repo: repoRef },
  substrate: "seed+final",
  polarity: () => "negative",
  subject: () => null,
  vacuityMutant: () => null,
  evaluate: () => ({ passed: true, reason: "stub" })
});

describe("templateSlots", () => {
  it("splits a template into literal segments and ordered param names", () => {
    expect(templateSlots("No new labels were created in `{repo}`")).toEqual({
      literals: ["No new labels were created in `", "`"],
      params: ["repo"]
    });
  });

  it("handles a template with no slots", () => {
    expect(templateSlots("No unsupported endpoint was called")).toEqual({
      literals: ["No unsupported endpoint was called"],
      params: []
    });
  });
});

describe("renderCheck", () => {
  it("substitutes args into the template", () => {
    expect(renderCheck(noNewLabels, { repo: "acme/api" })).toBe("No new labels were created in `acme/api`");
  });
});

describe("checkPattern", () => {
  it("matches the rendered sentence and captures the arg", () => {
    const matched = "No new labels were created in `acme/api`".match(checkPattern(noNewLabels));
    expect(matched?.[1]).toBe("acme/api");
  });

  it("is case-sensitive, so a lowercased sentence does not match", () => {
    expect(checkPattern(noNewLabels).test("no new labels were created in `acme/api`")).toBe(false);
  });

  it("is anchored, so trailing text does not match", () => {
    expect(checkPattern(noNewLabels).test("No new labels were created in `acme/api` today")).toBe(false);
  });

  it("rejects an arg that violates the declared param type", () => {
    expect(checkPattern(noNewLabels).test("No new labels were created in `acme api`")).toBe(false);
  });
});

describe("checkNearMissPattern", () => {
  it("accepts a sentence whose literal segments are intact but whose arg is malformed", () => {
    expect(checkNearMissPattern(noNewLabels).test("No new labels were created in `acme api`")).toBe(true);
  });

  it("rejects a sentence missing a literal segment — that is a stranger, not a near miss", () => {
    expect(checkNearMissPattern(noNewLabels).test("No new labels were created")).toBe(false);
  });
});

describe("parseCheck", () => {
  it("round-trips: render -> parse -> render is byte-identical", () => {
    const rendered = renderCheck(noNewLabels, { repo: "acme/api" });
    const args = parseCheck(noNewLabels, rendered);
    expect(args).toEqual({ repo: "acme/api" });
    expect(renderCheck(noNewLabels, args!)).toBe(rendered);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(parseCheck(noNewLabels, "  No new labels were created in `acme/api`  ")).toEqual({ repo: "acme/api" });
  });

  it("returns null for a sentence that does not instantiate the template", () => {
    expect(parseCheck(noNewLabels, "No new labels were created")).toBeNull();
  });
});

describe("defineCheck validation", () => {
  const base = {
    id: "example.bad",
    description: "Exists only to exercise defineCheck's validation.",
    substrate: "final" as const,
    polarity: () => "negative" as const,
    vacuityMutant: () => null,
    evaluate: () => ({ passed: true, reason: "stub" })
  };

  it("rejects a template slot with no declared param type", () => {
    expect(() => defineCheck({ ...base, template: "Issue #{number} is closed", params: {} })).toThrow(
      /template slot \{number\} has no declared param type/
    );
  });

  it("rejects a declared param the template never uses", () => {
    expect(() => defineCheck({ ...base, template: "Nothing happened", params: { repo: repoRef } })).toThrow(
      /declared param `repo` is not used by the template/
    );
  });

  it("rejects a duplicated template slot", () => {
    expect(() => defineCheck({ ...base, template: "`{repo}` and `{repo}`", params: { repo: repoRef } })).toThrow(
      /duplicate template slot \{repo\}/
    );
  });
});

describe("checksDigest", () => {
  const alpha = defineCheck({
    id: "x.alpha",
    description: "Alpha compares the alpha field, which the sentence does not say.",
    template: "Alpha is set on `{repo}`",
    params: { repo: repoRef },
    substrate: "final",
    polarity: () => "positive",
    vacuityMutant: () => null,
    evaluate: () => ({ passed: true, reason: "stub" })
  });
  const beta = defineCheck({
    id: "x.beta",
    description: "Beta compares the beta field, which the sentence does not say.",
    template: "Beta is set on `{repo}`",
    params: { repo: repoRef },
    substrate: "final",
    polarity: () => "positive",
    vacuityMutant: () => null,
    evaluate: () => ({ passed: true, reason: "stub" })
  });

  it("does not depend on declaration order", () => {
    expect(checksDigest([alpha, beta])).toBe(checksDigest([beta, alpha]));
  });

  it("moves when a template changes, because that changes what binds", () => {
    const renamed = { ...alpha, template: "Alpha is now set on `{repo}`" };
    expect(checksDigest([renamed])).not.toBe(checksDigest([alpha]));
  });

  it("moves when a param type's pattern changes", () => {
    const looseRepo: CheckParamType = { ...repoRef, pattern: ".+" };
    const loosened = { ...alpha, params: { repo: looseRepo } };
    expect(checksDigest([loosened])).not.toBe(checksDigest([alpha]));
  });

  it("does NOT move when only prose changes", () => {
    // The digest gates an author's write. A description or example edit changes
    // no sentence and must never refuse one.
    const reworded = {
      ...alpha,
      description: "A completely different explanation of the same comparison.",
      params: { repo: { ...repoRef, example: "other/repo" } }
    };
    expect(checksDigest([reworded])).toBe(checksDigest([alpha]));
  });

  it("is prefixed so a caller can tell the algorithm from the value", () => {
    expect(checksDigest([alpha])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("defineCheck validates a param type's own example", () => {
  it("throws when the example fails the pattern it ships with", () => {
    const broken: CheckParamType = {
      name: "repo",
      pattern: "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",
      example: "not a repo",
      render: (value) => value,
      parse: (raw) => raw
    };
    expect(() =>
      defineCheck({
        id: "x.broken-example",
        description: "Exists only to prove the example assertion fires.",
        template: "A thing about `{repo}`",
        params: { repo: broken },
        substrate: "final",
        polarity: () => "positive",
        vacuityMutant: () => null,
        evaluate: () => ({ passed: true, reason: "stub" })
      })
    ).toThrow(/example .* does not match its own pattern/);
  });

  it("accepts repoRef, whose example is a real repo reference", () => {
    expect(new RegExp(`^${repoRef.pattern}$`).test(repoRef.example)).toBe(true);
  });
});

describe("oneOf", () => {
  const issueState = oneOf("state", ["open", "closed"]);

  it("builds a pattern that accepts every member and nothing else", () => {
    expect(new RegExp(`^${issueState.pattern}$`).test("open")).toBe(true);
    expect(new RegExp(`^${issueState.pattern}$`).test("closed")).toBe(true);
    expect(new RegExp(`^${issueState.pattern}$`).test("merged")).toBe(false);
  });

  it("defaults its example to the first member, so the example is always valid", () => {
    expect(issueState.example).toBe("open");
    expect(new RegExp(`^${issueState.pattern}$`).test(issueState.example)).toBe(true);
  });

  it("accepts a member containing a space", () => {
    const merge = oneOf("state", ["merged", "not merged"]);
    expect(new RegExp(`^${merge.pattern}$`).test("not merged")).toBe(true);
  });

  it("treats a member as a literal, not a sub-pattern", () => {
    // A member carrying a regex metacharacter must match itself and only
    // itself. Unescaped, `payment.succeeded` would also accept `paymentXsucceeded`.
    const event = oneOf("event", ["payment.succeeded"]);
    expect(new RegExp(`^${event.pattern}$`).test("payment.succeeded")).toBe(true);
    expect(new RegExp(`^${event.pattern}$`).test("paymentXsucceeded")).toBe(false);
  });

  it("refuses an empty value set, which would build a pattern matching nothing", () => {
    expect(() => oneOf("state", [])).toThrow(/at least one value/);
  });

  it("keeps a check's slot indices intact when several enums appear in one template", () => {
    // The regression this guards: an enum built with a CAPTURING group would
    // shift group indices, so `state` would parse the review slot's text.
    const twoEnums = defineCheck({
      id: "x.two-enums",
      description: "Exists to prove two enum slots keep their own capture groups.",
      template: "A {review} review exists while the issue is {state}",
      params: { review: oneOf("review", ["APPROVED", "COMMENTED"]), state: issueState },
      substrate: "final",
      polarity: () => "positive",
      vacuityMutant: () => null,
      evaluate: () => ({ passed: true, reason: "stub" })
    });
    expect(parseCheck(twoEnums, "A COMMENTED review exists while the issue is closed")).toEqual({
      review: "COMMENTED",
      state: "closed"
    });
  });
});

describe("defineCheck rejects a param pattern that opens its own capture group", () => {
  // Without this guard the failure is silent and total: `checkPattern` wraps one
  // group per slot and every consumer reads group i+1 as slot i, so one stray
  // group hands every later predicate its neighbour's argument.
  const capturing: CheckParamType = {
    name: "state",
    pattern: "(open|closed)",
    example: "open",
    render: (value) => value,
    parse: (raw) => raw
  };

  it("throws, naming the param and the group count", () => {
    expect(() =>
      defineCheck({
        id: "x.capturing-param",
        description: "Exists only to prove the capture-group assertion fires.",
        template: "Issue #1 is {state}",
        params: { state: capturing },
        substrate: "final",
        polarity: () => "positive",
        vacuityMutant: () => null,
        evaluate: () => ({ passed: true, reason: "stub" })
      })
    ).toThrow(/param `state` pattern .* opens 1 capture group/);
  });

  it("accepts the non-capturing form of the same set", () => {
    expect(() =>
      defineCheck({
        id: "x.noncapturing-param",
        description: "Exists only to prove the assertion accepts (?:…).",
        template: "Issue #1 is {state}",
        params: { state: oneOf("state", ["open", "closed"]) },
        substrate: "final",
        polarity: () => "positive",
        vacuityMutant: () => null,
        evaluate: () => ({ passed: true, reason: "stub" })
      })
    ).not.toThrow();
  });
});

// ── F-1076: the tape substrate ───────────────────────────────────────────────
//
// D1's open half. A declaration may now read the recorded call tape as an
// ORDERED sequence of complete events, bodies included. Ordering is a contract
// the consumer owes the check, not an artifact of how the blob got parsed.

describe("tape substrate", () => {
  it("hands a declaration the ordered tape and lets it cite events", () => {
    const check = defineCheck({
      id: "test.saw-a-call",
      description: "Asserts the tape recorded at least one call, and cites the first.",
      template: "A call was recorded",
      params: {},
      substrate: "tape",
      polarity: () => "positive",
      vacuityMutant: () => null,
      evaluate(_args, { tape }) {
        if (tape === null) return { passed: false, reason: "tape_missing", status: "skipped" };
        const first = tape[0];
        return first === undefined
          ? { passed: false, reason: "no calls recorded" }
          : {
              passed: true,
              reason: `first call was ${first.method} ${first.path}`,
              evidenceEventIds: [first.event_id ?? ""]
            };
      }
    });

    const tape: CheckTapeEvent[] = [
      { twin: "github", method: "POST", path: "/repos/acme/api/issues", event_id: "evt_1" },
      { twin: "github", method: "GET", path: "/repos/acme/api", event_id: "evt_2" }
    ];

    // Order is the contract: the check reads tape[0] and must get the POST.
    expect(check.evaluate({}, { seed: null, final: {}, tape })).toEqual({
      passed: true,
      reason: "first call was POST /repos/acme/api/issues",
      evidenceEventIds: ["evt_1"]
    });
  });

  it("lets a check refuse rather than pass when it was handed no tape", () => {
    const check = defineCheck({
      id: "test.refuses-without-tape",
      description: "Exists to prove a tape check can name its own refusal.",
      template: "Nothing unsupported was called",
      params: {},
      substrate: "tape",
      polarity: () => "negative",
      vacuityMutant: () => null,
      evaluate(_args, { tape }) {
        if (tape === null) return { passed: false, reason: "tape_missing", status: "skipped" };
        return { passed: true, reason: `${tape.length} call(s) inspected` };
      }
    });

    expect(check.evaluate({}, { seed: null, final: {}, tape: null })).toEqual({
      passed: false,
      reason: "tape_missing",
      status: "skipped"
    });
    // An EMPTY tape is a real world — an agent that called nothing — and must
    // reach a real verdict rather than collapsing into the refusal above.
    expect(check.evaluate({}, { seed: null, final: {}, tape: [] })).toEqual({
      passed: true,
      reason: "0 call(s) inspected"
    });
  });

  it("carries the fields a tape assertion actually needs", () => {
    // Bodies are the load-bearing addition: task 19's charge id lives in the
    // request body, not the path, and an MCP-transport call carries its tool
    // name there too.
    const event: CheckTapeEvent = {
      ts: "2026-07-29T00:00:00.000Z",
      twin: "stripe",
      method: "POST",
      path: "/v1/refunds",
      request_body: '{"charge":"ch_test_200"}',
      status: 400,
      response_body: null,
      latency_ms: 3,
      fidelity: "semantic",
      state_mutation: false,
      error: "charge_already_refunded",
      event_id: "evt_attempt"
    };
    expect(String(event.request_body)).toContain("ch_test_200");
  });
});
