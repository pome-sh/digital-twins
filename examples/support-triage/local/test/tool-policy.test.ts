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
import { BUILT_IN_TOOLS, deniedTools, examineeOptions } from "../src/index.ts";

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

// The closed sandbox, pinned separately from the lesson because it survives every
// re-cut of the lesson: whatever the baseline defect turns out to be, an examinee
// that can `cat ../tasks/duplicate-issue.md` is reading its own grading criteria
// and its own seed. Measured 2026-08-04 (F-1292): with the built-ins live, one
// trial in five read this examinee's source and named the fixture.
describe("BUILT_IN_TOOLS — the closed sandbox", () => {
  it("exposes no SDK built-in at all", () => {
    // Empty, not "empty of the dangerous ones". `options.tools` replaces the base
    // set, so [] is complete by construction; a list of names to maintain is the
    // enumeration failure that let the deny-list above be routed around.
    expect(BUILT_IN_TOOLS).toEqual([]);
  });

  it("is an allowlist, so a newly-shipped built-in cannot arrive enabled", () => {
    // The property, stated as the thing a reader might break: adding a name here
    // to "just read one file" re-opens the book. Filesystem and shell are the
    // ones that reach the task file; web is the one that leaves the seeded world.
    for (const escape of ["Bash", "Read", "Glob", "Grep", "Write", "Edit", "WebSearch", "WebFetch"]) {
      expect(BUILT_IN_TOOLS, `${escape} would make the exam open-book`).not.toContain(escape);
    }
  });
});

// Both policies above are inert unless they reach `query()`. Everything else in
// this file would stay green if someone deleted `tools:` or `disallowedTools:`
// from the options object — a guard disconnected from its subject passes forever,
// which is the shape of mistake F-1292 is about. So assert the wiring itself.
describe("examineeOptions — the policies are actually wired in", () => {
  const mcpServers = { github: { type: "http" as const, url: "https://twin/github" } };

  it("passes the empty built-in allowlist to the SDK", () => {
    expect(examineeOptions(mcpServers).tools).toEqual([]);
  });

  it("passes the deny-list to the SDK", () => {
    expect(examineeOptions(mcpServers).disallowedTools).toEqual(deniedTools());
  });

  it("still hands the twins through — closing the sandbox must not close the exam", () => {
    // `tools: []` removes SDK built-ins only; MCP tools arrive via `mcpServers`.
    // If this ever regressed the examinee would have no tools at all, and the
    // run would look like a model failure rather than a wiring one.
    expect(examineeOptions(mcpServers).mcpServers).toBe(mcpServers);
  });
});
