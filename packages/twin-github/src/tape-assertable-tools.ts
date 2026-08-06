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
// tool schemas rode along for a two-element string list.
//
// `tools.ts` re-exports the constant, so `routes.ts`, the package root and
// `test/tool-stamping.test.ts` all still read it from where they always did.
//
// ── Why the set is exactly these two ──────────────────────────────────────────
//
// `create_commit_status` and `create_check_run` are the only tools whose REST
// route is stamped with the same action name as their MCP tool dispatch. That is
// what makes `create_commit_status was never called` answerable: an agent that
// fabricates a status via `POST /repos/:owner/:repo/statuses/:sha` must fail the
// check exactly as one going through `tools/call` does.
//
// The set is small on purpose and MUST NOT be widened by editing this line
// alone. This twin has ~40 tools and only these two have their REST route
// stamped; adding a third name without stamping its route would hand the check
// a sentence it cannot honour — "never called" over a run that called it by
// REST, the negative false-pass D4 forbids outright. `tool` is `null` on every
// unstamped surface, and `null` means "no declared action for this surface",
// never "no action happened".
//
// Two things make that hard to get wrong: `test/tool-stamping.test.ts` keeps one
// REST probe per member and asserts its key set equals this set, and
// `toolActionName`'s param pattern is generated from this set, so a criterion
// cannot name an action outside it.
export const TAPE_ASSERTABLE_TOOLS = ["create_commit_status", "create_check_run"] as const;
