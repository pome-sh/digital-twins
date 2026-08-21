// SPDX-License-Identifier: Apache-2.0
import type {
  BranchRow,
  CheckRunRow,
  CommitRow,
  CommitStatusRow,
  CollaboratorRow,
  FileRow,
  IssueCommentRow,
  IssueRow,
  LabelRow,
  MilestoneRow,
  PullRequestFileRow,
  PullRequestReviewCommentRow,
  PullRequestReviewRow,
  PullRequestRow,
  ReleaseRow,
  RepoRow,
  TagRow,
} from "../types.js";
import { conflict, notFound, validationFailed } from "../errors.js";
import { fileSha, linesChanged, makeSha, nowIso, paginate, stableNumericId, treeSha } from "../util.js";
import {
  authenticatedUserJson,
  branchJson,
  branchState,
  checkRunJson,
  checkRunState,
  collaboratorAddState,
  combinedStatusJson,
  commitJson,
  commitWithFilesJson,
  compareCommitsJson,
  contentDirectoryEntryJson,
  contentFileJson,
  fileState,
  issueAssigneesState,
  issueCommentJson,
  issueCommentState,
  issueJson,
  issueLabelsState,
  issueState,
  labelJson,
  labelState,
  milestoneJson,
  milestoneState,
  pullRequestDiffText,
  pullRequestFileJson,
  pullRequestJson,
  pullRequestListJson,
  pullRequestReviewCommentJson,
  pullRequestReviewCommentState,
  pullRequestReviewState,
  pullRequestState,
  releaseJson,
  releaseState,
  repoJson,
  repoState,
  reviewJson,
  statusJson,
  tagJson,
  userJson,
} from "../serializers.js";
import type { GitHubDomain } from "./github-domain.js";
import type { FileChange, MutatingOptions, PageOptions, StateDeltaCallback } from "./types.js";


/**
 * F-1389 — GitHub's search API takes ONE scoping input, `q`, and encodes every
 * filter as a qualifier inside it. Its OpenAPI declares `q, sort, order,
 * per_page, page` and nothing else.
 *
 * This twin used to take `?owner=`, `?repo=` and `?state=` alongside `q` and
 * scope by them, which is two failures rather than one. The named one is that
 * an agent taught to scope a search that way passes the exam and fails in
 * production. The MIRROR is worse and is what makes this a parser rather than a
 * deletion: the free-text match ran against the WHOLE `q` string, so an agent
 * writing the request GitHub actually documents — `q=idempotency repo:acme/api`
 * — got zero results, because no issue's title or body contains that literal
 * string. The surface did not merely let a wrong habit pass; it punished the
 * correct one, and dropping the three parameters alone would have left that
 * standing.
 *
 * Five qualifiers are lifted out. Everything else GitHub has — `in:`,
 * `language:`, `path:`, the boolean operators — stays in the free-text
 * term (FIDELITY.md divergence 1).
 */
const QUALIFIER = /(^|\s)(repo|user|org|state|is):(\S+)/gi;

interface ParsedSearchQuery {
  /** What is left of `q` once the qualifiers are lifted out, lowercased. */
  readonly text: string;
  /**
   * The same remainder TOKENISED. `/search/issues` matches on this and every
   * term has to be present; the code and commit searches still match `text` as
   * one substring, which is divergence 1's remaining half.
   */
  readonly terms: readonly string[];
  /** `user:` / `org:` values — repository owner logins, lowercased. */
  readonly owners: readonly string[];
  /** `repo:` values — repository FULL names (`owner/name`), lowercased. */
  readonly fullNames: readonly string[];
  /** `state:` or `is:open|closed`, on the surfaces that have one. */
  readonly state?: "open" | "closed";
  /** `is:issue` / `is:pr`, on the surfaces that have them. */
  readonly type?: "issue" | "pr";
  /**
   * An `is:` value the surface cannot honour. GitHub reads the qualifier and
   * answers NOTHING rather than searching for the text — measured 2026-08-21,
   * `repo:cli/cli … is:bogusvalue` → `total_count: 0` where the same query
   * without it answers 37. Modelled as a flag rather than as unmatched text so
   * the answer does not depend on whether the literal happens to be indexed.
   */
  readonly unhonourable: boolean;
}

