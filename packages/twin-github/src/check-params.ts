// SPDX-License-Identifier: Apache-2.0
//
// The typed slots GitHub's declared checks fill (F-1075).
//
// These live in the twin, not the sdk, for the same reason the declarations do:
// the twin owns what a GitHub label name or a GitHub login may look like. The
// sdk owns only the grammar — `oneOf`, `repoRef`, and the generator.
//
// Every pattern here is NARROW on purpose. A slot type is what turns "the
// author typed something wrong" into a corrupted instance reported by name,
// instead of a lookup that quietly finds nothing and fails for an unrelated
// reason. Widening one to make a sentence bind is almost always the wrong
// repair — the sentence should be re-rendered from the check instead.

import { oneOf, type CheckParamType } from "@pome-sh/sdk/checks";
// From the standalone data module, NOT from `./tools.js` (F-1306): this file is
// in the eager import graph of `@pome-sh/twin-github/checks`, which the CLI
// loads on every invocation, and `tools.ts` carries ~40 zod tool schemas plus
// `executeTool`'s domain dispatch. `tools.ts` re-exports the same constant.
import { TAPE_ASSERTABLE_TOOLS } from "./tape-assertable-tools.js";

// Issue and pull-request numbers. `[1-9][0-9]*` rather than `\d+`: GitHub
// numbers entities from 1, so `#0` names nothing and `#01` is a different
// string from the `#1` this check would re-render. Both are corrupted instances
// worth reporting rather than lookups that silently miss.
const entityNumber = (name: string): CheckParamType => ({
  name,
  pattern: "[1-9][0-9]*",
  example: "1",
  render: (value) => value,
  parse: (raw) => raw,
});

export const issueNumber = entityNumber("issue");
export const prNumber = entityNumber("pr");

// Backtick-delimited in every template that uses one, so the only hard
// exclusion is the backtick itself — a label may legitimately carry spaces,
// slashes, colons and emoji (`good first issue`, `area/api`, `P0: urgent`).
// Newline is excluded because a criterion is one line by construction; letting
// it through would make a malformed multi-line sentence bind.
export const labelName: CheckParamType = {
  name: "label",
  pattern: "[^`\\n]+",
  example: "bug",
  render: (value) => value,
  parse: (raw) => raw,
};

// A GitHub login: alphanumerics and single hyphens, never leading or trailing.
// Narrower than `labelName` on purpose — an assignee that fails to parse is
// almost always a display name where a login was meant, and saying so beats
// reporting "issue #1 has no such assignee".
export const login: CheckParamType = {
  name: "login",
  pattern: "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?",
  example: "alice",
  render: (value) => value,
  parse: (raw) => raw,
};

export const filePath: CheckParamType = {
  name: "path",
  pattern: "[^`\\n]+",
  example: "src/index.ts",
  render: (value) => value,
  parse: (raw) => raw,
};

// Double-quote delimited in its template, so the quote is the exclusion. This
// is the one slot whose value is SCANNED inside free text rather than compared
// to a field, which is why its checks declare it as their `subject`.
export const commentNeedle: CheckParamType = {
  name: "needle",
  pattern: '[^"\\n]+',
  example: "Deploy blocked",
  render: (value) => value,
  parse: (raw) => raw,
};

// A commit status's `context` — GitHub's name for the reporting check
// ("ci/build", "codecov/patch").
export const statusContext: CheckParamType = {
  name: "context",
  pattern: '[^"\\n]+',
  example: "ci/build",
  render: (value) => value,
  parse: (raw) => raw,
};

// ── Closed sets ──────────────────────────────────────────────────────────────
//
// Each of these was an inline alternation inside a legacy regex, where no
// authoring surface could read it. As declared param types the set travels with
// the check: `pome checks github` prints it, the picker offers it, and a value
// outside it is reported as a corrupted instance.
//
// They also cost something, and it is named here rather than discovered later:
// a closed set has NO value guaranteed to be false, so a check whose only
// scanned slot is an enum cannot declare a vacuity mutant. See
// `HONEST_NULL_MUTANTS` in the contract test.

export const issueState = oneOf("state", ["open", "closed"]);

// "not merged" first so the set reads in the order an author thinks about it;
// the generated pattern is anchored, so ordering cannot change what binds.
export const pullRequestState = oneOf("state", ["merged", "not merged", "open", "closed"]);

// The API's own review states, and only those. The legacy regex also accepted
// `REQUEST_CHANGES` (the review *event* verb) and folded it onto
// `CHANGES_REQUESTED`, because an author typing English could reasonably reach
// for either. Under a picked check there is nothing to fold: the author selects
// from this set and the system writes the sentence.
export const reviewState = oneOf(
  "review",
  ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"],
  "APPROVED",
);

export const commitStatusState = oneOf(
  "state",
  ["success", "failure", "pending", "error"],
  "success",
);

// F-1125 — a twin ACTION a tape check may assert was never called.
//
// The set is not a matter of taste and it is not this file's to choose: it is
// `TAPE_ASSERTABLE_TOOLS`, the actions the recorder stamps on BOTH the MCP and
// the REST door. Deriving the pattern from that constant rather than restating
// the names here is the load-bearing part. A twin has ~40 tools, and a criterion
// naming one whose REST route is unstamped could only ever answer "never
// called" — including over a run that performed it by REST, which is the
// negative false-pass D4 forbids. Typed to the stamped set, that sentence does
// not bind at all: it stays visibly unresolved in the corpus instead of grading
// green on evidence nobody recorded.
//
// A closed set costs the vacuity mutant (see `HONEST_NULL_MUTANTS`). Paying it
// is the right trade here — a probe gap is an admitted blind spot, and a
// false-passing negative is a wrong verdict.
export const toolActionName = oneOf(
  "tool",
  [...TAPE_ASSERTABLE_TOOLS],
  TAPE_ASSERTABLE_TOOLS[0],
);
