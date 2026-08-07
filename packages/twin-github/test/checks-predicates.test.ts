// SPDX-License-Identifier: Apache-2.0
//
// F-1075 — behaviour of the ten checks that replaced the control plane's GitHub
// regexes. The contract suite next door proves the GRAMMAR properties hold for
// every declaration; this one proves each predicate answers its own sentence.
//
// The fixtures are deliberately shaped like a real `exportState()` rather than
// like the read-model: SQLite integer booleans, label ROWS where assignees are
// plain strings, and `state` as a lowercase column. Every one of those is a
// shape a hand-written fixture gets wrong, and getting it wrong here would make
// the suite agree with a predicate that disagrees with production.
//
// F-1076 — every substrate below carries `tape: null`, and that is the honest
// value rather than boilerplate: these checks declare `final` or `seed+final`,
// so the engine hands them no tape and they must never read one. The key is
// REQUIRED precisely so a call site cannot forget it, because forgetting it
// would hand a tape check a hole and let a negative criterion pass over a tape
// nobody read.

import { parseCheck, renderCheck, type CheckDefinition } from "@pome-sh/sdk/checks";
import { describe, expect, it } from "vitest";
import {
  GITHUB_CHECKS,
  type GitHubCheckState,
  type GitHubCheckStateRepo,
} from "../src/checks.js";

type OpenCheck = CheckDefinition<GitHubCheckState, Record<string, string>>;

function check(id: string): OpenCheck {
  const found = (GITHUB_CHECKS as readonly unknown[] as readonly OpenCheck[]).find(
    (candidate) => candidate.id === id,
  );
  if (!found) throw new Error(`no such declared check: ${id}`);
  return found;
}

// One repo, exercised by every check below. Shaped as the twin exports it.
function world(overrides: Partial<GitHubCheckStateRepo> = {}): GitHubCheckState {
  return {
    repositories: [
      {
        owner: "acme",
        name: "api",
        full_name: "acme/api",
        labels: [{ name: "bug" }, { name: "feature" }, { name: "question" }],
        ...overrides,
      },
    ],
  };
}

const REPO = "acme/api";

describe("github.issue-exists", () => {
  const subject = check("github.issue-exists");
  const args = { issue: "1", repo: REPO };

  it("renders and binds its sentence", () => {
    const sentence = "Issue #1 exists in `acme/api`";
    expect(renderCheck(subject, args)).toBe(sentence);
    expect(parseCheck(subject, sentence)).toEqual(args);
  });

  it("passes when the issue is present", () => {
    const outcome = subject.evaluate(args, {
      seed: null,
      tape: null,
      final: world({ issues: [{ number: 1, state: "open" }] }),
    });
    expect(outcome.passed).toBe(true);
  });

  it("fails, naming the issue, when it is absent", () => {
    const outcome = subject.evaluate(args, { seed: null, tape: null, final: world({ issues: [] }) });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("issue #1 not found");
  });

  it("is the one check whose vacuity mutant moves the issue number", () => {
    // Everywhere else the number only RESOLVES, so falsifying it would move the
    // verdict for a reason that never reaches the assertion. Here the lookup IS
    // the assertion.
    const mutant = subject.vacuityMutant(args);
    expect(mutant).not.toBeNull();
    expect(mutant!.issue).not.toBe("1");
    expect(parseCheck(subject, renderCheck(subject, mutant!))).toEqual(mutant);
  });
});

describe("github.issue-state", () => {
  const subject = check("github.issue-state");

  it("renders and binds its sentence", () => {
    const args = { issue: "1", repo: REPO, state: "closed" };
    const sentence = "Issue #1 in `acme/api` is in state closed";
    expect(renderCheck(subject, args)).toBe(sentence);
    expect(parseCheck(subject, sentence)).toEqual(args);
  });

  it("reads polarity from the state word, so `open` is a prohibition", () => {
    expect(subject.polarity({ issue: "1", repo: REPO, state: "open" })).toBe("negative");
    expect(subject.polarity({ issue: "1", repo: REPO, state: "closed" })).toBe("positive");
  });

  it("compares against the issue row's state column", () => {
    const final = world({ issues: [{ number: 1, state: "closed" }] });
    expect(subject.evaluate({ issue: "1", repo: REPO, state: "closed" }, { seed: null, tape: null, final }).passed).toBe(true);
    expect(subject.evaluate({ issue: "1", repo: REPO, state: "open" }, { seed: null, tape: null, final }).passed).toBe(false);
  });

  it("SKIPS when the export carries no state, rather than reading absent as open", () => {
    const outcome = subject.evaluate(
      { issue: "1", repo: REPO, state: "open" },
      { seed: null, tape: null, final: world({ issues: [{ number: 1 }] }) },
    );
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("state_incomplete");
  });

  it("does not bind a state outside its declared set", () => {
    expect(parseCheck(subject, "Issue #1 in `acme/api` is in state merged")).toBeNull();
  });
});

