// SPDX-License-Identifier: Apache-2.0
//
// `(schema, fixture)` — the two halves of "a seed field survives its schema".
//
//   leavesOf(fixture)        every scalar leaf the author WROTE, by path
//   leafFieldsOf(schema)     every leaf-bearing field the schema DECLARES, by
//                            generic path (array indices collapsed to `[]`)
//
// A guard built from these asserts two things that a `toEqual` cannot:
//
//   PRESERVATION  every leaf in the fixture is present and JSON-equal after
//                 `.parse()`. Not deep-equal, because zod ADDS defaulted keys
//                 and LEAVES absent optionals absent, so a deep-equal comparison
//                 false-fails on a schema that is behaving correctly.
//
//   COVERAGE      every leaf-bearing field the schema declares has a fixture
//                 leaf under it. Without this the preservation assert is
//                 vacuous in exactly the direction that matters: a fixture
//                 missing a field cannot notice the field being dropped, and a
//                 NEW schema field could land uncovered forever.
//
// The pair is what makes "no hand-written copy of a seed shape is compared to
// nothing" (F-581) a property rather than a review habit, and F-584 reuses it
// for stripe and slack.

import type { $ZodType } from "zod/v4/core";

type Def = { type?: string; [k: string]: unknown };

/** Unwrap `.optional()` / `.default()` / `.nullable()` / `.prefault()` / pipes
 *  down to the node that carries a shape. */
function unwrap(schema: unknown): Def | undefined {
  let node = schema as { _zod?: { def?: Record<string, unknown> } } | undefined;
  for (let depth = 0; depth < 50; depth++) {
    const def = node?._zod?.def;
    if (!def) return undefined;
    if (def.innerType) {
      node = def.innerType as typeof node;
      continue;
    }
    if (def.type === "pipe") {
      // A pipe is `.transform()` (in: the real schema, out: the transform) or
      // `z.preprocess()` (in: the transform, out: the real schema). Take
      // whichever SIDE is not the transform — that is the side carrying the
      // shape an author writes and a walker can read. Taking `out`
      // unconditionally dropped `failure_injection[].method`
      // (`z.string().transform(toUpperCase)`) from the declared field set
      // entirely, which is a field silently uncovered by the coverage half.
      const out = (def.out as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def;
      node = (out && out.type !== "transform" ? def.out : def.in) as typeof node;
      if (node) continue;
      return def as Def;
    }
    return def as Def;
  }
  return undefined;
}

/** A path segment list rendered the way both halves render it. */
const render = (path: string[]) => path.join(".");

/** Array indices collapsed, so a fixture path and a schema path compare. */
export const generic = (path: string) => path.replace(/\[\d+\]/g, "[]");

/**
 * Every scalar leaf in a value, by path. `null` counts — it is a value an
 * author can write and a schema can lose. An EMPTY array or object is a leaf
 * too, so that "the author wrote `[]` and got `[]`" is asserted rather than
 * skipped; it just never satisfies coverage, which is why the fixtures are
 * required to be non-empty.
 */
export function leavesOf(value: unknown, path: string[] = []): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ path: render(path), value }];
    return value.flatMap((item, i) => leavesOf(item, [...path, `[${i}]`]));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [{ path: render(path), value }];
    return entries.flatMap(([key, child]) => leavesOf(child, [...path, key]));
  }
  return [{ path: render(path), value }];
}

/** Resolve a `leavesOf` path against a parsed value. `undefined` means the
 *  field did not survive — dropped, renamed, or moved. */
export function at(value: unknown, path: string): unknown {
  if (path === "") return value;
  let cursor: unknown = value;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    const index = segment.match(/^\[(\d+)\]$/);
    cursor = index
      ? (cursor as unknown[])[Number(index[1])]
      : (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

const SCALAR_TYPES = new Set([
  "string",
  "number",
  "bigint",
  "boolean",
  "date",
  "enum",
  "literal",
  "unknown",
  "any",
  "null",
  "undefined",
  "void",
  "never",
  "nan",
  "symbol",
  "file",
  "record",
  "map",
  "set",
  "tuple",
]);

/**
 * Every leaf-bearing field a schema declares, by generic path.
 *
 * A field is leaf-bearing when it bottoms out in a value an author writes: a
 * scalar, an array of scalars, or a record/tuple whose interior this walk does
 * not model. Objects and arrays-of-objects are recursed into instead, so the
 * result names the fields a fixture has to carry — never the containers.
 */
export function leafFieldsOf(schema: $ZodType, path: string[] = [], seen = new Set<unknown>()): string[] {
  const def = unwrap(schema);
  if (!def) return [];
  if (def.type === "object") {
    // A recursive schema would spin here; a repeated shape is already covered.
    if (seen.has(def)) return [];
    seen.add(def);
    return Object.entries(def.shape as Record<string, unknown>).flatMap(([key, child]) =>
      leafFieldsOf(child as $ZodType, [...path, key], seen),
    );
  }
  if (def.type === "array") return leafFieldsOf(def.element as $ZodType, [...path, "[]"], seen);
  if (def.type === "union") {
    const options = def.options as $ZodType[];
    // A union with a scalar arm is a field an author writes directly; only a
    // union of pure objects is worth recursing into.
    if (options.some((option) => SCALAR_TYPES.has(unwrap(option)?.type ?? ""))) {
      return [render(path)];
    }
    return options.flatMap((option) => leafFieldsOf(option, path, seen));
  }
  if (SCALAR_TYPES.has(def.type ?? "")) return [render(path)];
  return [];
}

/** The generic paths a fixture actually reaches with a NON-empty value.
 *  Empty arrays/objects are excluded on purpose: `labels: []` covers nothing. */
export function coveredBy(fixture: unknown): Set<string> {
  const covered = new Set<string>();
  for (const leaf of leavesOf(fixture)) {
    const isEmptyContainer =
      (Array.isArray(leaf.value) && leaf.value.length === 0) ||
      (leaf.value !== null && typeof leaf.value === "object" && Object.keys(leaf.value).length === 0);
    if (isEmptyContainer) continue;
    covered.add(generic(leaf.path));
  }
  return covered;
}

/** Is this declared field reached by the fixture? A `z.record` / `z.unknown()`
 *  field is a schema leaf whose fixture value has leaves BELOW it
 *  (`metadata.order_id` under the declared `metadata`), so a prefix match is the
 *  honest test — an exact one would report every open-shaped field uncovered. */
export function covers(covered: Set<string>, field: string): boolean {
  if (covered.has(field)) return true;
  const prefix = `${field}.`;
  for (const path of covered) if (path.startsWith(prefix)) return true;
  return false;
}
