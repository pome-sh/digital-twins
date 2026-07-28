import { describe, expect, it } from "vitest";
import {
  checkNearMissPattern,
  checkPattern,
  checksDigest,
  defineCheck,
  parseCheck,
  renderCheck,
  repoRef,
  templateSlots,
  type CheckDefinition,
  type CheckParamType
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
