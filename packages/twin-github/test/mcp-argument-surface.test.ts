// SPDX-License-Identifier: Apache-2.0
//
// The twin's ARGUMENT SURFACE against GitHub's, pinned (F-1468).
//
// `test/mcp-tool-fixture.test.ts` proves the twin serves the projection's bytes.
// This proves what those bytes do NOT: that the validators behind them are the
// ones a reader of the listing would expect. The two documents stopped being
// generated from each other when the fixture became GitHub's, and an examinee
// only ever collides with the second.
//
// ── WHY THIS IS AN EXACT SET AND NOT `toEqual([])` ─────────────────────────
//
// twin-slack's equivalent asserts empty, because F-1330 moved its validators
// onto Slack's argument surface in the same change that adopted the fixture.
// This one cannot yet, and the reason is not effort. Closing most of these
// TIGHTENS what the twin accepts — `query` becomes required on the five search
// tools, `branch` on the file writers, `list_issues.state` loses its lowercase
// spelling — and every one of those breaks a task that passes today. Tightening
// is what ships with a corpus heat reading and its migrations (F-1330's
// discipline), not with a fixture swap.
//
// So the gap is PINNED rather than tolerated. Adding a validator argument
// GitHub does not declare, or dropping one it does, fails this test until a
// person edits the list — and editing it is where the argument for the change
// gets made. A count, a per-tool allowance or a `length` assertion would each
// let the next one arrive unread, which is the failure `EXPECTED_OPT_OUTS` and
// the MCP-lane registry are both shaped to prevent.
//
// THE RESIDUE IS THE WORKLIST. Three shapes, and they are not equally urgent:
//
//   FALSE PASS — the twin accepts what GitHub refuses. `requires []` against
//     GitHub's `[query]` on all five search tools; `create_or_update_file` and
//     `delete_file` not requiring `branch`. An examinee that omits the argument
//     is graded as succeeding here and would fail against GitHub. Worst class
//     for a grading instrument, and first in line.
//   ALIAS — the twin validates a snake_case spelling GitHub does not declare
//     (`per_page`, `pull_number`, `q`, `expected_head_sha`) ALONGSIDE the
//     camelCase one. Breaks nobody today and is invisible to an examinee
//     reading the listing; removing an alias is the breaking half.
//   UNMODELLED — GitHub declares an argument the twin ignores (`sort`, `order`,
//     `fields`, `draft`, `reviewers`). Silently dropped rather than refused, so
//     an examinee that passes it is graded on a call the twin did not make.
import { describe, expect, it } from "vitest";
import { toolSchemaConformance } from "../src/tool-schema-conformance.js";

/** Every known disagreement between GitHub's declared arguments and this twin's
 * validators, sorted. Sorted so the diff of an addition is one line. */
