import { parseCheck, renderCheck, type CheckDefinition } from "@pome-sh/sdk/checks";
import { describe, expect, it } from "vitest";
import { GITHUB_CHECKS, type GitHubCheckState } from "../src/checks.js";

// The declarations are a heterogeneous tuple, so `find` yields a union whose
// args types TypeScript then intersects — asking for every check's parameters
// at once. Erase to the open shape, as the contract suite does, and look the
// check up by id: that also proves it is actually registered in the tuple the
// package ships, not merely defined.
type OpenCheck = CheckDefinition<GitHubCheckState, Record<string, string>>;
const noNewLabels = (GITHUB_CHECKS as readonly unknown[] as readonly OpenCheck[]).find(
  (check) => check.id === "github.no-new-labels",
)!;

function state(labels: string[]): GitHubCheckState {
  return {
    repositories: [
      {
        owner: "acme",
        name: "api",
        full_name: "acme/api",
        labels: labels.map((name) => ({ name })),
      },
    ],
  };
}

const ARGS = { repo: "acme/api" };
const SEEDED = ["bug", "feature", "question"];

describe("github.no-new-labels — declaration", () => {
  it("renders the sentence the corpus carries", () => {
    expect(renderCheck(noNewLabels, ARGS)).toBe("No new labels were created in `acme/api`");
  });

  it("binds the corpus sentence back to its args", () => {
    expect(parseCheck(noNewLabels, "No new labels were created in `acme/api`")).toEqual(ARGS);
  });

  it("declares negative polarity — it can only be broken by the examinee", () => {
    expect(noNewLabels.polarity(ARGS)).toBe("negative");
  });

  it("declares that it needs the seed", () => {
    expect(noNewLabels.substrate).toBe("seed+final");
  });

  it("declares no vacuity mutant: the repo is a selector, not a scanned literal", () => {
    expect(noNewLabels.vacuityMutant(ARGS)).toBeNull();
  });

  it("declares no subject: nothing here is a literal a redactor could delete", () => {
    expect(noNewLabels.subject?.(ARGS) ?? null).toBeNull();
  });
});

describe("github.no-new-labels — predicate", () => {
  it("passes when the label set is untouched", () => {
    const outcome = noNewLabels.evaluate(ARGS, { seed: state(SEEDED), tape: null, final: state(SEEDED) });
    expect(outcome.passed).toBe(true);
  });

  it("fails and names the labels the examinee created", () => {
    const outcome = noNewLabels.evaluate(ARGS, {
      seed: state(SEEDED),
      tape: null,
      final: state([...SEEDED, "wontfix", "needs-triage"]),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("needs-triage");
    expect(outcome.reason).toContain("wontfix");
  });

  // The Shankar UIST '24 §7.3.3 guard. An agent that piles the already-defined
  // `question` label onto issue #1 has done something task 03 dislikes, and
  // this check is CORRECT to pass it: that assertion belongs to
  // `Issue #N has exactly one classification label`, not to this one. The test
  // exists so nobody later "fixes" this check into meaning the wider thing its
  // English could be misread as.
  it("passes when a PRE-EXISTING label is applied to an issue — this check is about the repo's label set", () => {
    const seed = state(SEEDED);
    const final = state(SEEDED);
    final.repositories![0]!.issues = [
      { number: 1, labels: [{ name: "feature" }, { name: "question" }] },
    ];
    expect(noNewLabels.evaluate(ARGS, { seed, final, tape: null }).passed).toBe(true);
  });

  it("does not fail when a label is REMOVED — the sentence says `new`", () => {
    const outcome = noNewLabels.evaluate(ARGS, { seed: state(SEEDED), tape: null, final: state(["bug"]) });
    expect(outcome.passed).toBe(true);
  });

  it("skips, named, when the seed is unavailable rather than passing vacuously", () => {
    const outcome = noNewLabels.evaluate(ARGS, { seed: null, tape: null, final: state(SEEDED) });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("seed_missing");
  });

  it("fails when the named repo is absent from the state", () => {
    const outcome = noNewLabels.evaluate(
      { repo: "acme/other" },
      { seed: state(SEEDED), tape: null, final: state(SEEDED) },
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("acme/other");
  });

  it("falls back to owner/name when a state export omits full_name", () => {
    const noFullName: GitHubCheckState = {
      repositories: [{ owner: "acme", name: "api", labels: [{ name: "bug" }] }],
    };
    expect(noNewLabels.evaluate(ARGS, { seed: noFullName, tape: null, final: noFullName }).passed).toBe(true);
  });

  it("does not resolve a bare repo name — `repoRef` cannot produce one", () => {
    const bare: GitHubCheckState = { repositories: [{ name: "api", labels: [{ name: "bug" }] }] };
    const outcome = noNewLabels.evaluate(ARGS, { seed: bare, tape: null, final: bare });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("not found in the seed state");
  });

  it("tolerates a state export with no labels key at all", () => {
    const bare: GitHubCheckState = { repositories: [{ full_name: "acme/api" }] };
    expect(noNewLabels.evaluate(ARGS, { seed: bare, tape: null, final: bare }).passed).toBe(true);
  });
});
