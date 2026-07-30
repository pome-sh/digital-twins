// SPDX-License-Identifier: Apache-2.0
//
// How a declared check READS the exported Linear workspace (F-1129).
//
// `LinearStateExport` (`state.ts:4-27`) names the collections but types every
// row `unknown[]`, so the row shapes still have to be modelled by hand here, as
// twin-slack's `check-state.ts` does. Every field is optional and every list
// nullable: an older snapshot, a partial upload, or a schema that gained a
// column all arrive as absent fields. A predicate that assumes presence throws
// inside the evaluator; one that reads this model returns a NAMED verdict. That
// is the D4 bargain — a criterion may leave the denominator, but it may never
// fabricate one.
//
// Five shapes are counter-intuitive and each has a wrong-verdict story:
//
//   1. AN ISSUE HAS NO STATE STRING. `issue.stateId` references a
//      `workflowStates` row, and workflow states are scoped by `teamId` — so a
//      join that is not team-scoped resolves the wrong row in a two-team world.
//   2. LABELS ARE A THIRD SHAPE. The SEED writes label names; twin-github's
//      export writes label objects; this export writes `issue.labelIds:
//      string[]`, which must be joined to `labels[].name`. One concept, three
//      shapes, and only this one is exported.
//   3. `archivedAt` IS EXPORTED. An archived issue is still a row in `issues`.
//      Resolution treats archived as absent, so an existence assertion cannot
//      be satisfied by an issue the examinee archived.
//   4. `exportBounds.truncatedCollections` NAMES WHAT WAS CAPPED.
//      `STATE_EXPORT_CAP = 2000` (`types.ts:394`) drops rows past the cap, and
//      this is the ONLY place in the vocabulary where "not found" and "absent"
//      are different facts. Neither GitHubCheckState nor SlackCheckState
//      carries an analogue, which is why this contract is Linear's alone.
//   5. TITLE UNIQUENESS IS SEED-TIME ONLY. `seed.ts:319-325` validates
//      `issueTitlesByTeam` at parse; nothing enforces it at runtime, so an
//      examinee can create a duplicate. Two matches FAIL naming the count —
//      silently grading the first is the wrong-match hazard twin-github's repo
//      rule exists to close, one level down.
//
// REASON STRINGS NEVER ECHO A TITLE. Only a check's declared `subject` is
// guaranteed to have survived the redaction pipeline by the time `evaluate`
// runs (`evaluate.ts:141-144`), and `title` is a selector on every check except
// `linear.issue-exists`. The team key is safe to quote: `[A-Z][A-Z0-9]*`
// matches no pattern in either redactor.

import type { CheckOutcome } from "@pome-sh/sdk/checks";

export interface LinearCheckStateTeam {
  id?: string;
  key?: string;
  name?: string;
}

export interface LinearCheckStateWorkflowState {
  id?: string;
  teamId?: string;
  name?: string;
  type?: string;
}

export interface LinearCheckStateLabel {
  id?: string;
  teamId?: string;
  name?: string;
}

export interface LinearCheckStateIssue {
  id?: string;
  identifier?: string;
  number?: number;
  teamId?: string;
  title?: string;
  estimate?: number | null;
  // An id, never a state name. See trap 1.
  stateId?: string;
  assigneeId?: string;
  // Exported, and non-null means the issue is archived. See trap 3.
  archivedAt?: string | null;
  // Ids, never names or row objects. See trap 2.
  labelIds?: string[];
}

export interface LinearCheckStateComment {
  id?: string;
  issueId?: string;
  parentId?: string | null;
  userId?: string;
  body?: string;
}

export interface LinearCheckStateUser {
  id?: string;
  email?: string;
  name?: string;
  displayName?: string;
}

export interface LinearCheckState {
  teams?: LinearCheckStateTeam[] | null;
  workflowStates?: LinearCheckStateWorkflowState[] | null;
  labels?: LinearCheckStateLabel[] | null;
  issues?: LinearCheckStateIssue[] | null;
  comments?: LinearCheckStateComment[] | null;
  users?: LinearCheckStateUser[] | null;
  exportBounds?: { truncatedCollections?: string[] } | null;
}

