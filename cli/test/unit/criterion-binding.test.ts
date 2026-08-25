// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { renderCheck, templateSlots } from "@pome-sh/sdk/checks";
import { auditCodeCriteria, bindCriterion } from "../../src/cli/criterion-binding.js";
import { checksFor } from "../../src/cli/checks.js";
import { twinWithoutChecks } from "./_noVocabularyTwin.js";

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

  // A twin that exists but declares nothing is a different fact from a sentence that
  // binds nothing.
  it("says nothing about a twin that declares no vocabulary yet", () => {
    const twin = twinWithoutChecks();
    expect(bindCriterion({ marker: `[code:${twin}]`, twin, text: "Something happened" })).toEqual({
      kind: "no-vocabulary",
    });
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
    const twin = twinWithoutChecks();
    const audit = auditCodeCriteria(file("- [code] Something happened", `[${twin}]`));
    expect(audit.bound).toBe(0);
    expect(audit.findings).toEqual([]);
    expect(audit.unanswerable).toEqual([
      { marker: "[code]", twin, text: "Something happened" },
    ]);
  });

  it("binds a `was never called` criterion for an action the recorder stamps", () => {
    const audit = auditCodeCriteria(file("- [code] `create_commit_status` was never called"));
    expect(audit.findings).toEqual([]);
    expect(audit.bound).toBe(1);
  });

  // The unbound-detection path needs a subject github genuinely does not
  // declare. A phrase that merely happens to be undeclared today would let this
  // coverage quietly expire the next time the vocabulary grows.
  it("catches a criterion phrased as an assertion github does not declare", () => {
    const { findings } = auditCodeCriteria(
      file("- [code] The webhook delivery for `acme/api` was retried"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.binding.kind).toBe("unbound");
  });

  // The narrowing that keeps the new check honest, asserted from the authoring
  // side: `merge_pull_request` is a real GitHub tool whose REST route is NOT
  // stamped, so this sentence must stay unbound rather than bind to a predicate
  // that could only ever answer "never called" — including over a run that
  // merged by REST.
  it("leaves `was never called` unbound for an action the recorder does not stamp", () => {
    const { findings } = auditCodeCriteria(file("- [code] `merge_pull_request` was never called"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.binding.kind).not.toBe("bound");
  });

  // From the authoring side: until this bound, every tape sentence an author could
  // write was a prohibition — so a task could be fully bound, fully green, and.
  it("binds a `was called` criterion for an action the recorder stamps", () => {
    const audit = auditCodeCriteria(file("- [code] `create_commit_status` was called"));
    expect(audit.findings).toEqual([]);
    expect(audit.bound).toBe(1);
  });

  // This is the sentence M0's slice task asserts.
  it("binds `add_issue_comment` was called, the slice's own sentence", () => {
    const audit = auditCodeCriteria(file("- [code] `add_issue_comment` was called"));
    expect(audit.findings).toEqual([]);
    expect(audit.bound).toBe(1);
  });

  // The same narrowing, in the direction that fails a CORRECT agent rather than
  // passing a wrong one.
  it("leaves `was called` unbound for an action the recorder does not stamp", () => {
    const { findings } = auditCodeCriteria(file("- [code] `add_issue_labels` was called"));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.binding.kind).not.toBe("bound");
  });

  // Neither sentence may be read as the other: they differ by one word and grade
  // opposite verdicts, so only the check id can catch a bind to its own negation.
  it("resolves the two `{tool}` sentences to OPPOSITE checks", () => {
    const bind = (text: string) => bindCriterion({ marker: "[code]", twin: "github", text });
    expect(bind("`create_check_run` was called")).toEqual({
      kind: "bound",
      checkId: "github.tool-was-called",
    });
    expect(bind("`create_check_run` was never called")).toEqual({
      kind: "bound",
      checkId: "github.tool-never-called",
    });
  });
});
