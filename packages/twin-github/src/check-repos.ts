// SPDX-License-Identifier: Apache-2.0
//
// What GitHub's declared checks can assert about a REPOSITORY —
// its label set, its files, and the statuses reported against its commits.
//
// Declarations only. The grammar rules they all obey are in `checks.ts`, which
// assembles them; how the exported tree is read is in `check-state.ts`.

import { childStatePath, defineCheck, repoRef, VACUITY_SENTINEL } from "@pome-sh/sdk/checks";
import { commitStatusState, filePath, statusContext } from "./check-params.js";
import { issueNumbers, labelNames, missOutcome, resolveRepo } from "./check-state.js";
import { deltaWorld, finalWorld, repoState } from "./check-worlds.js";
import type { Check } from "./check-kind.js";

export const noNewLabels: Check<{ repo: string }> = defineCheck({
  id: "github.no-new-labels",
  // The same explanation the comment below carries, in the one place
  // an author can actually reach it.
  description:
    "Compares the repository's label DEFINITIONS in the seed against the final state. " +
    "Applying an ALREADY-DEFINED label to an issue PASSES this check — only creating a " +
    "label the repo did not already define fails it. `addIssueLabels` rejects an undefined " +
    "label, so an examinee cannot apply a new one without creating it first, which is what " +
    "makes this tight. Needs the seed: it is a delta, not a state assertion.",
  // The repo is named on purpose. Without it the sentence reads as an
  // issue-level claim — "the agent did not add labels to the issue" — which is
  // WIDER than what this predicate compares. `create_label` is repo-scoped in
  // GitHub's own vocabulary and `add_issue_labels` is the issue-scoped one, so
  // naming the repo is what tells a reader which of the two is being asserted.
  //
  // An agent that applies an ALREADY-DEFINED label to an issue passes this
  // check, correctly. The assertion that catches that is
  // `Issue #N … has exactly one classification label`.
  template: "No new labels were created in `{repo}`",
  params: { repo: repoRef },
  // The whole point: this is a delta, and it is unanswerable without the seed.
  substrate: "seed+final",
  // It should PASS on the untouched seed and can only be broken by the
  // examinee acting.
  polarity: () => "negative",
  // Nothing here is a caller-supplied literal hunted for inside the state, so
  // there is nothing a redactor could silently delete out from under it.
  subject: () => null,
  // The repo is a SELECTOR, not a scanned value. Falsifying it would move the
  // verdict ("repo not found") for a reason that never reaches the assertion —
  // a clean bill this check did not earn. Reported as `no_trigger`.
  vacuityMutant: () => null,
  // The only seed+final check, so its worlds are the only ones naming a seed.
  // The failing world's final gains a definition the seed did not have, which is
  // the delta itself.
  discriminatingWorlds: () => ({
    passing: deltaWorld(repoState({ labels: [{ name: "bug" }] }), repoState({ labels: [{ name: "bug" }] })),
    failing: deltaWorld(
      repoState({ labels: [{ name: "bug" }] }),
      repoState({ labels: [{ name: "bug" }, { name: "invented" }] }),
    ),
  }),
  evaluate({ repo }, { seed, final }) {
    // The engine guards this before calling; the check guards too, so a
    // consumer that forgets gets a named skip rather than a vacuous pass.
    if (seed === null) return { passed: false, reason: "seed_missing", status: "skipped" };

    // The SEED-side refusal cites nothing. `missOutcome` carries the pointer the
    // lookup walked, and this one walked the seed — a pointer always addresses
    // `final` (the sdk's `check-state-path.ts` says why), so passing it through
    // would send a reader into the tree the report does not render, at a path
    // that may well resolve to an unrelated repo. The reason still names the miss.
    const seedRepo = resolveRepo(seed, repo, "the seed state");
    if ("missing" in seedRepo) return missOutcome({ ...seedRepo, searched: undefined });
    const finalRepo = resolveRepo(final, repo, "state_final");
    if ("missing" in finalRepo) return missOutcome(finalRepo);

    const before = labelNames(seedRepo.found);
    const created = [...labelNames(finalRepo.found)].filter((name) => !before.has(name)).sort();
    // The only seed+final check, and the one that shows why a pointer
    // addresses `final` rather than the substrate the assertion ranges over.
    // The delta is computed from two trees; the reader has ONE on screen. So the
    // citation is the final definition set — the side a reader can look at — and
    // the reason carries the comparison. Pointing into a seed nothing renders
    // would move the dead affordance rather than remove it.
    const definitions = [childStatePath(finalRepo.path, "labels")];
    if (created.length === 0) {
      return {
        passed: true,
        reason: `no labels were created in ${repo} (${before.size} defined at seed, unchanged at finish)`,
        evidenceStatePaths: definitions,
      };
    }
    return {
      passed: false,
      reason: `labels created in ${repo}: ${created.map((name) => `\`${name}\``).join(", ")}`,
      evidenceStatePaths: definitions,
    };
  },
});

// The sibling of `noNewLabels`, and it exists because the curriculum's
// hero lesson could not be graded without it: `support-triage` teaches "do not
// open a second issue for a bug that is already tracked", and until this check
// the only way to say that was `[model]`. An agent that comments on the right
// issue, posts the right link, AND ALSO files a duplicate scored 100 — which is
// τ-bench's necessary-but-not-sufficient caveat arriving in our own catalog
// (`docs/curriculum/failure-classes.md` §4.2, which names the rule we were
// breaking).
//
// Modelled on `noNewLabels` rather than invented: same delta substrate, same
// negative polarity, same "the repo is a selector" mutant argument. The one
// difference worth stating is WHAT is compared. Labels compare NAMES because a
// label is identified by its name; issues compare NUMBERS, because the number is
// the only field an examinee cannot choose — a duplicate issue may carry the
// same title, body and labels as the one it duplicates, and comparing any of
// those would let a duplicate hide behind its own likeness.
export const noNewIssues: Check<{ repo: string }> = defineCheck({
  id: "github.no-new-issues",
  description:
    "Compares the issue NUMBERS present in the seed against the final state, and fails when " +
    "finish carries one the seed did not. Numbers, not titles: a duplicate issue usually " +
    "carries the same title as the one it duplicates. It says nothing about what happened to " +
    "the seeded issues — closing, relabelling or commenting on one all PASS this check, so " +
    "pair it with `github.issue-state` or `github.issue-comment-contains` when those matter. " +
    "Its natural use is the inverse of `github.issue-exists`: a task whose examinee must " +
    "recognise that an issue already exists and NOT open another. Needs the seed: it is a " +
    "delta, not a state assertion.",
  // The repo is named for `noNewLabels`'s reason, one step stronger: without it
  // the sentence reads as a claim about the whole world, and issue numbers are
  // per-repository — `#2` in one repo has nothing to do with `#2` in another.
  template: "No new issues were created in `{repo}`",
  params: { repo: repoRef },
  substrate: "seed+final",
  // Passes on the untouched seed; only the examinee acting can break it.
  polarity: () => "negative",
  // Nothing is hunted inside free text, so there is nothing a redactor could
  // delete out from under this check.
  subject: () => null,
  // Same admission `noNewLabels` makes: the repo SELECTS, it is not a scanned
  // literal. Falsifying it moves the verdict to "repo not found" for a reason
  // that never reaches the comparison — a clean bill this check did not earn.
  vacuityMutant: () => null,
  discriminatingWorlds: () => ({
    passing: deltaWorld(
      repoState({ issues: [{ number: 1 }] }),
      repoState({ issues: [{ number: 1 }] }),
    ),
    failing: deltaWorld(
      repoState({ issues: [{ number: 1 }] }),
      repoState({ issues: [{ number: 1 }, { number: 2 }] }),
    ),
  }),
  evaluate({ repo }, { seed, final }) {
    // The engine guards this before calling; guarding here too means a consumer
    // that forgets gets a named skip rather than a vacuous pass.
    if (seed === null) return { passed: false, reason: "seed_missing", status: "skipped" };

    // The seed-side refusal cites nothing, for the reason `noNewLabels` states
    // at the same line: a pointer always addresses `final`, so handing back one
    // the lookup walked in the SEED would send a reader into a tree the report
    // never renders. The reason still names the miss.
    const seedRepo = resolveRepo(seed, repo, "the seed state");
    if ("missing" in seedRepo) return missOutcome({ ...seedRepo, searched: undefined });
    const finalRepo = resolveRepo(final, repo, "state_final");
    if ("missing" in finalRepo) return missOutcome(finalRepo);

    const before = issueNumbers(seedRepo.found);
    const created = [...issueNumbers(finalRepo.found)]
      .filter((number) => !before.has(number))
      .sort((a, b) => a - b);
    // The final issue LIST, not the rows that broke it — the same citation
    // `noNewLabels` makes and for the same reason. The delta is computed from
    // two trees and the reader has one on screen, so the honest pointer is the
    // collection they can count for themselves; the reason carries the
    // comparison. On a failure it is also the only pointer that resolves: the
    // numbers named in the reason are exactly the rows the seed does not have.
    const issues = [childStatePath(finalRepo.path, "issues")];
    if (created.length === 0) {
      return {
        passed: true,
        reason: `no issues were created in ${repo} (${before.size} at seed, unchanged at finish)`,
        evidenceStatePaths: issues,
      };
    }
    return {
      passed: false,
      reason: `issues created in ${repo}: ${created.map((number) => `#${number}`).join(", ")}`,
      evidenceStatePaths: issues,
    };
  },
});

