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
  probeDiscrimination,
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
  // No slots — the sentence is a constant. An empty object is the honest
  // fixture, and it still exercises render/parse/round-trip below.
  "github.no-unsupported-endpoint": {},
  "github.tool-never-called": { tool: "create_commit_status" },
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
  "github.no-unsupported-endpoint":
    "the sentence has no slots at all; the trigger is a fidelity stamp on the tape, " +
    "which no mutation of the criterion text can reach",
  // F-1125, and this one is argument 2 in its sharpest form. The slot is typed to
  // `TAPE_ASSERTABLE_TOOLS`, so the only substitutable value is the OTHER
  // assertable action — which may be equally absent from the tape, moving no
  // verdict — and anything outside the set does not re-bind at all, which reads
  // as "the verdict moved" and would bless the criterion the probe exists to
  // catch. The narrow set is what makes the check safe (it cannot name an action
  // whose REST door is unstamped) and the same narrowness is what costs the
  // mutant. Admitted rather than bought back by widening the slot.
  "github.tool-never-called":
    "the action is a closed set — the only substitution is the other assertable " +
    "action, which can be just as absent from the tape, and a name outside the set " +
    "does not re-bind",
};

// Every check that does NOT name a repository, WITH the reason. Same discipline
// as the ledger above: the rule below is real, and an exception to it has to be
// argued in writing rather than waved through by loosening the assertion.
//
// F-1076 opened this. The repo rule exists to stop a check SELECTING state
// ambiguously — the legacy patterns scanned repositories first-match-wins, so a
// two-repo world graded whichever sorted first. A check that selects no state at
// all cannot have that bug, and naming a repo it never reads would be worse than
// silent: it would tell a reader the assertion is repo-scoped when it is not.
const REPO_FREE_CHECKS: Record<string, string> = {
  "github.no-unsupported-endpoint":
    "asserts about the RUN, not about any repository. It reads the call tape — already " +
    "scoped to this twin by the engine — and selects no repo, so there is no " +
    "first-match-wins hazard for a repo slot to close. A `{repo}` here would be a lie " +
    "about what the predicate compares.",
  // F-1125. Same argument, and it is not a convenience: the predicate compares
  // `event.tool`, a field that names an ACTION and carries no repository at all.
  // A `{repo}` slot could therefore be filled with anything and change no
  // verdict — a selector that selects nothing, which is strictly worse than its
  // absence because a reader would believe the assertion was repo-scoped. The
  // criterion is "did the examinee reach for this forgery anywhere in this run",
  // and the run is already one twin's tape.
  "github.tool-never-called":
    "asserts about the RUN, not about any repository. It compares the recorded `tool` " +
    "action name, which carries no repo, so a `{repo}` slot would change no verdict " +
    "while telling a reader the assertion is repo-scoped.",
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
    //
    // F-1076 — a check that selects NO state cannot have the bug this prevents,
    // so it may sit in `REPO_FREE_CHECKS` with its reason. The exception is
    // ledgered rather than folded into the assertion because "params is empty"
    // would also excuse a state check that simply forgot its selector.
    for (const check of CHECKS) {
      if (REPO_FREE_CHECKS[check.id]) continue;
      expect(
        Object.keys(check.params),
        `${check.id} does not name a repository, so it cannot say which repo it asserts about`,
      ).toContain("repo");
    }
  });

  it("only lets a check skip the repo rule if it reads no state at all", () => {
    // The ledger above is an escape hatch, so it needs its own gate. The ONLY
    // defensible reason to assert without naming a repo is that the check reads
    // the run rather than the world — anything reading `final` or `seed+final`
    // is selecting state and owes the reader a scope.
    for (const id of Object.keys(REPO_FREE_CHECKS)) {
      const check = CHECKS.find((candidate) => candidate.id === id);
      expect(check, `${id} is ledgered REPO_FREE but is not a declared check`).toBeTruthy();
      expect(
        check!.substrate,
        `${id} skips the repo rule but reads state — it must name the repo it asserts about`,
      ).toBe("tape");
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

// Every check that declines to name a failing world, WITH the reason.
//
// It is EMPTY, and that is the claim (F-1126). `HONEST_NULL_MUTANTS` above has
// two unavoidable arguments — a selector-only slot, a closed set with no
// guaranteed-false member. Neither transfers here: a world is a hand-written
// fixture and every field of `CheckSubstrate` is hand-fillable. An entry in this
// ledger is therefore an admission that a check may not be able to fail, which
// is the thing the whole vocabulary exists to rule out.
//
// Keep it empty. If a future check needs a line, argue it in writing here the
// way `REPO_FREE_CHECKS` makes its exceptions argue.
const HONEST_NULL_WORLDS: Record<string, string> = {};

describe("declared discriminating worlds", () => {
  it("names a passing and a failing world for every check, or admits a null in the ledger", () => {
    for (const check of CHECKS) {
      const args = FIXTURES[check.id]!;
      const verdict = probeDiscrimination(check, args);

      if (verdict.kind === "declined") {
        expect(
          HONEST_NULL_WORLDS[check.id],
          `${check.id} names no worlds and gives no reason in HONEST_NULL_WORLDS. A check ` +
            `that cannot demonstrate a failing world may not be able to fail at all.`,
        ).toBeTruthy();
        continue;
      }

      expect(
        HONEST_NULL_WORLDS[check.id],
        `${check.id} names its worlds but is still listed in HONEST_NULL_WORLDS — stale entry`,
      ).toBeUndefined();

      expect(
        verdict.kind === "broken" ? `${check.id}: ${verdict.arm} — ${verdict.detail}` : "discriminates",
      ).toBe("discriminates");
    }
  });

  it("ships an EMPTY null-worlds ledger", () => {
    // Not ceremony. The moment this has an entry, the gate's guarantee weakens
    // from "every check can fail" to "every check can fail or said why not", and
    // that change should require editing this assertion on purpose.
    expect(Object.keys(HONEST_NULL_WORLDS)).toEqual([]);
  });

  it("puts each world on the substrate the check declared", () => {
    // A `final` check handed a seed, or a `tape` check handed none, would pass
    // the arms above while testing a substrate the engine will never give it.
    for (const check of CHECKS) {
      const worlds = check.discriminatingWorlds?.(FIXTURES[check.id]!) ?? null;
      if (worlds === null) continue;
      for (const [side, world] of Object.entries(worlds)) {
        if (check.substrate === "seed+final") {
          expect(world.seed, `${check.id}.${side} declares seed+final but names no seed`).not.toBeNull();
        }
        if (check.substrate === "tape") {
          expect(world.tape, `${check.id}.${side} declares tape but names none`).not.toBeNull();
        }
      }
    }
  });
});
