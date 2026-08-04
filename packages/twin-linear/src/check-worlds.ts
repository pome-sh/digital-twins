// SPDX-License-Identifier: Apache-2.0
//
// The fixture worlds Linear's declarations name (F-1129).
//
// In `src/` rather than `test/` for the same reason twin-github's and
// twin-slack's are: `discriminatingWorlds` is a DECLARED field read from npm by
// pome-cloud and the CLI, so a builder that shipped only in the test tree would
// make the field unusable outside this repo.
//
// EVERY FAILING WORLD KEEPS ITS SELECTOR RESOLVABLE. Arm 3 of
// `probeDiscrimination` rejects a failing world whose `reason` matches the one
// an EMPTY world produces — measured on 11 of twin-github's 13 checks before
// that arm existed. So a world built by omitting the team or the issue fails
// through its selector rather than its assertion and is thrown out. Which is
// why `linearState` always fills teams, workflowStates and labels, and why the
// declarations move only the asserted value between their two worlds.
//
// The id derivations are shared rather than written twice. A fixture whose
// `stateId` did not match a row in the same world would skip
// `workflow_state_unresolved`, and a skip satisfies NEITHER arm — so a drifting
// literal would look like a broken check rather than a broken fixture.

import type { CheckSubstrate, CheckTapeEvent } from "@pome-sh/sdk/checks";
import type {
  LinearCheckState,
  LinearCheckStateComment,
  LinearCheckStateIssue,
} from "./check-state.js";

export const FIXTURE_TEAM_ID = "team_eng";
export const FIXTURE_TEAM_KEY = "ENG";

/** The one derivation, used by both the catalog and the rows that reference it. */
export function fixtureStateId(name: string): string {
  return `state_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

/** Ditto for labels. */
export function fixtureLabelId(name: string): string {
  return `label_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

/** Linear's default workflow, the five states `defaultSeedState()` seeds. */
export const FIXTURE_STATES = [
  { name: "Backlog", type: "backlog" },
  { name: "Todo", type: "unstarted" },
  { name: "In Progress", type: "started" },
  { name: "Done", type: "completed" },
  { name: "Canceled", type: "canceled" },
] as const;

export function finalWorld(final: LinearCheckState): CheckSubstrate<LinearCheckState> {
  return { seed: null, final, tape: null };
}

export function deltaWorld(
  seed: LinearCheckState,
  final: LinearCheckState,
): CheckSubstrate<LinearCheckState> {
  return { seed, final, tape: null };
}

export function tapeWorld(tape: readonly CheckTapeEvent[]): CheckSubstrate<LinearCheckState> {
  return { seed: null, final: { issues: [] }, tape };
}

/**
 * A one-team workspace with Linear's five default workflow states.
 *
 * `labelNames` is the workspace label CATALOG, not the labels on any issue —
 * `issueRow` attaches ids, and an id with no catalog row resolves to
 * `label_unresolved`, a skip. Pass every label the issues reference.
 */
export function linearState(
  issues: LinearCheckStateIssue[],
  comments: LinearCheckStateComment[] = [],
  labelNames: readonly string[] = ["Agent"],
): LinearCheckState {
  return {
    teams: [{ id: FIXTURE_TEAM_ID, key: FIXTURE_TEAM_KEY, name: "Engineering" }],
    workflowStates: FIXTURE_STATES.map((s) => ({
      id: fixtureStateId(s.name),
      teamId: FIXTURE_TEAM_ID,
      name: s.name,
      type: s.type,
    })),
    labels: labelNames.map((name) => ({
      id: fixtureLabelId(name),
      teamId: FIXTURE_TEAM_ID,
      name,
    })),
    issues,
    comments,
    users: [
      { id: "user_dev", email: "dev@pome-twin.test", name: "Developer", displayName: "Dev" },
    ],
    exportBounds: { truncatedCollections: [] },
  };
}

/** A resolvable issue row, with `stateId` and `labelIds` derived the way the export emits them. */
export function issueRow(
  title: string,
  over: {
    id?: string;
    stateName?: string;
    labelNames?: readonly string[];
    estimate?: number | null;
    assigneeId?: string;
  } = {},
): LinearCheckStateIssue {
  return {
    id: over.id ?? "issue_1",
    identifier: "ENG-1",
    number: 1,
    teamId: FIXTURE_TEAM_ID,
    title,
    stateId: fixtureStateId(over.stateName ?? "In Progress"),
    estimate: over.estimate ?? null,
    ...(over.assigneeId === undefined ? {} : { assigneeId: over.assigneeId }),
    archivedAt: null,
    labelIds: (over.labelNames ?? []).map(fixtureLabelId),
  };
}