/**
 * twin-github's `Resolved<T>` with one field added.
 *
 * github's resolvers always FAIL on a miss and twin-slack's always SKIP. Linear
 * needs both from the same resolver, because a miss inside a truncated
 * collection is evidence of a partial export while a miss in a complete one is
 * evidence about the examinee. Carrying the disposition on the value is what
 * stops every call site from re-deciding it — and re-deciding it wrongly is how
 * a do-nothing agent scores 100% on task 26.
 */
export type Resolved<T> = { found: T } | { missing: string; skip: boolean };

/** The one place an unresolved selector becomes an outcome. */
export function unresolved(r: { missing: string; skip: boolean }): CheckOutcome {
  return r.skip
    ? { passed: false, status: "skipped", reason: r.missing }
    : { passed: false, reason: r.missing };
}

export function isTruncated(state: LinearCheckState, collection: string): boolean {
  return (state.exportBounds?.truncatedCollections ?? []).includes(collection);
}

/**
 * The issue an assertion is about, by exact title, scoped to one team.
 *
 * Exact rather than case-insensitive: the task names the title it seeded or
 * asked for, and a case-folding match would let an examinee half-comply.
 */
export function resolveIssue(
  state: LinearCheckState,
  teamKey: string,
  title: string,
): Resolved<LinearCheckStateIssue> {
  if (state.teams == null) return { missing: "state_incomplete", skip: true };
  const team = state.teams.find((t) => t.key === teamKey);
  if (team?.id == null) {
    return { missing: `team \`${teamKey}\` not found in state_final`, skip: false };
  }
  if (state.issues == null) return { missing: "state_incomplete", skip: true };

  const matches = state.issues.filter(
    (issue) =>
      issue.teamId === team.id &&
      issue.title === title &&
      (issue.archivedAt ?? null) === null,
  );
  if (matches.length === 1) return { found: matches[0]! };
  if (matches.length > 1) {
    return {
      missing: `${matches.length} issues in \`${teamKey}\` share that title`,
      skip: false,
    };
  }
  // The only skip a miss can earn, and it is earned by evidence rather than by
  // taste: the twin itself reported that `issues` lost rows to the export cap.
  if (isTruncated(state, "issues")) return { missing: "state_truncated", skip: true };
  return { missing: `no issue with that title in \`${teamKey}\``, skip: false };
}

/** Trap 1: `stateId` → the team's own workflow-state row. */
export function resolveWorkflowStateName(
  state: LinearCheckState,
  issue: LinearCheckStateIssue,
): Resolved<string> {
  if (state.workflowStates == null) return { missing: "state_incomplete", skip: true };
  const row = state.workflowStates.find(
    (s) => s.id === issue.stateId && s.teamId === issue.teamId,
  );
  if (row?.name == null) return { missing: "workflow_state_unresolved", skip: true };
  return { found: row.name };
}

/**
 * Trap 2: `labelIds` → catalog names, lowercased.
 *
 * Case-insensitive because the legacy rule's `eqi` was, and because a label an
 * examinee creates is prose it retyped.
 */
export function resolveLabelNames(
  state: LinearCheckState,
  issue: LinearCheckStateIssue,
): Resolved<Set<string>> {
  if (state.labels == null) return { missing: "state_incomplete", skip: true };
  const byId = new Map(
    state.labels.filter((l) => l.id != null).map((l) => [l.id!, (l.name ?? "").toLowerCase()]),
  );
  const names = new Set<string>();
  for (const id of issue.labelIds ?? []) {
    const name = byId.get(id);
    // A link to a label the export did not carry is a partial export, not a
    // verdict about the examinee.
    if (name === undefined) return { missing: "label_unresolved", skip: true };
    names.add(name);
  }
  return { found: names };
}

export function resolveComments(
  state: LinearCheckState,
  issue: LinearCheckStateIssue,
): Resolved<LinearCheckStateComment[]> {
  if (state.comments == null) return { missing: "state_incomplete", skip: true };
  return { found: state.comments.filter((c) => c.issueId === issue.id) };
}

/**
 * Every spelling of a user the legacy `linear.issue-assignee` rule accepted —
 * email, name, displayName — in that order, so a reason string names the most
 * specific one first.
 */
export function resolveUserLabels(
  state: LinearCheckState,
  id: string | undefined,
): string[] {
  if (id == null || state.users == null) return [];
  const user = state.users.find((u) => u.id === id);
  if (user == null) return [];
  return [user.email, user.name, user.displayName].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}