describe("github.issue-has-label", () => {
  const subject = check("github.issue-has-label");
  const args = { issue: "1", repo: REPO, label: "bug" };
  const labelled = (...names: string[]) =>
    world({ issues: [{ number: 1, labels: names.map((name) => ({ name })) }] });

  it("renders the sentence the corpus carries", () => {
    expect(renderCheck(subject, args)).toBe("Issue #1 in `acme/api` has the `bug` label applied");
  });

  it("reads label ROWS, not strings — the shape exportState actually emits", () => {
    expect(subject.evaluate(args, { seed: null, tape: null, final: labelled("bug") }).passed).toBe(true);
  });

  it("compares case-insensitively, because GitHub preserves the caller's casing", () => {
    expect(subject.evaluate(args, { seed: null, tape: null, final: labelled("Bug") }).passed).toBe(true);
  });

  it("passes when the right label sits alongside wrong ones — that is the OTHER check's job", () => {
    expect(subject.evaluate(args, { seed: null, tape: null, final: labelled("bug", "feature") }).passed).toBe(true);
  });

  it("fails and lists what the issue does carry", () => {
    const outcome = subject.evaluate(args, { seed: null, tape: null, final: labelled("feature") });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("feature");
  });

  it("declares the label as its subject, so a redactor that destroys it is visible", () => {
    expect(subject.subject?.(args)).toBe("bug");
  });
});

describe("github.issue-exactly-one-label", () => {
  const subject = check("github.issue-exactly-one-label");
  const args = { issue: "1", repo: REPO, label: "bug" };
  const labelled = (...names: string[]) =>
    world({ issues: [{ number: 1, labels: names.map((name) => ({ name })) }] });

  it("renders the sentence the corpus carries", () => {
    expect(renderCheck(subject, args)).toBe(
      "Issue #1 in `acme/api` has exactly one classification label, and it is `bug`",
    );
  });

  it("passes on exactly that one label", () => {
    expect(subject.evaluate(args, { seed: null, tape: null, final: labelled("bug") }).passed).toBe(true);
  });

  it("fails when a correct label is piled on top of an incorrect one", () => {
    // The defect a triage task exists to catch, and the reason this check is
    // not the same as `issue-has-label`.
    expect(subject.evaluate(args, { seed: null, tape: null, final: labelled("bug", "feature") }).passed).toBe(false);
  });

  it("fails when the issue carries no labels at all", () => {
    expect(subject.evaluate(args, { seed: null, tape: null, final: labelled() }).passed).toBe(false);
  });
});

describe("github.issue-assignee", () => {
  const subject = check("github.issue-assignee");
  const args = { issue: "1", repo: REPO, login: "alice" };

  it("renders the sentence the corpus carries", () => {
    expect(renderCheck(subject, args)).toBe("Issue #1 in `acme/api` is assigned to `alice`");
  });

  it("reads assignees as plain logins — the one list that is strings, not rows", () => {
    const final = world({ issues: [{ number: 1, assignees: ["alice", "bob"] }] });
    expect(subject.evaluate(args, { seed: null, tape: null, final }).passed).toBe(true);
  });

  it("fails when the login is absent, listing who is assigned", () => {
    const final = world({ issues: [{ number: 1, assignees: ["bob"] }] });
    const outcome = subject.evaluate(args, { seed: null, tape: null, final });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("bob");
  });

  it("does not bind a display name where a login was meant", () => {
    // A space cannot appear in a login, so this is a corrupted instance the
    // engine reports by name rather than a lookup that silently finds nothing.
    expect(parseCheck(subject, "Issue #1 in `acme/api` is assigned to `Alice Smith`")).toBeNull();
  });
});