/**
 * GitHub's issue index is TOKENISED, and a term matches a WHOLE token rather
 * than a substring. Measured 2026-08-21 against `cli/cli`:
 *
 *   `authentication`  → 607      `authenticati` (a prefix of it) → 0
 *   `codespaces` 345 ∧ `authentication` 607 → `codespaces authentication` 37
 *
 * So terms AND, and a partial word matches nothing. Both halves matter here and
 * they pull in opposite directions: matching the whole query as one substring
 * (the F-791 defect) answers EMPTY for a query whose terms are all present,
 * while splitting the query and testing each term with `includes` — the fix the
 * ticket prescribed — would answer 607 for `authenticati` and score a call
 * GitHub refuses to serve. A false hit is the worse of the two for a grading
 * instrument, so the match is token equality.
 *
 * `_` stays inside a token and `-` breaks one, which is GitHub's own split:
 * `per_page` → 110 and `per page` → 226 are different queries there, while
 * `pull-request` → 3222 and `pull request` → 3298 are the same one.
 */
function tokenise(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
}

/** Whether every term in `q` appears as a token of `document`. */
function matchesTerms(terms: readonly string[], ...document: string[]): boolean {
  if (terms.length === 0) return true;
  const tokens = new Set(tokenise(document.join(" ")));
  return terms.every((term) => tokens.has(term));
}

/**
 * `q` split into the scope it names and the text it searches for.
 *
 * An unrecognised qualifier is left in the term rather than dropped, and so is
 * a recognised one carrying a value the surface cannot honour (`repo:api` with
 * no owner, `state:merged`). Both choices point the same way: a qualifier this
 * twin discarded would answer a BROADER set than GitHub for a request GitHub
 * narrows, and breadth is the direction that scores a call the real API would
 * not have served. Narrowing is the safe failure.
 *
 * `state` is a qualifier only where the surface has one — `/search/issues`.
 * Lifting `state:` out of a code search would filter by nothing and widen the
 * answer for the same reason.
 */
function parseSearchQuery(raw: string, options: { state?: boolean; is?: boolean } = {}): ParsedSearchQuery {
  const owners: string[] = [];
  const fullNames: string[] = [];
  let state: "open" | "closed" | undefined;
  let type: "issue" | "pr" | undefined;
  let unhonourable = false;
  const text = raw.replace(QUALIFIER, (whole, lead: string, key: string, rawValue: string) => {
    const value = rawValue.toLowerCase();
    switch (key.toLowerCase()) {
      case "repo":
        // GitHub's `repo:` names a repository in full. A bare name is not a
        // scope it would honour, so it is not one here either.
        if (!value.includes("/")) return whole;
        fullNames.push(value);
        return lead;
      case "user":
      case "org":
        // Both resolve to the repository's owner login, with no account-type
        // check — GitHub documents `org:` for organizations and `user:` for
        // accounts, and this twin does not tell them apart. Refusing
        // `user:<an org>` would answer `[]` to a request real GitHub serves,
        // which is this ticket's own failure pointed the other way.
        owners.push(value);
        return lead;
      case "state":
        if (!options.state || (value !== "open" && value !== "closed")) return whole;
        state = value;
        return lead;
      case "is":
        // GitHub's commonest issue qualifier, and the one whose absence hurt
        // most: `is:open` left in the free text zeroed EVERY query carrying it
        // (F-791). Measured 2026-08-21 on `cli/cli`: `is:open` and `state:open`
        // returned the same 5, and `is:issue` 21 + `is:pr` 16 partitioned the
        // unscoped 37 exactly.
        //
        // Gated on `options.is` for the same reason `state:` is: `is:archived`
        // and `is:fork` are code-search qualifiers this twin does not model, and
        // lifting them out there would widen the answer past GitHub's.
        if (!options.is) return whole;
        switch (value) {
          case "open":
          case "closed":
            state = value;
            return lead;
          case "issue":
          case "pr":
            type = value;
            return lead;
          default:
            // Not free text. GitHub reads the qualifier, cannot honour the
            // value, and answers nothing — measured, `is:bogusvalue` → 0.
            unhonourable = true;
            return lead;
        }
      default:
        return whole;
    }
  });
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return { text: normalized, terms: tokenise(normalized), owners, fullNames, state, type, unhonourable };
}

/**
 * Whether a repository is in `q`'s scope. Several scope qualifiers OR together,
 * the way GitHub's do — `repo:a/b user:c` is everything in `a/b` plus
 * everything `c` owns, not the empty intersection.
 */