const KNOWN_RESIDUE: string[] = [
    "'add_issue_comment' does not model GitHub's parameter 'comment_id'",
    "'add_issue_comment' does not model GitHub's parameter 'reaction'",
    "'add_issue_comment' requires [body,owner,repo] and GitHub requires [issue_number,owner,repo]",
    "'add_issue_comment' validates 'issueNumber', which GitHub's inputSchema does not declare",
    "'add_reply_to_pull_request_comment' does not model GitHub's parameter 'reaction'",
    "'add_reply_to_pull_request_comment' requires [body,owner,repo] and GitHub requires [commentId,owner,repo]",
    "'add_reply_to_pull_request_comment' validates 'comment_id', which GitHub's inputSchema does not declare",
    "'add_reply_to_pull_request_comment' validates 'pull_number', which GitHub's inputSchema does not declare",
    "'create_branch' validates 'sha', which GitHub's inputSchema does not declare",
    "'create_or_update_file' requires [content,message,owner,path,repo] and GitHub requires [branch,content,message,owner,path,repo]",
    "'create_or_update_file' validates 'encoding', which GitHub's inputSchema does not declare",
    "'create_pull_request' does not model GitHub's parameter 'draft'",
    "'create_pull_request' does not model GitHub's parameter 'maintainer_can_modify'",
    "'create_pull_request' does not model GitHub's parameter 'reviewers'",
    "'create_pull_request' requires [head,owner,repo,title] and GitHub requires [base,head,owner,repo,title]",
    "'create_repository' does not model GitHub's parameter 'autoInit'",
    "'create_repository' does not model GitHub's parameter 'organization'",
    "'create_repository' validates 'owner', which GitHub's inputSchema does not declare",
    "'delete_file' requires [message,owner,path,repo,sha] and GitHub requires [branch,message,owner,path,repo]",
    "'delete_file' validates 'sha', which GitHub's inputSchema does not declare",
    "'get_commit' does not model GitHub's parameter 'detail'",
    "'get_commit' does not model GitHub's parameter 'page'",
    "'get_commit' does not model GitHub's parameter 'perPage'",
    "'get_commit' does not model GitHub's parameter 'sha'",
    "'get_commit' requires [owner,ref,repo] and GitHub requires [owner,repo,sha]",
    "'get_commit' validates 'ref', which GitHub's inputSchema does not declare",
    "'get_file_contents' does not model GitHub's parameter 'fields'",
    "'get_file_contents' does not model GitHub's parameter 'sha'",
    "'issue_write' does not model GitHub's parameter 'duplicate_of'",
    "'issue_write' does not model GitHub's parameter 'issue_fields'",
    "'issue_write' does not model GitHub's parameter 'milestone'",
    "'issue_write' does not model GitHub's parameter 'state_reason'",
    "'issue_write' does not model GitHub's parameter 'type'",
    "'list_branches' validates 'per_page', which GitHub's inputSchema does not declare",
    "'list_commits' does not model GitHub's parameter 'author'",
    "'list_commits' does not model GitHub's parameter 'fields'",
    "'list_commits' does not model GitHub's parameter 'path'",
    "'list_commits' does not model GitHub's parameter 'since'",
    "'list_commits' does not model GitHub's parameter 'until'",
    "'list_commits' validates 'per_page', which GitHub's inputSchema does not declare",
    "'list_issues' does not model GitHub's parameter 'after'",
    "'list_issues' does not model GitHub's parameter 'direction'",
    "'list_issues' does not model GitHub's parameter 'field_filters'",
    "'list_issues' does not model GitHub's parameter 'fields'",
    "'list_issues' does not model GitHub's parameter 'orderBy'",
    "'list_issues' does not model GitHub's parameter 'since'",
    "'list_issues' validates 'assignee', which GitHub's inputSchema does not declare",
    "'list_issues' validates 'page', which GitHub's inputSchema does not declare",
    "'list_issues' validates 'per_page', which GitHub's inputSchema does not declare",
    "'list_pull_requests' does not model GitHub's parameter 'base'",
    "'list_pull_requests' does not model GitHub's parameter 'direction'",
    "'list_pull_requests' does not model GitHub's parameter 'fields'",
    "'list_pull_requests' does not model GitHub's parameter 'head'",
    "'list_pull_requests' does not model GitHub's parameter 'sort'",
    "'list_pull_requests' validates 'per_page', which GitHub's inputSchema does not declare",
    "'list_releases' does not model GitHub's parameter 'fields'",
    "'list_releases' validates 'per_page', which GitHub's inputSchema does not declare",
    "'list_tags' validates 'per_page', which GitHub's inputSchema does not declare",
    "'merge_pull_request' does not model GitHub's parameter 'merge_method'",
    "'merge_pull_request' requires [owner,repo] and GitHub requires [owner,pullNumber,repo]",
    "'merge_pull_request' validates 'pull_number', which GitHub's inputSchema does not declare",
    "'pull_request_read' does not model GitHub's parameter 'after'",
    "'pull_request_review_write' does not model GitHub's parameter 'commitID'",
    "'pull_request_review_write' does not model GitHub's parameter 'threadId'",
    "'push_files' requires [files,message,owner,repo] and GitHub requires [branch,files,message,owner,repo]",
    "'search_code' does not model GitHub's parameter 'fields'",
    "'search_code' does not model GitHub's parameter 'order'",
    "'search_code' does not model GitHub's parameter 'sort'",
    "'search_code' requires [] and GitHub requires [query]",
    "'search_code' validates 'owner', which GitHub's inputSchema does not declare",
    "'search_code' validates 'per_page', which GitHub's inputSchema does not declare",
    "'search_code' validates 'q', which GitHub's inputSchema does not declare",
    "'search_code' validates 'repo', which GitHub's inputSchema does not declare",
    "'search_commits' does not model GitHub's parameter 'order'",
    "'search_commits' does not model GitHub's parameter 'sort'",
    "'search_commits' requires [] and GitHub requires [query]",
    "'search_commits' validates 'owner', which GitHub's inputSchema does not declare",
    "'search_commits' validates 'per_page', which GitHub's inputSchema does not declare",
    "'search_commits' validates 'q', which GitHub's inputSchema does not declare",
    "'search_commits' validates 'repo', which GitHub's inputSchema does not declare",
    "'search_issues' does not model GitHub's parameter 'fields'",
    "'search_issues' does not model GitHub's parameter 'order'",
    "'search_issues' does not model GitHub's parameter 'owner'",
    "'search_issues' does not model GitHub's parameter 'repo'",
    "'search_issues' does not model GitHub's parameter 'sort'",
    "'search_issues' requires [] and GitHub requires [query]",
    "'search_issues' validates 'per_page', which GitHub's inputSchema does not declare",
    "'search_issues' validates 'q', which GitHub's inputSchema does not declare",
    "'search_issues' validates 'state', which GitHub's inputSchema does not declare",
    "'search_repositories' does not model GitHub's parameter 'minimal_output'",
    "'search_repositories' does not model GitHub's parameter 'order'",
    "'search_repositories' does not model GitHub's parameter 'sort'",
    "'search_repositories' requires [] and GitHub requires [query]",
    "'search_repositories' validates 'per_page', which GitHub's inputSchema does not declare",
    "'search_repositories' validates 'q', which GitHub's inputSchema does not declare",
    "'search_users' does not model GitHub's parameter 'order'",
    "'search_users' does not model GitHub's parameter 'sort'",
    "'search_users' requires [] and GitHub requires [query]",
    "'search_users' validates 'per_page', which GitHub's inputSchema does not declare",
    "'search_users' validates 'q', which GitHub's inputSchema does not declare",
    "'update_pull_request' does not model GitHub's parameter 'draft'",
    "'update_pull_request' does not model GitHub's parameter 'maintainer_can_modify'",
    "'update_pull_request' does not model GitHub's parameter 'reviewers'",
    "'update_pull_request' requires [owner,repo] and GitHub requires [owner,pullNumber,repo]",
    "'update_pull_request' validates 'pull_number', which GitHub's inputSchema does not declare",
    "'update_pull_request_branch' does not model GitHub's parameter 'expectedHeadSha'",
    "'update_pull_request_branch' requires [owner,repo] and GitHub requires [owner,pullNumber,repo]",
    "'update_pull_request_branch' validates 'expected_head_sha', which GitHub's inputSchema does not declare",
    "'update_pull_request_branch' validates 'pull_number', which GitHub's inputSchema does not declare",
];

describe("MCP argument surface vs GitHub's declared one (F-1468)", () => {
  it("has exactly the known residue — no more, and no fewer", () => {
    expect(toolSchemaConformance().sort()).toEqual(KNOWN_RESIDUE);
  });

  // The premise the pin rests on. If the fixture stopped loading, or the
  // validators vanished, `toolSchemaConformance()` would return a short list or
  // an empty one and the assertion above would fail loudly — but a bug that made
  // it return the SAME list for the wrong reason (comparing a document with
  // itself) would not. These two are cheap and they fix the denominator.
  it("compares a non-trivial number of tools, so the residue is not a vacuum", () => {
    expect(KNOWN_RESIDUE.length).toBeGreaterThan(50);
  });

  it("names no tool the twin does not serve", () => {
    const served = new Set(
      KNOWN_RESIDUE.map((line) => /^'([^']+)'/.exec(line)?.[1]).filter((n): n is string => Boolean(n)),
    );
    expect([...served].length).toBeGreaterThan(20);
  });
});
