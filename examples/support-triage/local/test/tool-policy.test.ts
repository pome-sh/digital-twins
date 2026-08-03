// SPDX-License-Identifier: Apache-2.0
//
// The curriculum lesson this example teaches, pinned as a property.
//
// The baseline defect is committed CONFIGURATION: `deniedTools()` strips the
// agent's read access to existing issues, so it searches (its prompt tells it
// to), is refused, and files a duplicate for a bug issue #1 already tracks.
//
// WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT: which way `DENY_ISSUE_LOOKUP`
// currently ships. A test that pinned the shipped value would go red the moment
// a reader applies the one-line fix the README teaches — a guard you have to
// edit to make green is not a guard. Both branches are exercised by passing the
// flag explicitly.
//
// It earns its place twice over. The denial list LOOKS like ordinary hardening —
// a reader tidying up "unused" entries deletes the lesson — and the three names
// are the twin's ONLY read paths to an issue, so a fourth one appearing upstream
// would silently hand the baseline a way around its own defect.
import { describe, expect, it } from "vitest";
import { deniedTools } from "../src/index.ts";

const ISSUE_LOOKUP = [
  "mcp__github__search_issues",
  "mcp__github__list_issues",
  "mcp__github__get_issue",
];

describe("deniedTools — the committed baseline defect", () => {
  it("denies every read path to an issue in the baseline", () => {
    const denied = deniedTools(true);
    for (const tool of ISSUE_LOOKUP) {
      expect(denied, `${tool} was left reachable`).toContain(tool);
    }
  });

  it("denies none of them once the fix is applied", () => {
    const denied = deniedTools(false);
    for (const tool of ISSUE_LOOKUP) {
      expect(denied, `${tool} is still denied after the fix`).not.toContain(tool);
    }
  });

  // The closed-book clamp is NOT the lesson and must survive the fix. An agent
  // that can reach the open web is taking a different exam, and a fix that
  // silently re-opened it would change what the green run even measured.
  it("keeps the web tools denied on both sides — that clamp is not the lesson", () => {
    for (const flag of [true, false]) {
      expect(deniedTools(flag)).toContain("WebSearch");
      expect(deniedTools(flag)).toContain("WebFetch");
    }
  });

  // The write paths are what make the FIXED variant able to pass. If the defect
  // ever grew to cover them, the green side would have no way through and the
  // example would teach "the agent can do nothing" instead of "the agent could
  // not look before it leapt".
  it("never denies the write paths the fixed variant needs", () => {
    for (const flag of [true, false]) {
      const denied = deniedTools(flag);
      expect(denied).not.toContain("mcp__github__add_issue_comment");
      expect(denied).not.toContain("mcp__github__create_issue");
      expect(denied).not.toContain("mcp__slack__post_message");
    }
  });

  it("differs on exactly the issue-lookup tools", () => {
    const extra = deniedTools(true).filter((tool) => !deniedTools(false).includes(tool));
    expect(extra).toEqual(ISSUE_LOOKUP);
  });
});
