// What protects a criterion whose redaction-destroyed literal is not its declared
// `subject`.

import { describe, expect, it } from "vitest";
import { defineCheck, VACUITY_SENTINEL, type CheckParamType } from "../src/checks.js";
import {
  isRedacted,
  probeRedactionSurvival,
  REDACTION_PLACEHOLDER,
} from "../src/check-redaction.js";

interface World {
  reactions?: { name: string }[];
  repo?: { full_name: string; owner: string; name: string };
  count?: number;
}

const word: CheckParamType = {
  name: "word",
  pattern: "[A-Za-z_-]+",
  example: "cheer",
  render: (value) => value,
  parse: (raw) => raw,
};

const number: CheckParamType = {
  name: "number",
  pattern: "[0-9]+",
  example: "1",
  render: (value) => value,
  parse: (raw) => raw,
};

const finalWorld = (final: World) => ({ seed: null, final, tape: null });

// The shape twin-slack's `no-reaction-added` had: a NEGATIVE criterion that
// scans a literal and does not declare it. Masking the literal does not blind
// this predicate, it SATISFIES it.
const negativeScanNoSubject = defineCheck<World, { reaction: typeof word }>({
  id: "toy.no-reaction",
  description: "Asserts no reaction row carries the named emoji.",
  template: 'No "{reaction}" reaction was added',
  params: { reaction: word },
  substrate: "final",
  polarity: () => "negative",
  subject: () => null,
  vacuityMutant: (args) => ({ ...args, reaction: VACUITY_SENTINEL }),
  discriminatingWorlds: ({ reaction }) => ({
    passing: finalWorld({ reactions: [] }),
    failing: finalWorld({ reactions: [{ name: reaction }] }),
  }),
  evaluate({ reaction }, { final }) {
    const hit = (final.reactions ?? []).some((row) => row.name === reaction);
    return { passed: !hit, reason: hit ? `found ${reaction}` : `no ${reaction}` };
  },
});

// The same predicate with the slot declared. Nothing else moves.
const negativeScanWithSubject = defineCheck<World, { reaction: typeof word }>({
  ...negativeScanNoSubject,
  id: "toy.no-reaction-declared",
  subject: ({ reaction }) => reaction,
  params: { reaction: word },
});

// twin-github's `{repo}`, in miniature: the export spells the literal three
// ways and the lookup tries two, so masking one spelling changes no verdict.
const selectorSpelledTwice = defineCheck<World, { repo: CheckParamType }>({
  id: "toy.repo-has-owner",
  description: "Resolves the repo by full name or by owner/name, then asserts it is present.",
  template: "The repo {repo} exists",
  params: { repo: { ...word, name: "repo", pattern: "[A-Za-z]+/[A-Za-z]+", example: "acme/api" } },
  substrate: "final",
  polarity: () => "positive",
  subject: () => null,
  vacuityMutant: () => null,
  discriminatingWorlds: ({ repo }) => {
    const [owner, name] = repo.split("/") as [string, string];
    return {
      passing: finalWorld({ repo: { full_name: repo, owner, name } }),
      failing: finalWorld({}),
    };
  },
  evaluate({ repo }, { final }) {
    const row = final.repo;
    const found =
      row != null && (row.full_name === repo || `${row.owner}/${row.name}` === repo);
    return { passed: found, reason: found ? `${repo} exists` : `${repo} not found` };
  },
});

// A slot the export never carries as a string: the criterion says `2`, the tree
// holds the number 2.
const derivedCount = defineCheck<World, { count: typeof number }>({
  id: "toy.count-is",
  description: "Compares the exported count against the number the criterion names.",
  template: "The count is {count}",
  params: { count: number },
  substrate: "final",
  polarity: () => "positive",
  subject: () => null,
  vacuityMutant: (args) => ({ ...args, count: "987654321" }),
  discriminatingWorlds: ({ count }) => ({
    passing: finalWorld({ count: Number(count) }),
    failing: finalWorld({ count: Number(count) + 1 }),
  }),
  evaluate({ count }, { final }) {
    const passed = final.count === Number(count);
    return { passed, reason: `count is ${final.count} (wanted ${count})` };
  },
});

const guardOf = (verdict: ReturnType<typeof probeRedactionSurvival>, param: string) => {
  if (verdict.kind !== "measured") throw new Error("expected a measured verdict");
  return verdict.rows.find((row) => row.param === param)?.guard;
};

describe("probeRedactionSurvival", () => {
  it("catches the negative check whose scanned literal is not its subject", () => {
    // THE guard-fires case. Without it this whole gate could be green because it
    // never asks a question anything can fail.
    const verdict = probeRedactionSurvival(negativeScanNoSubject, { reaction: "white_check_mark" });
    expect(guardOf(verdict, "reaction")).toBe("vacuous_pass");
  });

  it("credits the same predicate once the slot is declared, without evaluating", () => {
    // The engine never calls `evaluate` for a criterion whose subject the
    // redactor destroyed, so running the predicate anyway would measure a path
    // production cannot reach and file the answer under this check's name.
    const verdict = probeRedactionSurvival(negativeScanWithSubject, {
      reaction: "white_check_mark",
    });
    expect(guardOf(verdict, "reaction")).toBe("declared_subject");
  });

  it("does not mistake a selector the export spells twice for a vacuous pass", () => {
    // The regression that made the probe read BOTH worlds. Asking only "does the
    // passing world still pass" calls this `vacuous_pass`; asking the failing
    // world gets the right answer, because that world still fails.
    const verdict = probeRedactionSurvival(selectorSpelledTwice, { repo: "acme/api" });
    expect(guardOf(verdict, "repo")).toBe("discriminates_anyway");
  });

  it("says a literal the world never carries as a string was never at risk", () => {
    const verdict = probeRedactionSurvival(derivedCount, { count: "2" });
    expect(guardOf(verdict, "count")).toBe("absent_from_world");
  });

  it("declines when the declaration names no worlds", () => {
    const noWorlds = defineCheck<World, { reaction: typeof word }>({
      ...negativeScanNoSubject,
      id: "toy.no-worlds",
      params: { reaction: word },
      discriminatingWorlds: () => null,
    });
    expect(probeRedactionSurvival(noWorlds, { reaction: "cheer" }).kind).toBe("declined");
  });

  it("reports a predicate that crashes rather than crashing with it", () => {
    const crashes = defineCheck<World, { reaction: typeof word }>({
      ...negativeScanNoSubject,
      id: "toy.crashes",
      params: { reaction: word },
      evaluate({ reaction }, { final }) {
        // Reads a field the destroyed world no longer shapes the way it expects.
        if (final.reactions![0]!.name === reaction) return { passed: false, reason: "hit" };
        return { passed: true, reason: "clear" };
      },
    });
    expect(guardOf(probeRedactionSurvival(crashes, { reaction: "cheer" }), "reaction")).toBe(
      "throws",
    );
  });
});

describe("isRedacted", () => {
  it("recognises the placeholder a scoring redactor writes", () => {
    expect(isRedacted(REDACTION_PLACEHOLDER)).toBe(true);
  });

  it("answers false for anything else, including absence", () => {
    // A recogniser, not a proof. A team whose redactor writes some other token
    // gets `false`, and the predicate that asked falls back to whatever it said
    // before — which is why no verdict may rest on this answer alone.
    expect(isRedacted("***")).toBe(false);
    expect(isRedacted("pome-agent@pome-twin.test")).toBe(false);
    expect(isRedacted(null)).toBe(false);
    expect(isRedacted(undefined)).toBe(false);
  });
});
