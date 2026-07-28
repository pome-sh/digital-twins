// SPDX-License-Identifier: Apache-2.0
//
// The GitHub twin's assertable check vocabulary (F-1073, milestone A2b).
//
// These live HERE, next to the state they read, because the twin owns that
// state's shape. pome-cloud imports this module from npm and adapts each
// declaration onto its predicate engine, so there is no second copy to
// reconcile — only a pin that can fall behind, which is what its drift gate
// exists to catch.

import { defineCheck, repoRef, type CheckDefinition } from "@pome-sh/sdk/checks";

// A narrow, defensive read-model of the slice of `exportState()` these checks
// touch. Every field is optional so a malformed or older export produces a
// named verdict instead of throwing inside a predicate.
export interface GitHubCheckStateLabel {
  name?: string;
}

export interface GitHubCheckStateIssue {
  number?: number;
  // The label names APPLIED to this issue. Deliberately modelled next to the
  // repo-level set below, because the difference between them is the whole
  // reason `no-new-labels` says "in `<repo>`" — see the check's comment.
  labels?: string[] | null;
}

export interface GitHubCheckStateRepo {
  owner?: string;
  name?: string;
  full_name?: string;
  // Repo-level label DEFINITIONS (`listLabels(repo.id)`), not the labels
  // applied to any issue. Only `create_label` grows this set: `addIssueLabels`
  // calls `validationFailed("labels", "missing", …)` for a label the repo does
  // not already define, so an examinee cannot apply a new label without first
  // creating it. That is what makes this check tight.
  labels?: GitHubCheckStateLabel[] | null;
  issues?: GitHubCheckStateIssue[] | null;
}

export interface GitHubCheckState {
  repositories?: GitHubCheckStateRepo[] | null;
}

// `ref` is always `owner/name` — the `repoRef` param type will not parse
// anything else — so there is deliberately no bare-name branch here. The
// owner/name fallback is for a state export that somehow omits `full_name`,
// not for a bare-name reference, which cannot reach this function.
function findRepo(state: GitHubCheckState, ref: string): GitHubCheckStateRepo | null {
  for (const repo of state.repositories ?? []) {
    if (repo.full_name === ref) return repo;
    if (repo.owner != null && repo.name != null && `${repo.owner}/${repo.name}` === ref) return repo;
  }
  return null;
}

function labelNames(repo: GitHubCheckStateRepo): Set<string> {
  const names = new Set<string>();
  for (const label of repo.labels ?? []) {
    if (typeof label.name === "string" && label.name.length > 0) names.add(label.name);
  }
  return names;
}

const noNewLabels: CheckDefinition<GitHubCheckState, { repo: string }> = defineCheck({
  id: "github.no-new-labels",
  // The repo is named on purpose. Without it the sentence reads as an
  // issue-level claim — "the agent did not add labels to the issue" — which is
  // WIDER than what this predicate compares. `create_label` is repo-scoped in
  // GitHub's own vocabulary and `add_issue_labels` is the issue-scoped one, so
  // naming the repo is what tells a reader which of the two is being asserted.
  //
  // An agent that applies an ALREADY-DEFINED label to an issue passes this
  // check, correctly. The assertion that catches that is
  // `Issue #N has exactly one classification label`.
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
  evaluate({ repo }, { seed, final }) {
    // The engine guards this before calling; the check guards too, so a
    // consumer that forgets gets a named skip rather than a vacuous pass.
    if (seed === null) return { passed: false, reason: "seed_missing", status: "skipped" };

    const seedRepo = findRepo(seed, repo);
    if (!seedRepo) return { passed: false, reason: `repo ${repo} not found in the seed state` };
    const finalRepo = findRepo(final, repo);
    if (!finalRepo) return { passed: false, reason: `repo ${repo} not found in state_final` };

    const before = labelNames(seedRepo);
    const created = [...labelNames(finalRepo)].filter((name) => !before.has(name)).sort();
    if (created.length === 0) {
      return {
        passed: true,
        reason: `no labels were created in ${repo} (${before.size} defined at seed, unchanged at finish)`,
      };
    }
    return {
      passed: false,
      reason: `labels created in ${repo}: ${created.map((name) => `\`${name}\``).join(", ")}`,
    };
  },
});

export const GITHUB_CHECKS = [noNewLabels] as const;
