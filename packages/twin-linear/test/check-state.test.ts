// SPDX-License-Identifier: Apache-2.0
// The four outcomes of resolving a Linear issue by title.

import { describe, expect, it } from "vitest";
import {
  isTruncated,
  resolveComments,
  resolveIssue,
  resolveLabelNames,
  resolveUserLabels,
  resolveWorkflowStateName,
  type LinearCheckState,
  type LinearCheckStateIssue,
} from "../src/check-state.js";

const TEAM = { id: "team_eng", key: "ENG", name: "Engineering" };
const STATE_PROGRESS = {
  id: "state_progress",
  teamId: "team_eng",
  name: "In Progress",
  type: "started",
};
const LABEL_AGENT = { id: "label_agent", teamId: "team_eng", name: "Agent" };

function world(over: Partial<LinearCheckState> = {}): LinearCheckState {
  return {
    teams: [TEAM],
    workflowStates: [STATE_PROGRESS],
    labels: [LABEL_AGENT],
    issues: [
      {
        id: "issue_1",
        teamId: "team_eng",
        title: "Orders 500 after deploy",
        stateId: "state_progress",
        estimate: 2,
        labelIds: ["label_agent"],
        archivedAt: null,
      },
    ],
    comments: [{ id: "c1", issueId: "issue_1", parentId: null, body: "opened" }],
    users: [{ id: "user_dev", email: "dev@pome-twin.test", name: "Developer" }],
    exportBounds: { truncatedCollections: [] },
    ...over,
  };
}

/** The resolved issue, or an explicit failure — never `as never`. */
function issueIn(state: LinearCheckState, team = "ENG", title = "Orders 500 after deploy") {
  const r = resolveIssue(state, team, title);
  if ("missing" in r) throw new Error(`expected a resolved issue, got: ${r.missing}`);
  return r.found;
}

describe("resolveIssue — the four outcomes", () => {
  it("finds the issue by title within its team", () => {
    expect(issueIn(world()).id).toBe("issue_1");
  });

  it("FAILS, does not skip, when the title is absent and the collection is complete", () => {
    const r = resolveIssue(world(), "ENG", "Never created");
    expect("missing" in r && r.skip).toBe(false);
    expect("missing" in r && r.missing).toContain("`ENG`");
    // The title is a selector, not a declared subject, so it may not have
    // survived redaction — it must never be echoed into a reason string.
    expect("missing" in r && r.missing).not.toContain("Never created");
  });

  it("SKIPS when the issues collection was truncated by STATE_EXPORT_CAP", () => {
    const r = resolveIssue(
      world({ exportBounds: { truncatedCollections: ["issues"] } }),
      "ENG",
      "Never created",
    );
    expect("missing" in r && r.skip).toBe(true);
    expect("missing" in r && r.missing).toBe("state_truncated");
  });

  it("still resolves a PRESENT issue even when the collection was truncated", () => {
    // Truncation only excuses a MISS. A hit is a hit.
    const truncated = world({ exportBounds: { truncatedCollections: ["issues"] } });
    expect(issueIn(truncated).id).toBe("issue_1");
  });

  it("SKIPS when the issues collection is absent entirely", () => {
    const r = resolveIssue(world({ issues: null }), "ENG", "Orders 500 after deploy");
    expect("missing" in r && r.missing).toBe("state_incomplete");
    expect("missing" in r && r.skip).toBe(true);
  });

  it("SKIPS when the teams collection is absent entirely", () => {
    const r = resolveIssue(world({ teams: null }), "ENG", "Orders 500 after deploy");
    expect("missing" in r && r.missing).toBe("state_incomplete");
    expect("missing" in r && r.skip).toBe(true);
  });

  it("FAILS on an ambiguous title, naming the count and not the title", () => {
    const dup = world();
    dup.issues = [...dup.issues!, { ...dup.issues![0]!, id: "issue_2" }];
    const r = resolveIssue(dup, "ENG", "Orders 500 after deploy");
    expect("missing" in r && r.skip).toBe(false);
    expect("missing" in r && r.missing).toContain("2 issues");
    expect("missing" in r && r.missing).not.toContain("Orders 500 after deploy");
  });

  it("FAILS when the team key is absent", () => {
    const r = resolveIssue(world(), "OPS", "Orders 500 after deploy");
    expect("missing" in r && r.skip).toBe(false);
    // The team key is `[A-Z][A-Z0-9]*` — no redactor pattern matches it, so it
    // is the one selector a reason string may quote.
    expect("missing" in r && r.missing).toContain("`OPS`");
  });

  it("treats an archived issue as absent", () => {
    const archived = world();
    archived.issues = [{ ...archived.issues![0]!, archivedAt: "2026-07-30T00:00:00.000Z" }];
    const r = resolveIssue(archived, "ENG", "Orders 500 after deploy");
    expect("missing" in r).toBe(true);
  });

  it("scopes the title search to the named team", () => {
    const twoTeams = world();
    twoTeams.teams = [TEAM, { id: "team_ops", key: "OPS", name: "Ops" }];
    twoTeams.issues = [
      ...twoTeams.issues!,
      {
        id: "issue_ops",
        teamId: "team_ops",
        title: "Orders 500 after deploy",
        archivedAt: null,
      },
    ];
    // Title uniqueness is validated PER TEAM (`seed.ts:319-325`), so this world
    // is legal and an unscoped search would grade whichever sorted first.
    expect(issueIn(twoTeams, "ENG").id).toBe("issue_1");
    expect(issueIn(twoTeams, "OPS").id).toBe("issue_ops");
  });

  it("matches the title exactly, not case-insensitively", () => {
    const r = resolveIssue(world(), "ENG", "orders 500 after deploy");
    expect("missing" in r).toBe(true);
  });
});

