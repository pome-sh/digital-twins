# twin-github: the ten MCP tools GitHub declares and this twin does not serve

F-1468. Companion to [`github-mcp-twin-only-tools.md`](github-mcp-twin-only-tools.md),
which rules the two tools going the other way.

## Where this list comes from

`packages/twin-github/fixtures/mcp-tools-list.*` stopped being a transcription of
`src/tools.ts` in F-1468 and became a projection of the upstream capture at
[`fixtures/mcp-tools-list/github.*`](../fixtures/mcp-tools-list/) — GitHub's own
`default` toolset, built from `github/github-mcp-server` at the pinned release.
The producer is
[`packages/twin-github/scripts/adopt-upstream-mcp-fixture.ts`](../packages/twin-github/scripts/adopt-upstream-mcp-fixture.ts);
`npm run gate:mcp-fixture -w @pome-sh/twin-github` re-derives and diffs, and CI
runs it.

The capture carries 44 tools. This twin serves 36. Ten of the difference are
below; the other two go the opposite way and are the companion document's
subject.

Each reason here is the same string the fixture ships in
`meta.projection.dropped`, and the same one pome-cloud's
`known-divergences/github.mcp.yaml` registers against `mcp-tool-upstream-only`
(GITHUB-MCP-003 … 010). Three copies, one author, so the register a gate reads
cannot drift from the file a person reads.

## Eight are scope

The twin has no data model behind these. Closing one means building the
capability, not adding an endpoint.

| Tool | Entry | Why not |
|---|---|---|
| `assign_copilot_to_issue` | GITHUB-MCP-003 | Nothing models the Copilot coding agent — no assignment, no session, no resulting branch or PR. |
| `request_copilot_review` | GITHUB-MCP-003 | Same absence. A review the twin cannot produce is not one an examinee can be graded on requesting. |
| `get_teams` | GITHUB-MCP-004 | No organization teams. Access control is per-repository (`src/access-control.ts`) with no membership graph behind it. |
| `get_team_members` | GITHUB-MCP-004 | Same absence — there is no team to enumerate. |
| `add_comment_to_pending_review` | GITHUB-MCP-005 | No pending-review workflow. `pull_request_review_write` creates a review in one call, so no draft exists for a comment to attach to. |
| `list_issue_types` | GITHUB-MCP-006 | Organization-level issue types are not modeled; the twin's issues carry labels and state and no type. |
| `list_issue_fields` | GITHUB-MCP-007 | Projects-v2 issue fields are not modeled — there is no project board for a field to belong to. |
| `sub_issue_write` | GITHUB-MCP-008 | No sub-issue hierarchy: issues have no parent and no children, so there is no edge to write and nothing to read back. |

## Two are not

These are coverage gaps somebody should close. They are in the same register
because the register is where an unserved tool has to be *visible*, not because
they are equally acceptable — and each says so in its own reason, so a reader
skimming the register does not file them next to `get_teams`.

pome-cloud's declared lane has a `disposition: open-defect` field for exactly
this distinction. The MCP-lane registry does not, so the marker is the literal
string `[COVERAGE GAP]` at the head of the reason.

### `get_label` — GITHUB-MCP-009

The twin **does** model labels: `src/routes.ts` serves list-repository-labels,
create-repository-label and list-issue-labels. What it has no MCP tool for is
reading one label by name. Closing this is one route plus one tool entry, not a
capability. **Delete the entry when it lands; do not renew it.**

Impact today: an examinee that reads a single label finds no tool here and would
find one at GitHub. A refusal, which is a false FAILURE — visible, and the less
dangerous of the two shapes.

### `search_pull_requests` — GITHUB-MCP-010

The sharper one. GitHub's `search_pull_requests` is `/search/issues` scoped to
`is:pr`. This twin serves `search_issues` **unscoped**.

So an examinee searching for pull requests does not get an error here — it gets
issues. A task grading that result scores a wrong answer as a right one, which
is a **false PASS**, and a grading instrument should not carry one longer than it
has to. It is registered rather than hidden, and it should be closed.

## When an entry here is wrong

Three ways, and two of them fail a gate on their own:

- **GitHub retires the tool.** `adopt-upstream-mcp-fixture.ts` refuses a
  `DROPPED` name the capture does not carry — a suppression protecting nothing
  is a typo away from hiding a real divergence, so it fails rather than passing
  quietly. Delete the entry here and in `github.mcp.yaml`.
- **The twin starts serving it.** pome-cloud's MCP-lane registry fails an entry
  that accepted nothing on a run where the comparison ran (dead cover). Delete
  the `github.mcp.yaml` entry; the row moves into the projection on its own.
- **The scope ruling stops being true** — someone models Copilot, or teams, or
  the two-phase review. Nothing catches that automatically, which is why the
  reasons above name the capability rather than the tool: a reader who has just
  built the capability can see that the sentence has expired.
