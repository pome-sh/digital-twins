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
// This one does not, and the reason is not effort: closing an entry here usually
// TIGHTENS what the twin accepts, and a tightening breaks every task written
// against the twin as it is. It ships with a corpus heat reading and its
// migrations (F-1330's discipline), not with a fixture swap.
//
// That reading ran, and the three tightenings it cleared are gone from this list
// rather than sitting in it: `query` required on the five search tools and
// `branch` on the two file writers (zero callers measured across the corpus, the
// bundled examples, 17 hosted saved tasks and 50 hosted runs), and
// `list_issues.state` on GitHub's casing (one caller, migrated in the same
// change). What remains is what still has heat, or still wants a ruling.
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
//   FALSE PASS — the twin accepts what GitHub refuses. One left:
//     `create_pull_request` takes a call with no `base`. An examinee that omits
//     the argument is graded as succeeding here and would fail against GitHub.
//     Worst class for a grading instrument, and first in line.
//
//     The other four went in F-1468's tightening, once the heat read found them
//     free: `query` on the five search tools and `branch` on the two file
//     writers had zero callers anywhere, and `list_issues.state` had exactly one
//     (examples/triage-agent), migrated in the same change.
//   ALIAS — the twin validates a snake_case spelling GitHub does not declare
//     (`per_page`, `pull_number`, `q`, `expected_head_sha`) ALONGSIDE the
//     camelCase one. Breaks nobody today and is invisible to an examinee
//     reading the listing; removing an alias is the breaking half.
//   UNMODELLED — GitHub declares an argument the twin ignores (`sort`, `order`,
//     `fields`, `draft`, `reviewers`). Silently dropped rather than refused, so
//     an examinee that passes it is graded on a call the twin did not make.
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

  // ⚠️ REQUIRED MEANS PRESENT, NOT TRUTHY. F-1468's first cut wrote the search
  // tools' refine as `value.query ?? value.q`, which rejects `q: ""` — and
  // GitHub declares `query` as a plain string with no `minLength`, so an empty
  // one is a call the vendor accepts. Requiring an argument is not licence to
  // narrow its domain: that would have swapped a false PASS for a false FAILURE,
  // the very trade this ticket exists to avoid. The CLI's own smoke app caught
  // it (`search_repositories` with `{ q: "" }`), which is luck, so it is pinned
  // here where it is the subject.
  it("an EMPTY query satisfies the requirement, because GitHub declares no minimum", () => {
    for (const name of ["search_repositories", "search_code", "search_users", "search_issues", "search_commits"]) {
      const schema = toolArgumentSchemas.find((t) => t.name === name)!.schema;
      expect(schema.safeParse({ query: "" }).success, `${name} query:""`).toBe(true);
      expect(schema.safeParse({ q: "" }).success, `${name} q:""`).toBe(true);
      // …and absent is still absent.
      expect(schema.safeParse({}).success, `${name} {}`).toBe(false);
    }
  });

  // ── THE TYPE AXIS (F-1614) ────────────────────────────────────────────────
  //
  // The residue above compares which arguments each side has and which it
  // requires. Until F-1614 it compared nothing else, and that gap shipped a
  // defect for as long as the pin existed: GitHub declared `list_issues.labels`
  // as an array of strings, this twin validated it as one string, both
  // documents had the key, neither required it, and `toolSchemaConformance()`
  // reported nothing — while the twin answered 422 `invalid_type` to the exact
  // shape its own listing advertises.
  //
  // These three cases are the guard on the guard. The real fixture now agrees
  // everywhere, so a test that only read it would pass whether the comparison
  // worked or not.
  describe("a TYPE disagreement on a shared key is reported", () => {
    it("catches the exact shape F-1614 was, replayed against a planted pair", () => {
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

  // F-1614's own regression at the fixture level: the tool that carried the
  // defect is asserted against GitHub's declaration directly, so a future edit
  // that puts `labels` back on a string fails here as well as in
  // `upstream-measured-semantics.test.ts`.
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