export const fileExists: Check<{ path: string; repo: string }> = defineCheck({
  id: "github.file-exists",
  description:
    "Asserts a file with this exact path exists in the repository on ANY branch — the twin " +
    "exports files per branch and this check does not distinguish them, so a file committed " +
    "only to a side branch satisfies it. The path is compared exactly and case-sensitively; " +
    "it asserts nothing about the file's contents.",
  template: "File `{path}` exists in `{repo}`",
  params: { path: filePath, repo: repoRef },
  substrate: "final",
  polarity: () => "positive",
  subject: ({ path }) => path,
  // The path IS the scanned literal.
  vacuityMutant: (args) => ({ ...args, path: `${VACUITY_SENTINEL}.txt` }),
  discriminatingWorlds: ({ path }) => ({
    passing: finalWorld(repoState({ files: [{ path }] })),
    failing: finalWorld(repoState({ files: [{ path: "some/other/file.ts" }] })),
  }),
  evaluate({ path, repo }, { final }) {
    const found = resolveRepo(final, repo, "state_final");
    if ("missing" in found) return missOutcome(found);
    const files = found.found.files ?? [];
    const passed = files.some((file) => file.path === path);
    return {
      passed,
      reason: passed
        ? `file exists at "${path}" in ${repo}`
        : `no file found at "${path}" in ${repo} (${files.length} file(s) exported)`,
      evidenceStatePaths: [childStatePath(found.path, "files")],
    };
  },
});

