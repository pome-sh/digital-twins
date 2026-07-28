import { describe, expect, it } from "vitest";
import {
  checkNearMissPattern,
  checkPattern,
  defineCheck,
  parseCheck,
  renderCheck,
  repoRef,
  templateSlots,
  type CheckDefinition
} from "../src/checks.js";

const noNewLabels: CheckDefinition<unknown, { repo: string }> = defineCheck({
  id: "example.no-new-labels",
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
