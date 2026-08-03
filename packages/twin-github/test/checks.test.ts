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
const noNewIssues = (GITHUB_CHECKS as readonly unknown[] as readonly OpenCheck[]).find(
  (check) => check.id === "github.no-new-issues",
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

// The issue-side counterpart. Rows carry the extra fields a real export does, so
// a predicate that reached for `title` or `state` would compile here and then
// disagree with production — the same trap the fixture comment in
// `checks-predicates.test.ts` names.
function issueState(numbers: number[]): GitHubCheckState {
  return {
    repositories: [
      {
        owner: "acme",
        name: "api",
        full_name: "acme/api",
        issues: numbers.map((number) => ({
          number,
          state: "open",
          labels: [{ name: "bug" }],
          assignees: [],
        })),
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

// F-1198 — the sibling. It exists because `support-triage` teaches "do not open
// a duplicate" and, until it, the only way to grade that was `[model]`. The
// tests below are its counterpart to the block above, plus the two that are
// specific to issues rather than labels: the duplicate-with-the-same-title case
// (which is why the comparison is on numbers) and the case where the examinee
// does the RIGHT thing to a seeded issue.
describe("github.no-new-issues — declaration", () => {
  it("renders the sentence an author will pick", () => {
    expect(renderCheck(noNewIssues, ARGS)).toBe("No new issues were created in `acme/api`");
  });

  it("binds that sentence back to its args", () => {
    expect(parseCheck(noNewIssues, "No new issues were created in `acme/api`")).toEqual(ARGS);
  });

  it("declares negative polarity — it can only be broken by the examinee", () => {
    expect(noNewIssues.polarity(ARGS)).toBe("negative");
  });

  it("declares that it needs the seed — it is a delta, not a state assertion", () => {
    expect(noNewIssues.substrate).toBe("seed+final");
  });

  it("declares no vacuity mutant: the repo is a selector, not a scanned literal", () => {
    expect(noNewIssues.vacuityMutant(ARGS)).toBeNull();
  });

  it("declares no subject: nothing here is a literal a redactor could delete", () => {
    expect(noNewIssues.subject?.(ARGS) ?? null).toBeNull();
  });

  it("does not claim the sentence `github.issue-exists` owns", () => {
    expect(parseCheck(noNewIssues, "Issue #1 exists in `acme/api`")).toBeNull();
  });
});

describe("github.no-new-issues — predicate", () => {
  it("passes when the issue set is untouched", () => {
    const outcome = noNewIssues.evaluate(ARGS, {
      seed: issueState([1]),
      tape: null,
      final: issueState([1]),
    });
    expect(outcome.passed).toBe(true);
  });

  // Also THE reason this check compares numbers. A duplicate issue is, by
  // definition, the one that looks most like what it duplicates — same state,
  // same labels, and in the hero example the same title too.
  // `GitHubCheckStateIssue` does not even model `title`, which is itself the
  // point: every field a reader might reach for is one the examinee chose, and
  // the number is the only one it cannot. `issueState` builds both issues
  // identically on every modelled field, so this fails on the number alone — and
  // the reason names only what was created, never the issue that was always there.
  it("fails, naming only the created issue, on a duplicate identical on every modelled field", () => {
    const outcome = noNewIssues.evaluate(ARGS, {
      seed: issueState([1]),
      tape: null,
      final: issueState([1, 2]),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("#2");
    expect(outcome.reason).not.toContain("#1");
  });

  // The green half of the hero lesson: the agent comments on the seeded issue
  // instead of opening a second one. That MUST pass, or the check would grade
  // "the agent did nothing" as the only way through.
  it("passes when the examinee comments on a seeded issue instead of opening a new one", () => {
    const final = issueState([1]);
    final.repositories![0]!.issues![0]!.comments = [{ body: "Same bug re-reported in #support." }];
    expect(noNewIssues.evaluate(ARGS, { seed: issueState([1]), tape: null, final }).passed).toBe(
      true,
    );
  });

  it("does not fail when an issue is CLOSED — the sentence says `new`", () => {
    const final = issueState([1]);
    final.repositories![0]!.issues![0]!.state = "closed";
    expect(noNewIssues.evaluate(ARGS, { seed: issueState([1]), tape: null, final }).passed).toBe(
      true,
    );
  });

  it("does not fail when an issue DISAPPEARS — the sentence says `new`", () => {
    const outcome = noNewIssues.evaluate(ARGS, {
      seed: issueState([1, 2]),
      tape: null,
      final: issueState([1]),
    });
    expect(outcome.passed).toBe(true);
  });

  it("skips, named, when the seed is unavailable rather than passing vacuously", () => {
    const outcome = noNewIssues.evaluate(ARGS, {
      seed: null,
      tape: null,
      final: issueState([1]),
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("seed_missing");
  });

  it("fails when the named repo is absent from the state", () => {
    const outcome = noNewIssues.evaluate(
      { repo: "acme/other" },
      { seed: issueState([1]), tape: null, final: issueState([1]) },
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("acme/other");
  });

  // A seed with no issues at all is the ordinary case for a "the agent must not
  // file anything" task, and the empty-set delta has to behave — an empty
  // `before` must not make every final issue invisible or every final issue new
  // by accident.
  it("passes on a repo with no issues on either side", () => {
    const bare: GitHubCheckState = { repositories: [{ full_name: "acme/api" }] };
    expect(noNewIssues.evaluate(ARGS, { seed: bare, tape: null, final: bare }).passed).toBe(true);
  });

  it("fails when the examinee files the first issue into an empty repo", () => {
    const bare: GitHubCheckState = { repositories: [{ full_name: "acme/api" }] };
    const outcome = noNewIssues.evaluate(ARGS, { seed: bare, tape: null, final: issueState([1]) });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("#1");
  });

  // A row with no usable number is DROPPED, not counted. Counting it would add
  // `NaN` to the set, and `NaN !== NaN`, so a malformed row in the final state
  // would read as a newly created issue on every single run — a false red that
  // no examinee could ever clear.
  it("ignores a malformed issue row rather than reading it as a new issue", () => {
    const final = issueState([1]);
    final.repositories![0]!.issues!.push({ state: "open" });
    expect(noNewIssues.evaluate(ARGS, { seed: issueState([1]), tape: null, final }).passed).toBe(
      true,
    );
  });
});
