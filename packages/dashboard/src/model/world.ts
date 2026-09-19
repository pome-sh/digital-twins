// SPDX-License-Identifier: Apache-2.0
//
// Turning the census into a panel a person reads.
//
// `censusState` keys collections by their full path so nothing double-counts —
// `repositories[acme/api].labels` and `repositories[acme/api].issues[#1].labels`
// are two rows, not one. That precision is for the machine. The panel needs two
// things on top of it: a name a person would say, and a decision about which of
// the eleven collections a seeded GitHub twin exports are worth a line.
import type { WorldCollection } from "../api.js";

/** `repositories[acme/api].issues` → `acme/api issues`; `repositories` → `repositories`. */
export function collectionLabel(path: string): string {
  const leaf = path.split(".").pop() ?? path;
  const identities = [...path.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1] ?? "");
  const owner = identities.at(-1);
  return owner === undefined || owner.length === 0 ? leaf : `${owner} ${leaf}`;
}

/** Did anything land in this collection since boot? */
export function hasMoved(entry: WorldCollection): boolean {
  return entry.added.length > 0 || entry.changed.length > 0 || entry.removed.length > 0;
}

/** How deeply nested a collection is: one bracket per enclosing row. */
export function depthOf(path: string): number {
  return [...path.matchAll(/\[[^\]]*\]/g)].length;
}

/**
 * How many rows the panel will show at most.
 *
 * A budget rather than a depth rule, because the five twins are not the same
 * SHAPE. GitHub's state is a tree, so "unchanged, and shallow" filtered it well.
 * Gmail exports 13 flat arrays and Linear 11 — every one of them at depth zero —
 * so a depth rule filtered nothing and the panel ran to eighteen rows. A budget
 * is the one rule that behaves the same on both.
 */
const ROW_BUDGET = 8;

/** The deepest an UNCHANGED collection may sit and still be shown as context. */
const CONTEXT_DEPTH = 1;

export type WorldView = {
  rows: WorldCollection[];
  /**
   * Collections the twin exports that this panel is not showing: they are
   * empty and nothing has touched them. Counted rather than dropped in
   * silence — the same rule the detail panel follows for folded fields.
   */
  hidden: number;
};

/**
 * Which collections earn a line.
 *
 *   moved                    always, at any depth and at any size. This is what
 *                            the panel is for, and a count that fell to zero has
 *                            to stay on screen or a deletion reads as a bug in
 *                            the page rather than as a deletion in the twin.
 *   context                  the rest of the budget, filled shallowest-first and
 *                            then largest-first, skipping empties and join
 *                            tables. These are what make a change legible.
 *   everything else          hidden, and counted.
 *
 * Measured on all five twins: a freshly seeded GitHub shows six of eleven,
 * Slack four of thirteen, Stripe two of ten, Gmail eight of twenty-eight,
 * Linear eight of twenty-four. Before the budget, Gmail showed fourteen and
 * Linear eighteen — a depth rule cannot filter a flat export, and those two are
 * flat.
 */
export function worldView(world: readonly WorldCollection[]): WorldView {
  const moved = world.filter(hasMoved);
  const holding = world
    .filter(
      (entry) =>
        !hasMoved(entry) &&
        entry.now > 0 &&
        // A join table is real state and never the thing being looked at. It
        // does not get to take a slot from a collection of rows.
        entry.kind === "collection" &&
        // Context is shallow. `#1 labels 1` — one issue's own labels — is a
        // fact about a row, not about the world; it earns a line only by
        // moving, like anything else that deep.
        depthOf(entry.path) <= CONTEXT_DEPTH,
    )
    // Shallowest first, then largest: `issues 4` says more about a twin than
    // `oauthApps 1`, and a top-level collection says more than one nested
    // inside a single row.
    .sort((a, b) => depthOf(a.path) - depthOf(b.path) || b.now - a.now);

  // A world that holds no rows at all — Stripe boots with ten empty
  // collections — is described by what it models. Without this its panel is an
  // empty table, which reads as a broken page rather than a new account.
  const context = (
    holding.length > 0
      ? holding
      : world.filter((entry) => !hasMoved(entry) && entry.kind === "collection" && depthOf(entry.path) === 0)
  ).slice(0, Math.max(0, ROW_BUDGET - moved.length));

  // Back into the census's own order, so the panel reads top-down like the
  // state does rather than in the order this function happened to pick.
  const keep = new Set([...moved, ...context].map((entry) => entry.path));
  const rows = world.filter((entry) => keep.has(entry.path));
  return { rows, hidden: world.length - rows.length };
}

/**
 * The one line under a moved collection: what arrived, named the way the diff
 * names it. Additions read first because they are the common case and the one a
 * viewer is usually waiting for; a removal is the one they most need to see.
 */
export function arrivalOf(entry: WorldCollection): { id: string; what: string } | null {
  const removed = entry.removed.at(-1);
  if (removed !== undefined) return { id: removed, what: "removed" };
  const added = entry.added.at(-1);
  if (added !== undefined) return { id: added, what: "added" };
  const changed = entry.changed.at(-1);
  if (changed !== undefined) return { id: changed, what: "changed" };
  return null;
}
