// SPDX-License-Identifier: Apache-2.0
//
// How a declared check READS the exported GitHub tree (F-1075).
//
// Split from `checks.ts` so that file is only declarations: what the vocabulary
// can assert is a different question from how the tree is shaped, and the tree
// is the half that moves when the twin's schema does.
//
// Every field is optional and every list nullable. `exportState()` spreads raw
// SQLite rows (`domain/github-domain.ts:203`), so an older snapshot, a partial
// upload, or a schema that gained a column all arrive here as absent fields. A
// predicate that assumes presence throws inside the evaluator; one that reads
// this model returns a NAMED verdict instead, which is the whole D4 bargain —
// a criterion may leave the denominator, but it may never fabricate one.
//
// Three shapes are worth naming because they are counter-intuitive and each has
// already caused a wrong verdict somewhere:
//   - `pull_request.merged` is `0 | 1`, not a boolean (SQLite integer boolean).
//   - `issue.labels` and `repository.labels` are ROW OBJECTS (`{name, color,
//     description}`), not strings — while `issue.assignees` IS `string[]` of
//     logins, because the domain resolves it through a separate join.
//   - `repository.labels` (definitions) and `issue.labels` (applied) are
//     different sets. Confusing them is the defect `github.no-new-labels`'s
//     description exists to prevent.
//
// F-1197 — the resolvers below also return the POINTER they walked, so a check
// can cite where it looked. Nothing else about them changed; the shapes above
// are still the only thing that decides how the tree is read.

import { childStatePath, statePath, type CheckOutcome } from "@pome-sh/sdk/checks";

export interface GitHubCheckStateLabel {
  name?: string;
}

export interface GitHubCheckStateComment {
  body?: string;
}

export interface GitHubCheckStateIssue {
  number?: number;
  // "open" | "closed" on a well-formed export. Typed loosely so a snapshot
  // carrying an unknown state produces a comparison that fails honestly rather
  // than a type error at the boundary.
  state?: string | null;
  // The label ROWS applied to this issue — objects, not strings. Deliberately
  // modelled next to the repo-level definition set below, because the
  // difference between them is the whole reason `no-new-labels` says
  // "in `<repo>`".
  labels?: GitHubCheckStateLabel[] | null;
  // Plain logins. `listIssueAssignees` maps the join down to `row.login`, so
  // this one really is `string[]` where its neighbours are row objects.
  assignees?: string[] | null;
  comments?: GitHubCheckStateComment[] | null;
}

export interface GitHubCheckStateReview {
  // "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" — the raw review row's
  // `state` column, exported verbatim.
  state?: string | null;
}

export interface GitHubCheckStatePullRequest {
  number?: number;
  state?: string | null;
  // SQLite integer boolean. `merged === 1`, never `merged === true`, on a real
  // export — both are accepted so a hand-written fixture also works.
  merged?: number | boolean | null;
  // ABSENT on a snapshot predating review export, which is NOT the same as an
  // empty array. The predicate has to tell those apart or it fails a correct
  // agent for a gap in the recording.
  reviews?: GitHubCheckStateReview[] | null;
  // The CONVERSATION timeline (F-1151) — the same shape as `issue.comments`
  // because it is the same table, which is what GitHub does too. Not
  // `reviews[].body` and not `review_comments[]`: those are two other things a
  // reader could reasonably call "a comment on the PR", and the whole point of
  // modelling this field separately is that a predicate can name which one it
  // read. Nullable for the same reason `reviews` is — absent means a snapshot
  // that predates PR-comment export, and absent is not none.
  comments?: GitHubCheckStateComment[] | null;
}

export interface GitHubCheckStateCommitStatus {
  context?: string;
  // "error" | "failure" | "pending" | "success".
  state?: string | null;
}

export interface GitHubCheckStateFile {
  path?: string;
  branch?: string;
}

export interface GitHubCheckStateRepo {
  owner?: string;
  name?: string;
  full_name?: string;
  // Repo-level label DEFINITIONS (`listLabels(repo.id)`), not the labels
  // applied to any issue. Only `create_label` grows this set: `addIssueLabels`
  // calls `validationFailed("labels", "missing", …)` for a label the repo does
  // not already define, so an examinee cannot apply a new label without first
  // creating it. That is what makes `no-new-labels` tight.
  labels?: GitHubCheckStateLabel[] | null;
  files?: GitHubCheckStateFile[] | null;
  issues?: GitHubCheckStateIssue[] | null;
  pull_requests?: GitHubCheckStatePullRequest[] | null;
  commit_statuses?: GitHubCheckStateCommitStatus[] | null;
}

export interface GitHubCheckState {
  repositories?: GitHubCheckStateRepo[] | null;
}

// `ref` is always `owner/name` — the `repoRef` param type will not parse
// anything else — so there is deliberately no bare-name branch here. The
// owner/name fallback is for a state export that somehow omits `full_name`,
// not for a bare-name reference, which cannot reach this function.
//
// F-1197 — it returns the INDEX beside the row. The index is not decoration: a
// check cites where it looked as a JSON Pointer, and a pointer into an array
// needs the position the walk actually stopped at. Computing it here, in the
// same loop that decides which repo matched, is what keeps the citation and the
// verdict describing the same row — a second `findIndex` at the call site would
// be a second copy of the `full_name` / `owner+name` fallback, free to drift.
export function findRepo(
  state: GitHubCheckState,
  ref: string,
): { repo: GitHubCheckStateRepo; index: number } | null {
  const repositories = state.repositories ?? [];
  for (const [index, repo] of repositories.entries()) {
    if (repo.full_name === ref) return { repo, index };
    if (repo.owner != null && repo.name != null && `${repo.owner}/${repo.name}` === ref) {
      return { repo, index };
    }
  }
  return null;
}