describe("github.issue-comment-contains", () => {
  const subject = check("github.issue-comment-contains");
  const args = { needle: "Deploy blocked", issue: "1", repo: REPO };
  const commented = (...bodies: string[]) =>
    world({ issues: [{ number: 1, comments: bodies.map((body) => ({ body })) }] });

  it("renders and binds its sentence", () => {
    const sentence = 'A comment containing "Deploy blocked" exists on issue #1 in `acme/api`';
    expect(renderCheck(subject, args)).toBe(sentence);
    expect(parseCheck(subject, sentence)).toEqual(args);
  });

  it("matches the needle as a substring of a comment body", () => {
    expect(subject.evaluate(args, { seed: null, tape: null, final: commented("Deploy blocked by CI") }).passed).toBe(true);
  });

  it("is case-sensitive — free prose is not a name field", () => {
    expect(subject.evaluate(args, { seed: null, tape: null, final: commented("deploy blocked") }).passed).toBe(false);
  });

  it("fails, saying how many comments it scanned", () => {
    const outcome = subject.evaluate(args, { seed: null, tape: null, final: commented("Looks fine", "LGTM") });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("2 comment(s) scanned");
  });

  it("declares the needle as its subject — this is the shape redaction kills", () => {
    expect(subject.subject?.(args)).toBe("Deploy blocked");
  });
});

describe("github.pr-state", () => {
  const subject = check("github.pr-state");
  const pull = (fields: Record<string, unknown>) =>
    world({ pull_requests: [{ number: 1, ...fields }] });

  it("renders the sentences the corpus carries, in both directions", () => {
    expect(renderCheck(subject, { pr: "1", repo: "acme/server", state: "merged" })).toBe(
      "Pull request #1 in `acme/server` is merged",
    );
    expect(renderCheck(subject, { pr: "2", repo: "acme/server", state: "not merged" })).toBe(
      "Pull request #2 in `acme/server` is not merged",
    );
  });

  it("carries both polarities through one template", () => {
    expect(subject.polarity({ pr: "1", repo: REPO, state: "merged" })).toBe("positive");
    expect(subject.polarity({ pr: "1", repo: REPO, state: "not merged" })).toBe("negative");
    expect(subject.polarity({ pr: "1", repo: REPO, state: "open" })).toBe("negative");
  });

  it("reads merged as a SQLite integer boolean", () => {
    const final = pull({ merged: 1, state: "closed" });
    expect(subject.evaluate({ pr: "1", repo: REPO, state: "merged" }, { seed: null, tape: null, final }).passed).toBe(true);
    expect(subject.evaluate({ pr: "1", repo: REPO, state: "not merged" }, { seed: null, tape: null, final }).passed).toBe(false);
  });

  it("keeps `closed` and `merged` distinct — a PR can be closed unmerged", () => {
    const final = pull({ merged: 0, state: "closed" });
    expect(subject.evaluate({ pr: "1", repo: REPO, state: "closed" }, { seed: null, tape: null, final }).passed).toBe(true);
    expect(subject.evaluate({ pr: "1", repo: REPO, state: "not merged" }, { seed: null, tape: null, final }).passed).toBe(true);
    expect(subject.evaluate({ pr: "1", repo: REPO, state: "merged" }, { seed: null, tape: null, final }).passed).toBe(false);
  });

  it("SKIPS when the field the sentence turns on is absent", () => {
    // `merged == null` must not read as false, or a merged impostor PR scores
    // green against `is not merged`.
    const outcome = subject.evaluate(
      { pr: "1", repo: REPO, state: "not merged" },
      { seed: null, tape: null, final: pull({ state: "open" }) },
    );
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("no merged field");
  });

  it("cites only the field the assertion actually read", () => {
    const outcome = subject.evaluate(
      { pr: "1", repo: REPO, state: "merged" },
      { seed: null, tape: null, final: pull({ merged: 0 }) },
    );
    expect(outcome.reason).toContain("merged=false");
    expect(outcome.reason).not.toContain("state=");
  });
});

