// SPDX-License-Identifier: Apache-2.0
// The twin's ARGUMENT SURFACE against GitHub's, pinned as an EXACT set so a new gap
// cannot arrive unread.
import { describe, expect, it } from "vitest";
import { typeDisagreements } from "@pome-sh/sdk/mcp-tool-fixture";
import { toolSchemaConformance } from "../src/tool-schema-conformance.js";
import { githubToolFixture, toolArgumentSchemas } from "../src/tools.js";

/** Every known disagreement between GitHub's declared arguments and this twin's
 * validators, sorted. Sorted so the diff of an addition is one line. */
const KNOWN_RESIDUE: string[] = [
    "'add_issue_comment' does not model GitHub's parameter 'comment_id'",
    "'add_issue_comment' does not model GitHub's parameter 'reaction'",
    "'add_issue_comment' requires 'body', which GitHub does not",
    "'add_issue_comment' validates 'issueNumber', which GitHub's inputSchema does not declare",
    "'add_reply_to_pull_request_comment' does not model GitHub's parameter 'reaction'",
    "'add_reply_to_pull_request_comment' requires 'body', which GitHub does not",
    "'add_reply_to_pull_request_comment' validates 'comment_id', which GitHub's inputSchema does not declare",
    "'add_reply_to_pull_request_comment' validates 'pull_number', which GitHub's inputSchema does not declare",
    "'create_branch' validates 'sha', which GitHub's inputSchema does not declare",
    "'create_pull_request' accepts a call with no 'base', and GitHub requires it",
    "'create_pull_request' does not model GitHub's parameter 'draft'",
    "'create_pull_request' does not model GitHub's parameter 'maintainer_can_modify'",
    "'create_pull_request' does not model GitHub's parameter 'reviewers'",
    "'create_repository' does not model GitHub's parameter 'autoInit'",
    "'create_repository' does not model GitHub's parameter 'organization'",
    "'create_repository' validates 'owner', which GitHub's inputSchema does not declare",
    "'delete_file' requires 'sha', which GitHub does not",
    "'delete_file' validates 'sha', which GitHub's inputSchema does not declare",
    "'get_commit' does not model GitHub's parameter 'detail'",
    "'get_commit' does not model GitHub's parameter 'page'",
    "'get_commit' does not model GitHub's parameter 'perPage'",
    "'get_commit' does not model GitHub's parameter 'sha'",
    "'get_commit' requires 'ref', which GitHub does not",
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
    "'merge_pull_request' validates 'pull_number', which GitHub's inputSchema does not declare",
    "'pull_request_read' does not model GitHub's parameter 'after'",
    "'pull_request_review_write' does not model GitHub's parameter 'commitID'",
    "'pull_request_review_write' does not model GitHub's parameter 'threadId'",
    "'search_code' does not model GitHub's parameter 'fields'",
    "'search_code' does not model GitHub's parameter 'order'",
    "'search_code' does not model GitHub's parameter 'sort'",
    "'search_code' validates 'owner', which GitHub's inputSchema does not declare",
    "'search_code' validates 'per_page', which GitHub's inputSchema does not declare",
    "'search_code' validates 'q', which GitHub's inputSchema does not declare",
    "'search_code' validates 'repo', which GitHub's inputSchema does not declare",
    "'search_commits' does not model GitHub's parameter 'order'",
    "'search_commits' does not model GitHub's parameter 'sort'",
    "'search_commits' validates 'owner', which GitHub's inputSchema does not declare",
    "'search_commits' validates 'per_page', which GitHub's inputSchema does not declare",
    "'search_commits' validates 'q', which GitHub's inputSchema does not declare",
    "'search_commits' validates 'repo', which GitHub's inputSchema does not declare",
    "'search_issues' does not model GitHub's parameter 'fields'",
    "'search_issues' does not model GitHub's parameter 'order'",
    "'search_issues' does not model GitHub's parameter 'owner'",
    "'search_issues' does not model GitHub's parameter 'repo'",
    "'search_issues' does not model GitHub's parameter 'sort'",
    "'search_issues' validates 'per_page', which GitHub's inputSchema does not declare",
    "'search_issues' validates 'q', which GitHub's inputSchema does not declare",
    "'search_issues' validates 'state', which GitHub's inputSchema does not declare",
    "'search_repositories' does not model GitHub's parameter 'minimal_output'",
    "'search_repositories' does not model GitHub's parameter 'order'",
    "'search_repositories' does not model GitHub's parameter 'sort'",
    "'search_repositories' validates 'per_page', which GitHub's inputSchema does not declare",
    "'search_repositories' validates 'q', which GitHub's inputSchema does not declare",
    "'search_users' does not model GitHub's parameter 'order'",
    "'search_users' does not model GitHub's parameter 'sort'",
    "'search_users' validates 'per_page', which GitHub's inputSchema does not declare",
    "'search_users' validates 'q', which GitHub's inputSchema does not declare",
    "'update_pull_request' does not model GitHub's parameter 'draft'",
    "'update_pull_request' does not model GitHub's parameter 'maintainer_can_modify'",
    "'update_pull_request' does not model GitHub's parameter 'reviewers'",
    "'update_pull_request' validates 'pull_number', which GitHub's inputSchema does not declare",
    "'update_pull_request_branch' does not model GitHub's parameter 'expectedHeadSha'",
    "'update_pull_request_branch' validates 'expected_head_sha', which GitHub's inputSchema does not declare",
    "'update_pull_request_branch' validates 'pull_number', which GitHub's inputSchema does not declare",
];