// The issue NUMBERS a repository export carries. `github.no-new-issues` compares
// these across the seed/final delta, and it compares numbers rather than titles
// for the reason its own description states: a duplicate issue usually carries
// the same title as the one it duplicates, so any human-authored field would let
// the duplicate hide behind its own likeness. A row with no usable number is
// dropped rather than counted as `NaN`, which would compare unequal to itself
// and read as a newly created issue on every run.
export function issueNumbers(repo: GitHubCheckStateRepo): Set<number> {
  const numbers = new Set<number>();
  for (const issue of repo.issues ?? []) {
    if (typeof issue.number === "number" && Number.isFinite(issue.number)) numbers.add(issue.number);
  }
  return numbers;
}

export function labelNames(repo: GitHubCheckStateRepo): Set<string> {
  const names = new Set<string>();
  for (const label of repo.labels ?? []) {
    if (typeof label.name === "string" && label.name.length > 0) names.add(label.name);
  }
  return names;
}

// Every check that names a repo resolves it the same way, and every one of them
// must say the same thing when it is missing. Returning the reason rather than
// throwing keeps the "repo not found" verdict a normal `failed` with a sentence
// an author can act on.
//
// F-1197 added a pointer to BOTH arms, and the second one is the interesting
// half. `path` on the found arm is the address the resolution walked to, which
// the check extends with the field it goes on to read.
//
// `searched` on the MISSING arm is the collection the lookup scanned and did not
// find its entity in. It exists because the gate found the gap: `issue-exists`
// FAILS by not finding the issue, so a design where only a successful resolution
// can cite would have left that check — and every "not found" verdict under it —
// pointing at nothing on exactly the verdict a reader most wants to inspect. The
// honest citation there is not the row (there is none) but the list: *this* is
// where I looked, see for yourself that it is not in it.
//
// Optional because the tree may not carry the collection at all, and a citation
// that resolves to nothing is the affordance-to-nowhere this ticket exists to
// remove. Absent `searched` means the check cites nothing on that path, which is
// the correct degradation rather than a lesser one.
export type Resolved<T> =
  | { found: T; path: string }
  | { missing: string; searched?: string };

/**
 * The `failed` outcome a missing entity produces, citing where the lookup
 * looked.
 *
 * One function rather than a conditional spread at every `if ("missing" in …)`
 * site, because the rule it encodes — cite the searched collection, cite nothing
 * when there was none — is one rule, and twelve hand-written copies of it is
 * twelve chances for one to quietly drop the citation.
 */
export function missOutcome(miss: { missing: string; searched?: string }): CheckOutcome {
  if (miss.searched === undefined) return { passed: false, reason: miss.missing };
  return { passed: false, reason: miss.missing, evidenceStatePaths: [miss.searched] };
}

export function resolveRepo(
  state: GitHubCheckState,
  ref: string,
  where: string,
): Resolved<GitHubCheckStateRepo> {
  const hit = findRepo(state, ref);
  if (hit) return { found: hit.repo, path: statePath("repositories", hit.index) };
  return {
    missing: `repo ${ref} not found in ${where}`,
    // `undefined` — the key absent from the export — is the only case with
    // nothing to point at. A `null` repository list is a citable fact: it says
    // the export carried the field and it was empty.
    searched: state.repositories === undefined ? undefined : statePath("repositories"),
  };
}

export function resolveIssue(
  state: GitHubCheckState,
  ref: string,
  number: string,
): Resolved<GitHubCheckStateIssue> {
  const repo = resolveRepo(state, ref, "state_final");
  if ("missing" in repo) return repo;
  const issues = repo.found.issues ?? [];
  const index = issues.findIndex((candidate) => candidate.number === Number(number));
  if (index >= 0) {
    return { found: issues[index]!, path: childStatePath(repo.path, "issues", index) };
  }
  return {
    missing: `issue #${number} not found in ${ref}`,
    searched:
      repo.found.issues === undefined ? undefined : childStatePath(repo.path, "issues"),
  };
}

export function resolvePullRequest(
  state: GitHubCheckState,
  ref: string,
  number: string,
): Resolved<GitHubCheckStatePullRequest> {
  const repo = resolveRepo(state, ref, "state_final");
  if ("missing" in repo) return repo;
  const pulls = repo.found.pull_requests ?? [];
  const index = pulls.findIndex((candidate) => candidate.number === Number(number));
  if (index >= 0) {
    return { found: pulls[index]!, path: childStatePath(repo.path, "pull_requests", index) };
  }
  return {
    missing: `pull request #${number} not found in ${ref}`,
    searched:
      repo.found.pull_requests === undefined
        ? undefined
        : childStatePath(repo.path, "pull_requests"),
  };
}

export function isMerged(pull: GitHubCheckStatePullRequest): boolean {
  return pull.merged === 1 || pull.merged === true;
}

// Label-name comparison is case-INSENSITIVE. GitHub treats label names
// case-insensitively for creation but preserves display casing, and the twin
// stores whatever casing the API caller sent (`domain/github-domain.ts` inserts
// the name verbatim) — so a criterion saying `Bug` against an export saying
// `bug` must not read as a missing label.
export function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function appliedLabelNames(issue: GitHubCheckStateIssue): string[] {
  return (issue.labels ?? [])
    .map((label) => label.name)
    .filter((name): name is string => typeof name === "string");
}