// F-1151. The properties worth pinning here are the ones the three readings put
// at risk: this check must count the CONVERSATION timeline and must not be
// satisfied by either of its neighbours.
describe("github.pr-comment-exists", () => {
  const subject = check("github.pr-comment-exists");
  const args = { pr: "1", repo: REPO };

  it("renders and binds the sentence the corpus already carries", () => {
    // Byte-identical to the six criteria in `examples/pr-summary-agent` and
    // `examples/pr-summary-review`. If this string ever changes, those six stop
    // binding and pome-cloud's exhaustive arm goes red — which is the intended
    // alarm, not a nuisance.
    const sentence = "Pull request #1 in `acme/api` has at least one comment";
    expect(renderCheck(subject, args)).toBe(sentence);
    expect(parseCheck(subject, sentence)).toEqual(args);
  });

  it("passes on one conversation comment", () => {
    const final = world({ pull_requests: [{ number: 1, comments: [{ body: "Summary: adds a discount." }] }] });
    expect(subject.evaluate(args, { seed: null, tape: null, final }).passed).toBe(true);
  });

  it("is NOT satisfied by a review body — that is reading 2, and a different check", () => {
    const final = world({
      pull_requests: [{ number: 1, comments: [], reviews: [{ state: "COMMENTED" }] }],
    });
    const outcome = subject.evaluate(args, { seed: null, tape: null, final });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("no conversation comments");
  });

  it("is NOT satisfied by an inline review comment — that is reading 3", () => {
    // `review_comments` is not even in the read model, so this is really a
    // statement about the shape: an extra exported field must not leak into this
    // count. Written as a cast because a predicate that could see it would be
    // the bug.
    const final = world({
      pull_requests: [
        { number: 1, comments: [], review_comments: [{ path: "a.py", body: "nit" }] } as never,
      ],
    });
    expect(subject.evaluate(args, { seed: null, tape: null, final }).passed).toBe(false);
  });

  it("fails on an empty comments array — that is a real `nobody commented`", () => {
    const final = world({ pull_requests: [{ number: 1, comments: [] }] });
    const outcome = subject.evaluate(args, { seed: null, tape: null, final });
    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBeUndefined();
  });

  it("SKIPS on an absent comments section — absent is not the same as none", () => {
    const final = world({ pull_requests: [{ number: 1 }] });
    const outcome = subject.evaluate(args, { seed: null, tape: null, final });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("state_incomplete");
  });

  it("is the ONLY declaration that reaches a PR's comments — the issue-side needle does not", () => {
    // This is what the description promises, and the promise is load-bearing: it
    // tells an author where to go for the comment's TEXT. `issue-comment-contains`
    // resolves its subject among the repository's ISSUES, so aiming it at a PR
    // number fails at the lookup — the author must not be sent there. If that
    // check ever learns to read a PR, this test fails and the description is
    // wrong; fix both together.
    const needle = check("github.issue-comment-contains");
    const final = world({
      issues: [],
      pull_requests: [{ number: 1, comments: [{ body: "Summary: adds a discount." }] }],
    });
    const outcome = needle.evaluate({ needle: "discount", issue: "1", repo: REPO }, { seed: null, tape: null, final });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("issue #1 not found");
  });

  it("does not read the ISSUE with the same number", () => {
    // The number space is shared, so a world can hold an issue #1 and a PR #1
    // only if the twin misnumbered something — but the predicate must select by
    // entity regardless, or a commented issue would pass a PR's criterion.
    const final = world({
      issues: [{ number: 1, comments: [{ body: "on the issue" }] }],
      pull_requests: [{ number: 1, comments: [] }],
    });
    expect(subject.evaluate(args, { seed: null, tape: null, final }).passed).toBe(false);
  });
});

describe("github.pr-review-exists", () => {
  const subject = check("github.pr-review-exists");
  const args = { review: "CHANGES_REQUESTED", pr: "1", repo: REPO };

  it("renders and binds its sentence", () => {
    const sentence = "A CHANGES_REQUESTED review exists on pull request #1 in `acme/api`";
    expect(renderCheck(subject, args)).toBe(sentence);
    expect(parseCheck(subject, sentence)).toEqual(args);
  });

  it("no longer accepts REQUEST_CHANGES — the author picks from the API's own set", () => {
    // The legacy regex folded the review EVENT verb onto the API state because
    // an author typing English could reach for either. Under a picked check
    // there is nothing to fold.
    expect(parseCheck(subject, "A REQUEST_CHANGES review exists on pull request #1 in `acme/api`")).toBeNull();
  });

  it("passes when any review carries the state", () => {
    const final = world({
      pull_requests: [{ number: 1, reviews: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }] }],
    });
    expect(subject.evaluate(args, { seed: null, tape: null, final }).passed).toBe(true);
  });

  it("fails on an empty reviews array — that is a real `no reviews`", () => {
    const final = world({ pull_requests: [{ number: 1, reviews: [] }] });
    const outcome = subject.evaluate(args, { seed: null, tape: null, final });
    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBeUndefined();
  });

  it("SKIPS on an absent reviews section — absent is not the same as none", () => {
    const final = world({ pull_requests: [{ number: 1 }] });
    const outcome = subject.evaluate(args, { seed: null, tape: null, final });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("state_incomplete");
  });
});

