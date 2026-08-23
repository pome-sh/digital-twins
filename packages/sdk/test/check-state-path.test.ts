// Properties of the pointer GRAMMAR (`CheckOutcome.evidenceStatePaths`), not of
// any twin's vocabulary — the per-twin gate lives in each `checks-contract`.

import { describe, expect, it } from "vitest";
import { childStatePath, resolveStatePath, statePath } from "../src/check-state-path.js";

describe("statePath", () => {
  it("builds a pointer from object keys and array indices", () => {
    expect(statePath("repositories", 0, "issues", 2, "labels")).toBe(
      "/repositories/0/issues/2/labels",
    );
  });

  it("returns the whole-document pointer for no segments", () => {
    // Legal RFC 6901, and deliberately useless as a citation: a check with
    // nothing narrower to name must omit the field rather than cite the root.
    expect(statePath()).toBe("");
  });

  it("escapes `/` and `~` in a segment, `~` first", () => {
    // The ordering is the whole reason `escapeSegment` exists as a named
    // function. Encoding `/` first would turn this key into `a~1b` and then into
    // `a~01b`, which decodes to the literal `a~1b` — a different key.
    expect(statePath("a/b")).toBe("/a~1b");
    expect(statePath("a~b")).toBe("/a~0b");
    expect(statePath("a~/b")).toBe("/a~0~1b");
  });

  it("round-trips a segment that contains both escapes", () => {
    const key = "acme/api~v2";
    const tree = { [key]: "found" };
    expect(resolveStatePath(tree, statePath(key))).toEqual({ value: "found" });
  });
});

describe("childStatePath", () => {
  it("appends to a pointer a resolver already built", () => {
    const repo = statePath("repositories", 0);
    expect(childStatePath(repo, "issues", 1, "labels")).toBe("/repositories/0/issues/1/labels");
  });

  it("escapes only the appended segments, never the base", () => {
    // The base already contains real `/` separators. Escaping it again is the
    // bug this function exists to make unwritable.
    const base = statePath("teams", "acme/api");
    expect(base).toBe("/teams/acme~1api");
    expect(childStatePath(base, "x/y")).toBe("/teams/acme~1api/x~1y");
  });
});

describe("resolveStatePath", () => {
  const tree = {
    repositories: [
      {
        full_name: "acme/api",
        issues: [{ number: 1, labels: [{ name: "bug" }] }, { number: 2, labels: [] }],
        files: null,
      },
    ],
    "": "empty key is legal",
  };

  it("resolves a pointer into nested arrays and objects", () => {
    expect(resolveStatePath(tree, "/repositories/0/issues/0/labels/0/name")).toEqual({
      value: "bug",
    });
  });

  it("resolves the whole document for the empty pointer", () => {
    expect(resolveStatePath(tree, "")).toEqual({ value: tree });
  });

  it("resolves a field that exists and is empty", () => {
    // An empty applied-label set IS the evidence behind a failing
    // `issue-has-label`. Collapsing it to "unresolvable" would hide the very
    // thing the reader came to see.
    expect(resolveStatePath(tree, "/repositories/0/issues/1/labels")).toEqual({ value: [] });
  });

  it("resolves a field holding null, and reports it as a value rather than a miss", () => {
    // This is why the return is wrapped. A bare return could not tell a field
    // holding `null` from a path that addresses nothing.
    expect(resolveStatePath(tree, "/repositories/0/files")).toEqual({ value: null });
  });

  it("resolves the empty-string key, so a trailing slash is not trimmed", () => {
    expect(resolveStatePath(tree, "/")).toEqual({ value: "empty key is legal" });
  });

  it("returns null for a missing key", () => {
    expect(resolveStatePath(tree, "/repositories/0/milestones")).toBeNull();
  });

  it("returns null for an out-of-range array index", () => {
    expect(resolveStatePath(tree, "/repositories/1")).toBeNull();
    expect(resolveStatePath(tree, "/repositories/0/issues/9/number")).toBeNull();
  });

  it("returns null for a non-index segment against an array", () => {
    expect(resolveStatePath(tree, "/repositories/first")).toBeNull();
    expect(resolveStatePath(tree, "/repositories/01")).toBeNull();
    expect(resolveStatePath(tree, "/repositories/-1")).toBeNull();
    expect(resolveStatePath(tree, "/repositories/ 0")).toBeNull();
    expect(resolveStatePath(tree, "/repositories/1e0")).toBeNull();
  });

  it("returns null when the pointer walks THROUGH a scalar", () => {
    expect(resolveStatePath(tree, "/repositories/0/full_name/0")).toBeNull();
  });

  it("returns null when the pointer walks through a null", () => {
    // `typeof null === "object"`, so this is the case a bare typeof guard misses.
    expect(resolveStatePath(tree, "/repositories/0/files/0")).toBeNull();
  });

  it("returns null for a pointer that does not begin with a slash", () => {
    // Not a pointer. Prefixing one for the caller would resolve a string nobody
    // wrote — the fuzzy match this grammar was chosen to rule out.
    expect(resolveStatePath(tree, "repositories/0")).toBeNull();
  });

  it("does not resolve through the prototype chain", () => {
    // Otherwise `/constructor` resolves on every tree and hands a consumer a
    // function to render as evidence.
    expect(resolveStatePath(tree, "/constructor")).toBeNull();
    expect(resolveStatePath(tree, "/toString")).toBeNull();
    expect(resolveStatePath(tree, "/__proto__")).toBeNull();
  });

  it("returns null for any pointer into a non-object tree", () => {
    expect(resolveStatePath(null, "/repositories")).toBeNull();
    expect(resolveStatePath("a string", "/0")).toBeNull();
    expect(resolveStatePath(undefined, "/x")).toBeNull();
  });
});
