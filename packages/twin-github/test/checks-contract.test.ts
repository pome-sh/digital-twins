// The properties every declared check must hold, carried over from
// pome-cloud's `registry.test.ts` when the declaration moved to the twin.
//
// These are load-bearing, not ceremony: D10 and D11 were both caught by the
// mutant assertions, and reverting a mutant to a resolved selector left that
// suite green until the honest-null ledger existed. They travel with the
// declaration so the twin, not its consumer, is where a bad check is stopped.

import {
  checkNearMissPattern,
  checkPattern,
  parseCheck,
  renderCheck,
  type CheckDefinition,
  type CheckSubstrateKind,
} from "@pome-sh/sdk/checks";
import { describe, expect, it } from "vitest";
import { GITHUB_CHECKS, type GitHubCheckState } from "../src/checks.js";

// The declarations are a heterogeneous tuple, so iterating them yields a union
// whose args type differs per check, while the fixtures below are looked up by
// id at run time. That tie cannot be made statically — erase it once here
// rather than casting at a dozen call sites.
type OpenCheck = CheckDefinition<GitHubCheckState, Record<string, string>>;
const CHECKS = GITHUB_CHECKS as readonly unknown[] as readonly OpenCheck[];

// Representative args per check, used to exercise render/parse/mutant. The
// coverage assertion below makes this table impossible to forget: a new check
// with no fixture fails rather than silently skipping every property here.
const FIXTURES: Record<string, Record<string, string>> = {
  "github.no-new-labels": { repo: "acme/api" },
  "github.issue-exists": { issue: "1", repo: "acme/api" },
  "github.issue-state": { issue: "1", repo: "acme/api", state: "closed" },
  "github.issue-has-label": { issue: "1", repo: "acme/api", label: "bug" },
  "github.issue-exactly-one-label": { issue: "1", repo: "acme/api", label: "bug" },
  "github.issue-assignee": { issue: "1", repo: "acme/api", login: "alice" },
  "github.issue-comment-contains": { needle: "Deploy blocked", issue: "1", repo: "acme/api" },
  "github.pr-state": { pr: "1", repo: "acme/api", state: "not merged" },
  "github.pr-review-exists": { review: "APPROVED", pr: "1", repo: "acme/api" },
  "github.file-exists": { path: "src/index.ts", repo: "acme/api" },
  "github.commit-status": { context: "ci/build", repo: "acme/api", state: "success" },
};

// Every check whose `vacuityMutant` returns null, WITH the reason. A null
// mutant is an admitted blind spot; admitting it in a ledger is what keeps it
// from becoming a habit.
//
// There are exactly two arguments that earn a line here, and F-1075 added the
// second:
//   1. THE PARAMETER ONLY SELECTS. Falsifying it moves the verdict for a reason
//      that never reaches the assertion — a clean bill the check did not earn.
//   2. THE PARAMETER IS A CLOSED SET. Typing a slot as `oneOf` means no member
//      is guaranteed false, so a mutant could assert a different state that
//      happens to be true as well. This is the price of the closed set, and it
//      is worth paying — but it must be admitted, not hidden.
const HONEST_NULL_MUTANTS: Record<string, string> = {
  "github.no-new-labels": "the repo is a selector, not a scanned literal",
  "github.issue-state": "the state is a closed set; the issue number only selects",
  "github.pr-state": "the state is a closed set; the PR number only selects",
  "github.pr-review-exists": "the review state is a closed set; the PR number only selects",
  "github.commit-status":
    "the status state is a closed set, and the context only filters the candidate rows",
};

const SUBSTRATES: CheckSubstrateKind[] = ["final", "seed+final", "tape"];

describe("declared check identity", () => {
  it("declares a non-empty, twin-prefixed id for every check", () => {
    for (const check of CHECKS) {
      expect(check.id, "every check needs an id").toBeTruthy();
      expect(check.id.startsWith("github."), `${check.id} must be namespaced <twin>.<what>`).toBe(
        true,
      );
    }
  });

  it("keeps ids unique across the twin's declarations", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const check of CHECKS) {
      if (seen.has(check.id)) duplicates.push(check.id);
      seen.add(check.id);
    }
    expect(duplicates, `duplicate check ids: ${duplicates.join(", ")}`).toEqual([]);
  });

  it("declares polarity and a vacuity mutant on every check", () => {
    for (const check of CHECKS) {
      expect(typeof check.polarity, `${check.id}.polarity`).toBe("function");
      expect(typeof check.vacuityMutant, `${check.id}.vacuityMutant`).toBe("function");
    }
  });

  it("declares a known substrate on every check", () => {
    for (const check of CHECKS) {
      expect(SUBSTRATES, `${check.id}.substrate`).toContain(check.substrate);
    }
  });

  it("has a fixture for every check, so no check skips the properties below", () => {
    const missing = CHECKS.filter((check) => !FIXTURES[check.id]).map((check) => check.id);
    expect(missing, `checks with no FIXTURES entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("says what the predicate actually compares, in words the sentence does not carry", () => {
    // The one defect this architecture makes EASIER, not harder: a rendered
    // sentence wider or narrower than its check (Shankar et al., UIST '24
    // §7.3.3 — readable surfaces hide the disagreement code makes visible).
    // `No new labels were created in <repo>` reads as an issue-level claim; the
    // predicate compares repo-level label DEFINITIONS. An authoring surface can
    // only show what is declared, so the gap has to close here.
    for (const check of CHECKS) {
      expect(check.description?.trim(), `${check.id} declares no description`).toBeTruthy();
      expect(
        check.description.trim(),
        `${check.id}'s description just restates its template — it must say what the ` +
          `predicate COMPARES, which is the thing the sentence cannot carry`,
      ).not.toBe(check.template);
    }
  });
});