describe("MCP argument surface vs GitHub's declared one", () => {
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

  // REQUIRED MEANS PRESENT, NOT TRUTHY: GitHub declares `query` with no
  // `minLength`, so `q: ""` is a call the vendor accepts.
  it("an EMPTY query satisfies the requirement, because GitHub declares no minimum", () => {
    for (const name of ["search_repositories", "search_code", "search_users", "search_issues", "search_commits"]) {
      const schema = toolArgumentSchemas.find((t) => t.name === name)!.schema;
      expect(schema.safeParse({ query: "" }).success, `${name} query:""`).toBe(true);
      expect(schema.safeParse({ q: "" }).success, `${name} q:""`).toBe(true);
      // …and absent is still absent.
      expect(schema.safeParse({}).success, `${name} {}`).toBe(false);
    }
  });

  // ── THE TYPE AXIS ───────────────────────────────────────────────────────── Guard
  // on the guard: the real fixture agrees everywhere, so a test that only.
  describe("a TYPE disagreement on a shared key is reported", () => {
 it("catches the exact shape was, replayed against a planted pair", () => {
      expect(
        typeDisagreements(
          "list_issues",
          "GitHub",
          { labels: { type: "array", items: { type: "string" } } },
          { labels: { type: "string" } },
        ),
      ).toEqual(["'list_issues' validates 'labels' as string, and GitHub declares it as array<string>"]);
    });

    it("says nothing when the two agree, including on the element type", () => {
      const array = { type: "array", items: { type: "string" } };
      expect(typeDisagreements("t", "GitHub", { labels: array }, { labels: array })).toEqual([]);
      // An array of the WRONG element type is still a disagreement — this is the
      // half a bare `type` comparison would miss.
      expect(
        typeDisagreements("t", "GitHub", { labels: array }, { labels: { type: "array", items: { type: "number" } } }),
      ).toEqual(["'t' validates 'labels' as array<number>, and GitHub declares it as array<string>"]);
    });

    it("stays silent on shapes it cannot state, rather than guessing", () => {
      // A key only one side has belongs to the presence checks above, not here.
      expect(typeDisagreements("t", "GitHub", { a: { type: "string" } }, { b: { type: "number" } })).toEqual([]);
      // `anyOf` / `$ref` / a missing `type` are projection artefacts with no
      // vendor counterpart; reporting them would fill the residue with lines
      // nobody can act on.
      expect(typeDisagreements("t", "GitHub", { a: { anyOf: [] } }, { a: { type: "string" } })).toEqual([]);
      expect(typeDisagreements("t", "GitHub", { a: { type: "string" } }, { a: {} })).toEqual([]);
      // `integer` and `number` are the same argument spelled two ways.
      expect(typeDisagreements("t", "GitHub", { a: { type: "number" } }, { a: { type: "integer" } })).toEqual([]);
    });
  });

  // The regression at fixture level: the tool that carried the defect is
  // asserted against GitHub's declaration directly.
  it("validates list_issues.labels as the array GitHub declares", () => {
    const declared = githubToolFixture.tools.find((tool) => tool.name === "list_issues")!;
    const labels = (declared.inputSchema as { properties: Record<string, { type?: string }> }).properties.labels;
    expect(labels.type).toBe("array");

    const schema = toolArgumentSchemas.find((tool) => tool.name === "list_issues")!.schema;
    const call = { owner: "o", repo: "r" };
    expect(schema.safeParse({ ...call, labels: ["bug"] }).success, "the advertised array").toBe(true);
    expect(schema.safeParse({ ...call, labels: [] }).success, "an empty array").toBe(true);
    // GitHub's MCP server refuses the CSV string with "parameter labels could
    // not be coerced to []string, is string" — so accepting it here would be a
    // false PASS, the class this file's header calls first in line.
    expect(schema.safeParse({ ...call, labels: "bug" }).success, "the REST CSV spelling").toBe(false);
  });

  it("names no tool the twin does not serve", () => {
    const served = new Set(
      KNOWN_RESIDUE.map((line) => /^'([^']+)'/.exec(line)?.[1]).filter((n): n is string => Boolean(n)),
    );
    expect([...served].length).toBeGreaterThan(20);
  });
});