function inScope(parsed: ParsedSearchQuery, owner: string, fullName: string): boolean {
  if (parsed.owners.length === 0 && parsed.fullNames.length === 0) return true;
  return (
    parsed.fullNames.includes(fullName.toLowerCase()) || parsed.owners.includes(owner.toLowerCase())
  );
}


export function searchRepositories(domain: GitHubDomain, input: { query?: string; q?: string } & PageOptions) {
  const query = (input.query ?? input.q ?? "").toLowerCase();
  const repos = (domain.db.prepare("SELECT * FROM repositories ORDER BY full_name ASC").all() as RepoRow[]).filter(
    (repo) => !query || repo.full_name.toLowerCase().includes(query) || repo.description.toLowerCase().includes(query)
  );
  const items = paginate(repos, input.page, input.per_page ?? input.perPage).map(repoJson);
  return { total_count: repos.length, incomplete_results: false, items };
}


export function searchUsers(domain: GitHubDomain, input: { query?: string; q?: string } & PageOptions) {
  const query = (input.query ?? input.q ?? "").toLowerCase();
  const rows = domain.db.prepare("SELECT login, type FROM users ORDER BY login ASC").all() as Array<{ login: string; type: "User" | "Organization" }>;
  const users = rows.filter((user) => !query || user.login.toLowerCase().includes(query));
  return { total_count: users.length, incomplete_results: false, items: paginate(users, input.page, input.per_page ?? input.perPage).map((user) => userJson(user.login, user.type)) };
}


/**
 * `owner` / `repo` survive on the DOMAIN signature after F-1389 took them off
 * the REST declaration, because the MCP door still declares them on
 * `search_code` and `search_commits`. That door is a separate published surface
 * with its own frozen tool fixture, and it is out of this ticket's scope on the
 * same line the `encoding` amendment drew — the qualifier parser below reaches
 * both doors, so the behaviour half is fixed for MCP callers regardless.
 */
export function searchCode(domain: GitHubDomain, input: { query?: string; q?: string; owner?: string; repo?: string } & PageOptions) {
  const parsed = parseSearchQuery(input.query ?? input.q ?? "");
  let rows = domain.db
    .prepare(
      "SELECT files.*, repositories.owner, repositories.name, repositories.full_name, repositories.description, repositories.private, repositories.default_branch, repositories.fork, repositories.parent_full_name, repositories.entity_counter, repositories.created_at, repositories.updated_at FROM files INNER JOIN repositories ON files.repo_id = repositories.id WHERE files.branch = repositories.default_branch ORDER BY repositories.full_name, files.path"
    )
    .all() as Array<FileRow & RepoRow>;
  if (input.owner) rows = rows.filter((row) => row.owner === input.owner);
  if (input.repo) rows = rows.filter((row) => row.name === input.repo);
  rows = rows.filter((row) => inScope(parsed, row.owner, row.full_name));
  rows = rows.filter((row) => !parsed.text || row.path.toLowerCase().includes(parsed.text) || row.content.toLowerCase().includes(parsed.text));
  return {
    total_count: rows.length,
    incomplete_results: false,
    items: paginate(rows, input.page, input.per_page ?? input.perPage).map((row) => ({
      name: row.path.split("/").at(-1),
      path: row.path,
      sha: row.sha,
      url: `https://api.github.com/repos/${row.full_name}/contents/${row.path}`,
      git_url: `https://api.github.com/repos/${row.full_name}/git/blobs/${row.sha}`,
      html_url: `https://github.com/${row.full_name}/blob/${row.branch}/${row.path}`,
      repository: repoJson(row)
    }))
  };
}


export function searchCommits(domain: GitHubDomain, input: { query?: string; q?: string; owner?: string; repo?: string } & PageOptions) {
  const parsed = parseSearchQuery(input.query ?? input.q ?? "");
  let repos = domain.db.prepare("SELECT * FROM repositories ORDER BY full_name ASC").all() as RepoRow[];
  if (input.owner) repos = repos.filter((repo) => repo.owner === input.owner);
  if (input.repo) repos = repos.filter((repo) => repo.name === input.repo);
  repos = repos.filter((repo) => inScope(parsed, repo.owner, repo.full_name));
  const matches: Array<{ commit: CommitRow; repo: RepoRow }> = [];
  for (const repo of repos) {
    const branch = domain.db.prepare("SELECT * FROM branches WHERE repo_id = ? AND name = ?").get(repo.id, repo.default_branch) as BranchRow | undefined;
    if (!branch?.head_sha) continue;
    for (const commit of domain.commitAncestry(repo.id, branch.head_sha)) {
      if (!parsed.text || commit.message.toLowerCase().includes(parsed.text) || commit.author_login.toLowerCase().includes(parsed.text)) matches.push({ commit, repo });
    }
  }
  return {
    total_count: matches.length,
    incomplete_results: false,
    items: paginate(matches, input.page, input.per_page ?? input.perPage).map(({ commit, repo }) => ({ ...commitJson(commit, repo), repository: repoJson(repo), score: 1 }))
  };
}


