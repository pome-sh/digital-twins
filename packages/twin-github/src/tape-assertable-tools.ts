// SPDX-License-Identifier: Apache-2.0
//
// The actions the recorder stamps on BOTH the MCP and the REST door.
//
// This is DATA, and it lives alone (F-1306). It used to live in `tools.ts`, next
// to `executeTool` and ~40 zod tool schemas, and `check-params.ts` imported it
// from there — which put the twin's entire MCP tool dispatch into the import
// graph of `@pome-sh/twin-github/checks`, a module whose whole job is to hand a
// CLI a list of assertable sentences. `pome checks` needs those sentences
// synchronously, so that subpath is loaded on every CLI invocation; 649 lines of
// tool schemas rode along for what was then a two-element string list.
//
// `tools.ts` re-exports the constant, so `routes.ts`, the package root and
// `test/tool-stamping.test.ts` all still read it from where they always did.
//
// ── Why the set is exactly these three ────────────────────────────────────────
//
// These are the only tools whose REST route is stamped with the same action name
// as their MCP tool dispatch. That is what makes `create_commit_status was never
// called` answerable: an agent that fabricates a status via
// `POST /repos/:owner/:repo/statuses/:sha` must fail the check exactly as one
// going through `tools/call` does.
//
// The set is small on purpose and MUST NOT be widened by editing this line
// alone. This twin has ~40 tools and only these three have their REST route
// stamped; adding a fourth name without stamping its route would hand a check a
// sentence it cannot honour, and F-1338 established that the damage runs in both
// directions from one missing fact. `tool` is `null` on every unstamped surface,
// and `null` means "no declared action for this surface", never "no action
// happened":
//
//   `X` was never called   the run did X by REST → no match → PASSED. The
//                          negative false-pass D4 forbids outright.
//   `X` was called         the run did X by REST → no match → FAILED. A correct
//                          agent marked down for taking the unwatched door.
//
// Two things make that hard to get wrong: `test/tool-stamping.test.ts` keeps one
// both-doors probe per member and asserts its key set equals this set, and
// `toolActionName`'s param pattern is generated from this set, so a criterion
// cannot name an action outside it. Both check ids read that one pattern, so a
// name arrives in both sentences at once or in neither.
//
// ── `add_issue_comment` is the third, and it arrived from the other side ───────
//
// F-1521, and it is the first member added for a POSITIVE criterion rather than a
// prohibition. The other two are group-D REST operations GitHub never made MCP
// tools, pulled in so task 18's forgery could not escape through the door the
// recorder was not watching. This one is a tool the twin genuinely serves, and it
// was stamped so `` `add_issue_comment` was called `` binds — the sentence
// M0's slice task needs to prove the examinee actually left the comment, which no
// prohibition can say and which the ≥2-substrates rule wants beside the state
// assertion.
//
// It is deliberately ONE name and not F-1342's remaining ~37. That ticket owns
// the sweep and keeps it; `merge_pull_request` and `add_issue_labels` are still
// unstamped and their sentences still correctly refuse to bind. What made this
// one worth pulling forward is that M0's slice depended on it while F-1342 did
// not enumerate it, so waiting would have left a milestone bullet hanging on an
// unnamed dependency.
export const TAPE_ASSERTABLE_TOOLS = [
  "create_commit_status",
  "create_check_run",
  "add_issue_comment",
] as const;
