// SPDX-License-Identifier: Apache-2.0
//
// The world panel's two decisions: what a collection is called, and which ones
// earn a line.
//
// The fixture below is the census a freshly seeded GitHub twin really produces
// — captured from `GET /_pome/state` on `pome twin start github`, not invented.
// It is the shape the panel has to be good at, and the reason the filter exists
// at all: eleven collections, of which six say nothing.
import { describe, expect, it } from "vitest";
import type { WorldCollection } from "../src/api.js";
import { arrivalOf, collectionLabel, depthOf, hasMoved, worldView } from "../src/model/world.js";

const still = (path: string, count: number): WorldCollection => ({
  path,
  boot: count,
  now: count,
  kind: "collection",
  added: [],
  changed: [],
  removed: [],
});

const member = (path: string, count: number): WorldCollection => ({
  ...still(path, count),
  kind: "membership",
});

/** The GitHub twin's default seed, after the agent opened #2 and added `p0`. */
const SEEDED: WorldCollection[] = [
  { ...still("repositories", 1), changed: ["acme/api"] },
  still("repositories[acme/api].branches", 1),
  still("repositories[acme/api].check_runs", 0),
  still("repositories[acme/api].commit_statuses", 0),
  still("repositories[acme/api].files", 2),
  {
    path: "repositories[acme/api].issues",
    boot: 1,
    now: 2,
    kind: "collection",
    added: ["#2"],
    changed: [],
    removed: [],
  },
  still("repositories[acme/api].issues[#1].assignees", 0),
  still("repositories[acme/api].issues[#1].comments", 0),
  still("repositories[acme/api].issues[#1].labels", 1),
  {
    path: "repositories[acme/api].labels",
    boot: 3,
    now: 4,
    kind: "collection",
    added: ["p0"],
    changed: [],
    removed: [],
  },
  still("repositories[acme/api].pull_requests", 0),
];

describe("which collections earn a line", () => {
  it("keeps what moved and fills the rest of the budget with context", () => {
    const { rows, hidden } = worldView(SEEDED);

    expect(rows.map((row) => collectionLabel(row.path))).toEqual([
      "repositories",
      "acme/api branches",
      "acme/api files",
      "acme/api issues",
      "acme/api labels",
    ]);
    // Three all-zero collections the seed never filled, and three nested inside
    // issue #1 — a fact about one row, not about the world.
    expect(hidden).toBe(6);
  });

  it("describes an empty world by what it models, rather than showing an empty table", () => {
    // The Stripe twin's real boot census: ten collections, every one empty.
    const stripe = [
      "balance_transactions", "charges", "customers", "events", "payment_intents",
      "payment_methods", "prices", "products", "refunds", "subscriptions",
    ].map((path) => still(path, 0));
    const empty = worldView(stripe);
    expect(empty.rows).toHaveLength(8);
    expect(empty.hidden).toBe(2);

    // After the first write, what moved leads and the empty ones still frame it,
    // so the panel does not collapse from eight rows to two at the first beat.
    const afterWrite = stripe.map((row) =>
      row.path === "customers" ? { ...row, now: 1, added: ["cus_1"] } : row,
    );
    const { rows } = worldView(afterWrite);
    expect(rows).toHaveLength(8);
    expect(rows.map((row) => row.path)).toContain("customers");
  });

  it("never lets a join table take a slot from a collection of rows", () => {
    // Linear exports `issues[#n].labelIds` per issue and Gmail `messages[x].to`.
    // Give them the whole budget and they would bury `issues` itself.
    const world = [
      still("issues", 4),
      ...Array.from({ length: 12 }, (_, i) => member(`issues[#${i}].labelIds`, 2)),
    ];
    const { rows, hidden } = worldView(world);
    expect(rows.map((row) => row.path)).toEqual(["issues"]);
    expect(hidden).toBe(12);
  });

  it("caps a flat export at the budget rather than listing all of it", () => {
    // Gmail's shape: everything at depth zero, nothing nested to filter on.
    const flat = Array.from({ length: 20 }, (_, i) => still(`c${String(i).padStart(2, "0")}`, 20 - i));
    const { rows, hidden } = worldView(flat);
    expect(rows).toHaveLength(8);
    // Largest first at equal depth: the biggest collections say the most about
    // whether this twin holds a real world.
    expect(rows.map((row) => row.path)).toEqual([
      "c00", "c01", "c02", "c03", "c04", "c05", "c06", "c07",
    ]);
    expect(hidden).toBe(12);
  });

  it("shows everything that moved even past the budget", () => {
    const moved = Array.from({ length: 12 }, (_, i) => ({
      ...still(`m${i}`, 1),
      added: ["x"],
    }));
    expect(worldView(moved).rows).toHaveLength(12);
  });

  it("shows a collection emptied to zero, because a deletion is the point", () => {
    const emptied: WorldCollection = {
      path: "repositories[acme/api].issues",
      boot: 1,
      now: 0,
      kind: "collection",
      added: [],
      changed: [],
      removed: ["#1"],
    };
    const { rows, hidden } = worldView([emptied]);
    expect(rows).toEqual([emptied]);
    expect(hidden).toBe(0);
    // A row that vanished when its count hit zero would read as a bug in the
    // page rather than as a deletion in the twin.
    expect(rows[0]?.now).toBe(0);
  });

  it("shows a deep collection the moment something lands in it", () => {
    const deep: WorldCollection = {
      path: "repositories[acme/api].issues[#1].comments",
      boot: 0,
      now: 1,
      kind: "collection",
      added: ["looking into it"],
      changed: [],
      removed: [],
    };
    expect(worldView([deep]).rows).toEqual([deep]);
  });

  it("hides nothing when every collection carries something", () => {
    const { rows, hidden } = worldView([still("repositories", 1)]);
    expect(rows).toHaveLength(1);
    expect(hidden).toBe(0);
  });
});

describe("naming a collection", () => {
  it("says the nearest identity and the collection, the way a person would", () => {
    expect(collectionLabel("repositories")).toBe("repositories");
    expect(collectionLabel("repositories[acme/api].issues")).toBe("acme/api issues");
    expect(collectionLabel("repositories[acme/api].issues[#1].labels")).toBe("#1 labels");
  });

  it("counts a bracket per enclosing row", () => {
    expect(depthOf("repositories")).toBe(0);
    expect(depthOf("repositories[acme/api].issues")).toBe(1);
    expect(depthOf("repositories[acme/api].issues[#1].labels")).toBe(2);
  });
});

describe("what a moved collection says underneath itself", () => {
  it("leads with a removal, because that is the one a viewer most needs to see", () => {
    const entry: WorldCollection = {
      path: "x",
      boot: 2,
      now: 2,
      kind: "collection",
      added: ["b"],
      changed: ["c"],
      removed: ["a"],
    };
    expect(arrivalOf(entry)).toEqual({ id: "a", what: "removed" });
  });

  it("falls through addition to change, and says nothing when nothing moved", () => {
    expect(arrivalOf({ ...still("x", 1), boot: 0, added: ["#2"] })).toEqual(
      { id: "#2", what: "added" },
    );
    expect(arrivalOf({ ...still("x", 1), changed: ["#1"] })).toEqual(
      { id: "#1", what: "changed" },
    );
    expect(arrivalOf(still("x", 1))).toBeNull();
    expect(hasMoved(still("x", 1))).toBe(false);
  });
});