export function searchIssues(domain: GitHubDomain, input: { query?: string; q?: string; owner?: string; repo?: string; state?: "open" | "closed" | "all" } & PageOptions) {
  const parsed = parseSearchQuery(input.query ?? input.q ?? "", { state: true, is: true });
  const rows = domain.db
    .prepare(
      "SELECT issues.*, repositories.owner, repositories.name, repositories.full_name, repositories.description, repositories.private, repositories.default_branch, repositories.fork, repositories.parent_full_name, repositories.entity_counter, repositories.created_at AS repo_created_at, repositories.updated_at AS repo_updated_at FROM issues INNER JOIN repositories ON issues.repo_id = repositories.id ORDER BY issues.updated_at DESC"
    )
    .all() as Array<IssueRow & { owner: string; name: string; full_name: string; description: string; private: 0 | 1; default_branch: string; fork: 0 | 1; parent_full_name: string | null; entity_counter: number; repo_created_at: string; repo_updated_at: string }>;
  // The free text matches TOKENS of one document — title and body together, the
  // way GitHub indexes an issue, which is why `in:title` / `in:body` exist there
  // to narrow it. The repository's full name is deliberately NOT in that
  // document: `repo:` is the qualifier that addresses it (and this twin parses
  // it), and folding the name into an all-terms match would answer a query like
  // `acme coupon` that GitHub answers with nothing — divergence 1's stated
  // unsafe direction.
  let filtered = rows.filter((issue) => matchesTerms(parsed.terms, issue.title, issue.body));
  filtered = filtered.filter((issue) => inScope(parsed, issue.owner, issue.full_name));
  if (input.owner) filtered = filtered.filter((issue) => issue.owner === input.owner);
  if (input.repo) filtered = filtered.filter((issue) => issue.name === input.repo);
  // NO `state=open` default here, deliberately (F-1427). The three repo LIST
  // surfaces gained one because real GitHub defaults them; GitHub's SEARCH API
  // does not — a search returns what the query asks for, and `state:open` is a
  // query qualifier, not a default. Adding one to match the lists would be a new
  // divergence in the other direction, and a worse one: this search matches
  // tokens over the seeded world rather than ranking it, so any query whose only
  // match is closed would answer `[]` — an empty-array divergence in place of a
  // value one. (That clause read "substring matching" until F-791 tokenised the
  // term; the argument it makes is unchanged by which of the two it is.)
  //
  // `state:` in `q` is GitHub's own spelling and wins over `input.state`, which
  // only an MCP caller can still set (F-1389 took `?state=` off the REST
  // declaration). A request naming both has already contradicted itself; the
  // qualifier is the half GitHub would have read.
  const state = parsed.state ?? (input.state === "all" ? undefined : input.state);
  if (state) filtered = filtered.filter((issue) => issue.state === state);
  // `is:pr` asks for pull requests and this surface reads the `issues` table,
  // which holds none — real GitHub models a PR as an issue and this twin keeps
  // them apart. Answering EMPTY is the honest reply; answering with issues is
  // the false PASS the MCP-lane registry files as GITHUB-MCP-010 (a search for
  // PRs scored as if it had returned them). The missing `search_pull_requests`
  // TOOL is the other half of that entry and is not closed here.
  //
  // `unhonourable` is the same shape for a different reason: GitHub reads an
  // `is:` value it cannot serve and returns nothing.
  if (parsed.type === "pr" || parsed.unhonourable) filtered = [];
  return {
    total_count: filtered.length,
    incomplete_results: false,
    items: paginate(filtered, input.page, input.per_page ?? input.perPage).map((issue) => {
      const repo = domain.requireRepoById(issue.repo_id);
      return issueJson(issue, repo, domain.listIssueLabels(issue.repo_id, issue.number), domain.listIssueAssignees(issue.repo_id, issue.number), domain.issueCommentCount(issue.repo_id, issue.number));
    })
  };
}

