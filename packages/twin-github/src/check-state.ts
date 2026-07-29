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
export function findRepo(state: GitHubCheckState, ref: string): GitHubCheckStateRepo | null {
  for (const repo of state.repositories ?? []) {
    if (repo.full_name === ref) return repo;
    if (repo.owner != null && repo.name != null && `${repo.owner}/${repo.name}` === ref) return repo;
  }
  return null;
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
export type Resolved<T> = { found: T } | { missing: string };

export function resolveRepo(
  state: GitHubCheckState,
  ref: string,
  where: string,
): Resolved<GitHubCheckStateRepo> {
  const repo = findRepo(state, ref);
  return repo ? { found: repo } : { missing: `repo ${ref} not found in ${where}` };
}

export function resolveIssue(
  state: GitHubCheckState,
  ref: string,
  number: string,
): Resolved<GitHubCheckStateIssue> {
  const repo = resolveRepo(state, ref, "state_final");
  if ("missing" in repo) return repo;
  const issue = (repo.found.issues ?? []).find((candidate) => candidate.number === Number(number));
  return issue ? { found: issue } : { missing: `issue #${number} not found in ${ref}` };
}

export function resolvePullRequest(
  state: GitHubCheckState,
  ref: string,
  number: string,
): Resolved<GitHubCheckStatePullRequest> {
  const repo = resolveRepo(state, ref, "state_final");
  if ("missing" in repo) return repo;
  const pull = (repo.found.pull_requests ?? []).find(
    (candidate) => candidate.number === Number(number),
  );
  return pull ? { found: pull } : { missing: `pull request #${number} not found in ${ref}` };
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