export const commitStatus: Check<{ context: string; repo: string; state: string }> = defineCheck({
  id: "github.commit-status",
  description:
    "Asserts at least one commit status reported under this context carries this state. It " +
    "does not say WHICH commit: the twin exports every status row for the repo and this " +
    "check scans them all, so a green status on an old commit satisfies it. Nor does it " +
    "assert the status is the latest one for that context.",
  template: 'Commit status "{context}" in `{repo}` is {state}',
  params: { context: statusContext, repo: repoRef, state: commitStatusState },
  substrate: "final",
  polarity: () => "positive",
  subject: ({ context }) => context,
  // No falsifiable trigger, and this one is a DELIBERATE loss against the regex
  // it replaces. The legacy rule mutated the state word, which worked only
  // because `(\w+)` would accept an invented sentinel. Typing the state as a
  // closed set is the right call — an author picks from four real values — but
  // a closed set has no guaranteed-false member, so a mutant could assert a
  // different state that happens to also be true and report a clean bill this
  // check did not earn. Mutating the context instead would empty the candidate
  // set and move the verdict without the state comparison ranging over
  // anything, which is the same false clean bill one step earlier. `no_trigger`
  // is the honest answer.
  vacuityMutant: () => null,
  // The failing world keeps the CONTEXT and moves the STATE. Dropping the
  // context instead would empty the candidate set and produce a reason about
  // nothing having been found, which is the shape arm 3 distrusts.
  discriminatingWorlds: ({ context, state }) => ({
    passing: finalWorld(repoState({ commit_statuses: [{ context, state }] })),
    failing: finalWorld(
      repoState({ commit_statuses: [{ context, state: state === "failure" ? "success" : "failure" }] }),
    ),
  }),
  evaluate({ context, repo, state }, { final }) {
    const found = resolveRepo(final, repo, "state_final");
    if ("missing" in found) return missOutcome(found);
    const candidates = (found.found.commit_statuses ?? []).filter(
      (row) => row.context === context,
    );
    const passed = candidates.some((row) => (row.state ?? "").toLowerCase() === state);
    return {
      passed,
      reason: passed
        ? `commit status "${context}" is "${state}" in ${repo}`
        : `no commit status "${context}" with state "${state}" in ${repo} ` +
          `(found: [${candidates.map((row) => row.state).join(", ")}])`,
      // Every status row, not the filtered candidates. The filter is part of the
      // assertion — "which commit" is explicitly not asserted — and a pointer at
      // a set this check computed rather than a set the tree holds would address
      // nothing a reader could open.
      evidenceStatePaths: [childStatePath(found.path, "commit_statuses")],
    };
  },
});
