// SPDX-License-Identifier: Apache-2.0
//
// Minimal guard for a quickstart example. See the sibling comment in
// minimal-viktor-langgraph for what is deliberately left to the other gates.
//
// #453 set this example's budget at three cases — the launch env contract,
// preflight naming every missing var, and the curriculum lesson — on the rule
// that unit tests here cover only the SILENT-wrong-answer class, because a
// crash is `smoke:examples`, a type error is the typecheck leg, and a 404 is
// `probe:examples`. That rule is kept. The lesson slot changed contents rather
// than count: the committed tool denial it used to pin is retired (see
// `DENY_ISSUE_LOOKUP` in ../src/index.ts), and a repository policy the agent is
// never told to read took its place. The fourth case is here because the new
// lesson has a second silent failure the old one did not — see it below.
//
// NOT here, and deliberately: `tools: []` and `settingSources: []` being wired
// into the `query()` call. Those are the sandbox seal, they are load-bearing for
// every number this example reports, and `scripts/check-example-sdk-isolation.mjs`
// already resolves `examineeOptions(…)` through to the call site by AST and reds
// on either one going missing. A copy here would be a second, weaker assertion
// of a thing a dedicated gate already owns.

import { describe, expect, it } from "vitest";

import { buildSystemPrompt, policyHint, resolveTwinWiring } from "../src/index.ts";

const FULL_ENV = {
  POME_GITHUB_MCP_URL: "http://127.0.0.1:4001/s/sess_1/mcp",
  POME_SLACK_MCP_URL: "http://127.0.0.1:4002/s/sess_1/mcp",
  POME_AUTH_TOKEN: "bearer-jwt",
};

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

  // THE LESSON. `POME_TRIAGE_POLICY_HINT=on` is the one-line fix the README
  // teaches, and this is the assertion that the fix is CONNECTED — every other
  // way of testing it stays green if someone deletes `${hint}` from the prompt
  // template and leaves the helper behind. That is not hypothetical: the first
  // version of this example's suite passed with `tools:` removed from the query
  // options, which is the same disconnected-guard shape.
  //
  // Both arms are passed explicitly and neither names the shipped default, so a
  // reader running the fix does not turn a test red.
  it("wires the fix arm into the system prompt, and leaves it out of the baseline", () => {
    expect(buildSystemPrompt(policyHint(true))).toContain("docs/triage-policy.md");
    expect(buildSystemPrompt(policyHint(false))).not.toContain("docs/triage-policy.md");
  });

  // The second silent failure, and the reason this example is four cases rather
  // than three. The two arms exist to produce ONE measured difference. If the
  // fix arm also started teaching the agent how to triage — the natural thing to
  // add while "improving the hint" — the baseline and the fixed run would differ
  // in two ways at once, every number in ../VERIFICATION.md would be measuring a
  // confound, and nothing anywhere would go red. The baseline here is naive
  // about a LOCAL CONVENTION, never about triage itself.
  it("keeps the same triage rule in BOTH arms, so the two runs differ in one thing", () => {
    for (const hint of [policyHint(true), policyHint(false)]) {
      expect(buildSystemPrompt(hint)).toContain("search the open issues");
    }
  });
});