describe("the indirect joins", () => {
  it("resolves the workflow state NAME through stateId, team-scoped", () => {
    // And the path points at the CATALOG ROW's name, not at the issue.
    expect(resolveWorkflowStateName(world(), issueIn(world()))).toEqual({
      found: "In Progress",
      path: "/workflowStates/0/name",
    });
  });

  it("skips workflow_state_unresolved when the state row belongs to another team", () => {
    const w = world({ workflowStates: [{ ...STATE_PROGRESS, teamId: "team_ops" }] });
    expect(resolveWorkflowStateName(w, issueIn(w))).toEqual({
      missing: "workflow_state_unresolved",
      skip: true,
      searched: "/workflowStates",
    });
  });

  it("skips state_incomplete when workflowStates is absent", () => {
    const w = world({ workflowStates: null });
    expect(resolveWorkflowStateName(w, issueIn(w))).toEqual({
      missing: "state_incomplete",
      skip: true,
    });
  });

  it("resolves label NAMES through labelIds, lowercased", () => {
    expect(resolveLabelNames(world(), issueIn(world()))).toEqual({
      found: new Set(["agent"]),
      path: "/labels",
    });
  });

  it("skips label_unresolved when a linked label has no catalog row", () => {
    const w = world();
    w.issues = [{ ...w.issues![0]!, labelIds: ["label_agent", "label_ghost"] }];
    expect(resolveLabelNames(w, issueIn(w))).toEqual({
      missing: "label_unresolved",
      skip: true,
      searched: "/labels",
    });
  });

  it("returns an empty set for an issue with no labels", () => {
    const w = world();
    w.issues = [{ ...w.issues![0]!, labelIds: [] }];
    expect(resolveLabelNames(w, issueIn(w))).toEqual({ found: new Set(), path: "/labels" });
  });

  it("returns only the comments on the given issue", () => {
    const w = world();
    w.comments = [...w.comments!, { id: "c2", issueId: "issue_other", body: "elsewhere" }];
    const r = resolveComments(w, issueIn(w));
    expect("found" in r && r.found.map((c) => c.id)).toEqual(["c1"]);
  });

  it("skips state_incomplete when comments is absent", () => {
    const w = world({ comments: null });
    expect(resolveComments(w, issueIn(w))).toEqual({ missing: "state_incomplete", skip: true });
  });

  it("offers every spelling of a user the legacy assignee rule accepted", () => {
    const w = world();
    w.users = [
      { id: "user_dev", email: "dev@pome-twin.test", name: "Developer", displayName: "Dev" },
    ];
    expect(resolveUserLabels(w, "user_dev")).toEqual([
      "dev@pome-twin.test",
      "Developer",
      "Dev",
    ]);
  });

  it("returns no user labels for an unassigned issue", () => {
    expect(resolveUserLabels(world(), undefined)).toEqual([]);
    expect(resolveUserLabels(world(), "user_missing")).toEqual([]);
  });

  it("reports a truncated collection by name", () => {
    expect(
      isTruncated(world({ exportBounds: { truncatedCollections: ["comments"] } }), "comments"),
    ).toBe(true);
    expect(isTruncated(world(), "comments")).toBe(false);
    expect(isTruncated(world({ exportBounds: null }), "issues")).toBe(false);
  });
});

describe("the model tolerates a partial export rather than throwing", () => {
  it("survives an issue row missing every optional field", () => {
    const bare: LinearCheckStateIssue = { id: "i", teamId: "team_eng", title: "bare" };
    const w = world({ issues: [bare] });
    const r = resolveIssue(w, "ENG", "bare");
    expect("found" in r).toBe(true);
    // No stateId to follow, so the state join names itself rather than throwing.
    expect(resolveWorkflowStateName(w, bare)).toEqual({
      missing: "workflow_state_unresolved",
      skip: true,
      searched: "/workflowStates",
    });
    expect(resolveLabelNames(w, bare)).toEqual({ found: new Set(), path: "/labels" });
  });

  it("survives an entirely empty state object", () => {
    const r = resolveIssue({}, "ENG", "anything");
    expect("missing" in r && r.missing).toBe("state_incomplete");
  });
});