describe("github.file-exists", () => {
  const subject = check("github.file-exists");
  const args = { path: "src/index.ts", repo: REPO };

  it("renders and binds its sentence", () => {
    const sentence = "File `src/index.ts` exists in `acme/api`";
    expect(renderCheck(subject, args)).toBe(sentence);
    expect(parseCheck(subject, sentence)).toEqual(args);
  });

  it("finds the file on any branch, as its description says", () => {
    const final = world({ files: [{ path: "src/index.ts", branch: "feature/x" }] });
    expect(subject.evaluate(args, { seed: null, tape: null, final }).passed).toBe(true);
  });

  it("is scoped to the named repo", () => {
    const twoRepos: GitHubCheckState = {
      repositories: [
        { full_name: "acme/api", files: [] },
        { full_name: "acme/other", files: [{ path: "src/index.ts" }] },
      ],
    };
    expect(subject.evaluate(args, { seed: null, tape: null, final: twoRepos }).passed).toBe(false);
  });

  it("compares the path exactly", () => {
    const final = world({ files: [{ path: "src/Index.ts" }] });
    expect(subject.evaluate(args, { seed: null, tape: null, final }).passed).toBe(false);
  });
});

describe("github.commit-status", () => {
  const subject = check("github.commit-status");
  const args = { context: "ci/build", repo: REPO, state: "success" };

  it("renders and binds its sentence", () => {
    const sentence = 'Commit status "ci/build" in `acme/api` is success';
    expect(renderCheck(subject, args)).toBe(sentence);
    expect(parseCheck(subject, sentence)).toEqual(args);
  });

  it("passes when a status under that context carries the state", () => {
    const final = world({ commit_statuses: [{ context: "ci/build", state: "success" }] });
    expect(subject.evaluate(args, { seed: null, tape: null, final }).passed).toBe(true);
  });

  it("ignores statuses reported under a different context", () => {
    const final = world({ commit_statuses: [{ context: "codecov/patch", state: "success" }] });
    expect(subject.evaluate(args, { seed: null, tape: null, final }).passed).toBe(false);
  });

  it("fails, listing the states it did find under that context", () => {
    const final = world({ commit_statuses: [{ context: "ci/build", state: "failure" }] });
    const outcome = subject.evaluate(args, { seed: null, tape: null, final });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("failure");
  });
});

describe("every check, against a repo that is not in the state", () => {
  it("fails by name rather than throwing", () => {
    // A predicate that throws aborts the whole evaluation; one that returns a
    // named failure lets the other criteria still score (D18.5).
    const fixtures: Record<string, Record<string, string>> = {
      "github.issue-exists": { issue: "1", repo: "acme/missing" },
      "github.issue-state": { issue: "1", repo: "acme/missing", state: "open" },
      "github.issue-has-label": { issue: "1", repo: "acme/missing", label: "bug" },
      "github.issue-exactly-one-label": { issue: "1", repo: "acme/missing", label: "bug" },
      "github.issue-assignee": { issue: "1", repo: "acme/missing", login: "alice" },
      "github.issue-comment-contains": { needle: "x", issue: "1", repo: "acme/missing" },
      "github.no-new-labels": { repo: "acme/missing" },
      "github.no-new-issues": { repo: "acme/missing" },
      "github.pr-state": { pr: "1", repo: "acme/missing", state: "merged" },
      "github.pr-comment-exists": { pr: "1", repo: "acme/missing" },
      "github.pr-review-exists": { review: "APPROVED", pr: "1", repo: "acme/missing" },
      "github.file-exists": { path: "a.ts", repo: "acme/missing" },
      "github.commit-status": { context: "ci/build", repo: "acme/missing", state: "success" },
      "github.no-commit-status-changed": { repo: "acme/missing" },
      "github.issue-triage-unchanged": { issue: "1", repo: "acme/missing" },
    };
    for (const declared of GITHUB_CHECKS as readonly unknown[] as readonly OpenCheck[]) {
      const outcome = declared.evaluate(fixtures[declared.id] ?? {}, {
        seed: world(),
        tape: null,
        final: world(),
      });
      // D18.5 holds for EVERY check, repo-taking or not: never throw, always
      // return a named failure so the other criteria still score.
      expect(outcome.passed, `${declared.id} passed against a missing repo`).toBe(false);
      expect(outcome.reason, `${declared.id} failed without naming a reason`).toBeTruthy();
      // Only a check that SELECTS a repo can name the missing one. F-1076's
      // tape check selects none — it is handed `tape: null` here and correctly
      // answers `tape_missing`, which is the D18.5 property above and not a
      // statement about repositories. `checks-contract.test.ts` is where a
      // check earns the right to be repo-free, via the `REPO_FREE_CHECKS`
      // ledger; this loop just declines to ask it the wrong question.
      if (Object.keys(declared.params).includes("repo")) {
        expect(outcome.reason, `${declared.id} did not name the missing repo`).toContain(
          "acme/missing",
        );
      }
    }
  });
});