describe("declared check grammar", () => {
  it("round-trips render -> parse -> render byte-identically", () => {
    for (const check of CHECKS) {
      const args = FIXTURES[check.id]!;
      const rendered = renderCheck(check, args);
      const parsed = parseCheck(check, rendered);
      expect(parsed, `${check.id}: its own rendered sentence must parse`).toEqual(args);
      expect(renderCheck(check, parsed!), `${check.id}: round trip changed the bytes`).toBe(
        rendered,
      );
    }
  });

  it("binds its own rendered sentence and nothing wider", () => {
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      expect(checkPattern(check).test(rendered), `${check.id} must match itself`).toBe(true);
      expect(
        checkPattern(check).test(`${rendered} and also something else`),
        `${check.id} is not anchored`,
      ).toBe(false);
    }
  });

  it("treats its own rendered sentence as a match, never as a near miss", () => {
    // The near-miss pattern is what turns a corrupted instance into a hard,
    // named failure downstream. If a check's VALID sentence were only a near
    // miss, every correct use of it would be reported as corrupt.
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      expect(checkNearMissPattern(check).test(rendered)).toBe(true);
      expect(checkPattern(check).test(rendered)).toBe(true);
    }
  });

  it("binds no OTHER check's valid sentence", () => {
    // F-1075. With one declaration this was unfalsifiable; with eleven it is
    // the property that makes the set a vocabulary rather than a pile. Two
    // checks that both claim one sentence is the wrong-match bug the exhaustive
    // invariant (D6) exists to compute — this is its per-twin half, held here so
    // a new declaration cannot ship broken and be caught only downstream.
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      const claimants = CHECKS.filter((other) => checkPattern(other).test(rendered)).map(
        (other) => other.id,
      );
      expect(claimants, `"${rendered}" is claimed by more than one check`).toEqual([check.id]);
    }
  });

  it("reports a corrupted instance as its OWN check, not a neighbour's", () => {
    // Near-miss patterns open every slot to `.+?`, so a broad template can
    // shadow a narrow one and a corrupted sentence gets reported under the
    // wrong name — an error message pointing an author at a check they did not
    // use. Requiring each valid sentence to near-miss only its own check keeps
    // that impossible.
    for (const check of CHECKS) {
      const rendered = renderCheck(check, FIXTURES[check.id]!);
      const resemblers = CHECKS.filter((other) =>
        checkNearMissPattern(other).test(rendered),
      ).map((other) => other.id);
      expect(resemblers, `"${rendered}" resembles more than one check's template`).toEqual([
        check.id,
      ]);
    }
  });

  it("names the repository in every check, so no assertion is repo-ambiguous", () => {
    // F-1075. The legacy patterns took `in owner/repo` as an OPTIONAL qualifier
    // and, absent it, scanned repositories first-match-wins — so in a two-repo
    // world a criterion silently graded whichever sorted first. Under a picked
    // check the repo costs the author nothing, so the ambiguity is simply
    // removed. Asserting it here keeps a future declaration from reintroducing
    // it for the convenience of a shorter sentence.
    for (const check of CHECKS) {
      expect(
        Object.keys(check.params),
        `${check.id} does not name a repository, so it cannot say which repo it asserts about`,
      ).toContain("repo");
    }
  });
});

describe("declared vacuity mutants", () => {
  it("either produces a re-bindable mutant sentence, or admits a null in the ledger", () => {
    for (const check of CHECKS) {
      const args = FIXTURES[check.id]!;
      const mutantArgs = check.vacuityMutant(args);

      if (mutantArgs === null) {
        expect(
          HONEST_NULL_MUTANTS[check.id],
          `${check.id} returns a null mutant but gives no reason in HONEST_NULL_MUTANTS. ` +
            `A check with no falsifiable literal is an admitted blind spot; admit it here.`,
        ).toBeTruthy();
        continue;
      }

      expect(
        HONEST_NULL_MUTANTS[check.id],
        `${check.id} produces a mutant but is still listed in HONEST_NULL_MUTANTS — stale entry`,
      ).toBeUndefined();

      const original = renderCheck(check, args);
      const mutant = renderCheck(check, mutantArgs);
      expect(mutant, `${check.id}: the mutant must differ from the sentence it falsifies`).not.toBe(
        original,
      );
      expect(
        parseCheck(check, mutant),
        `${check.id}: the mutant must still bind to this check, or the probe measures nothing`,
      ).toEqual(mutantArgs);
    }
  });
});
