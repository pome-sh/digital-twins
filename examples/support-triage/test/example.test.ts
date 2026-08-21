// SPDX-License-Identifier: Apache-2.0
//
// Minimal guard for a quickstart example. See the sibling comment in
// minimal-viktor-langgraph for what is deliberately left to the other gates.

import { describe, expect, it } from "vitest";

import { deniedTools, resolveTwinWiring } from "../src/index.ts";

const FULL_ENV = {
  POME_GITHUB_MCP_URL: "http://127.0.0.1:4001/s/sess_1/mcp",
  POME_SLACK_MCP_URL: "http://127.0.0.1:4002/s/sess_1/mcp",
  POME_AUTH_TOKEN: "bearer-jwt",
};

// The twin's only three read paths to an issue. The baseline denies all three,
// which is the defect: the agent is told to search, is refused, and files a
// duplicate of an issue #1 already tracks.
const ISSUE_LOOKUP = [
  "mcp__github__search_issues",
  "mcp__github__list_issues",
  "mcp__github__get_issue",
];

describe("support-triage", () => {
  it("reads its twin wiring from the platform-convention env vars", () => {
    const wiring = resolveTwinWiring(FULL_ENV);
    expect(wiring.githubMcpUrl).toBe(FULL_ENV.POME_GITHUB_MCP_URL);
    expect(wiring.slackMcpUrl).toBe(FULL_ENV.POME_SLACK_MCP_URL);
    expect(wiring.authToken).toBe("bearer-jwt");
  });

  // A mis-assembled launch must die in preflight naming what is missing, not
  // half-way through a run.
  it("fails loudly, naming every missing var, when the env is empty", () => {
    expect(() => resolveTwinWiring({})).toThrow(/POME_GITHUB_MCP_URL/);
    expect(() => resolveTwinWiring({})).toThrow(/POME_SLACK_MCP_URL/);
    expect(() => resolveTwinWiring({})).toThrow(/POME_AUTH_TOKEN/);
  });

  // The curriculum lesson, with both branches passed explicitly so applying the
  // one-line fix the README teaches does not turn this red.
  it("denies issue lookup in the baseline and allows it once fixed", () => {
    for (const tool of ISSUE_LOOKUP) {
      expect(deniedTools(true), `${tool} was left reachable`).toContain(tool);
      expect(deniedTools(false), `${tool} is still denied after the fix`).not.toContain(tool);
    }
  });
});
