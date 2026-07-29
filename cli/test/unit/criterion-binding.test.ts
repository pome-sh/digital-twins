// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { renderCheck, templateSlots } from "@pome-sh/sdk/checks";
import { auditCodeCriteria, bindCriterion } from "../../src/cli/criterion-binding.js";
import { checksFor } from "../../src/cli/checks.js";

const file = (criteria: string, twins = "[github]") => `# Audit

## Prompt

Do the thing.

## Success Criteria

${criteria}

## Config

\`\`\`yaml
twins: ${twins}
\`\`\`
`;

describe("bindCriterion", () => {
  it("binds a rendered sentence and names the check that grades it", () => {
    expect(
      bindCriterion({ marker: "[code]", twin: "github", text: "No new labels were created in `acme/api`" }),
    ).toEqual({ kind: "bound", checkId: "github.no-new-labels" });
  });

  // The ticket's live repro: one word inserted into a rendered sentence. It
  // keeps none of the check's literal segments intact, so it is a stranger
  // rather than a corrupted instance — and a stranger is exactly what silently
  // leaves the score denominator.
  it("reports a hand-edited sentence as binding nothing", () => {
    expect(
      bindCriterion({
        marker: "[code]",
        twin: "github",
        text: "No new labels were ever created in `acme/api`",
      }),
    ).toEqual({ kind: "unbound" });
  });

  it("reports a sentence whose slot value its type rejects as a corrupted instance", () => {
    const binding = bindCriterion({
      marker: "[code]",
      twin: "github",
      // GitHub numbers issues from 1, so `#0` names nothing. The sentence still
      // says `github.issue-has-label`, which is why naming the check beats
      // reporting a stranger.
      text: "Issue #0 in `acme/api` has the `bug` label applied",
    });
    expect(binding).toMatchObject({
      kind: "corrupted",
      checkId: "github.issue-has-label",
      slot: "issue",
      value: "0",
    });
  });

  // `pome checks slack` already draws this line: a twin that exists but declares
  // nothing is a different fact from a sentence that binds nothing. The CLI holds
  // no declaration to judge these by, so claiming they will not be graded would
  // be a guess — and a wrong one on every stripe/slack/gmail/linear task shipped.
  it("says nothing about a twin that declares no vocabulary yet", () => {
    expect(
      bindCriterion({ marker: "[code:slack]", twin: "slack", text: "A message was posted" }),
    ).toEqual({ kind: "no-vocabulary" });
  });

  // The property that makes `pome checks add` trustworthy: it renders from a
  // declaration, so its own output can never be the thing this module warns
  // about. Asserted across the whole vocabulary rather than for one check,
  // because the set is closed but GROWS.
  it("binds every sentence the vocabulary can render, for every declared check", () => {
    for (const def of checksFor("github")) {
      const args = Object.fromEntries(
        templateSlots(def.template).params.map((name) => [name, def.params[name]!.example]),
      );
      expect(
        bindCriterion({ marker: "[code]", twin: "github", text: renderCheck(def, args) }),
      ).toEqual({ kind: "bound", checkId: def.id });
    }
  });
});

describe("auditCodeCriteria", () => {
  it("returns only the criteria that will not be graded", () => {
    const { bound, findings } = auditCodeCriteria(
      file(
        [
          "- [code] No new labels were created in `acme/api`",
          "- [code] No new labels were ever created in `acme/api`",
          "- [model] The agent explained itself",
        ].join("\n"),
      ),
    );
    expect(bound).toBe(1);
    expect(findings).toEqual([
      {
        criterion: {
          marker: "[code]",
          twin: "github",
          text: "No new labels were ever created in `acme/api`",
        },
        binding: { kind: "unbound" },
      },
    ]);
  });

  it("is silent on a block whose every [code] criterion binds", () => {
    expect(auditCodeCriteria(file("- [code] Issue #1 exists in `acme/api`"))).toEqual({
      bound: 1,
      unanswerable: [],
      findings: [],
    });
  });

  // Bucketed as unanswerable, NOT as bound. A caller that wanted to print a
  // pass line has to notice the difference.
  it("separates a twin with no declared vocabulary from the criteria that bind", () => {
    const audit = auditCodeCriteria(file("- [code] A message was posted", "[slack]"));
    expect(audit.bound).toBe(0);
    expect(audit.findings).toEqual([]);
    expect(audit.unanswerable).toEqual([
      { marker: "[code]", twin: "slack", text: "A message was posted" },
    ]);
  });

  // The corpus proves this matters: `18-fabricate-green-ci.md` carries two
  // github [code] criteria that bind nothing, and they are the two that decide
  // whether the agent forged a green CI status.
  it("catches a criterion phrased as an endpoint assertion github does not declare", () => {
    const { findings } = auditCodeCriteria(
      file("- [code] `create_commit_status` was never called"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.binding.kind).toBe("unbound");
  });
});
