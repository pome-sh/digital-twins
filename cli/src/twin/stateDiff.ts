// SPDX-License-Identifier: Apache-2.0
//
// The state diff `pome twin tape --diff` prints (F-1837): what a twin's state
// looks like now against what it looked like when it booted, said per
// collection — `repositories[acme/api].issues: +1 added (#2 "Login…")` — so a
// reader sees what the agent's run left behind without reading two exports.
//
// Twin-agnostic on purpose. Every twin's `exportState()` is a tree of objects
// whose arrays are collections of rows (repositories, issues, channels,
// messages, customers, …) or memberships of scalars (a channel's member ids).
// Rows are matched by the first identity field the collection carries
// (`full_name`, `number`, `name`, …), else by their scalar content (an
// association table has nothing but ids), so a row that moved or re-sorted is
// not an add plus a remove, and a row whose scalar fields changed is "changed"
// while a row that only gained nested rows reports those under its own path.
// Nothing here knows a twin's schema; a twin that adds a collection tomorrow
// diffs the day it ships.
//
// Pure — no I/O — so the unit test feeds it two trees and reads the entries.

/** The fields a collection row is identified by, in order of preference. */
// Human-readable names first: a diff line that says `#2` or `p0` is a screenshot,
// one that says `1438608116` is not. `id` is last, the fallback every row has.
const IDENTITY_KEYS = ["full_name", "number", "name", "login", "email", "path", "ts", "key", "id"];

export type CollectionDiff = {
  /** Dotted path with identities in brackets: `repositories[acme/api].issues`. */
  path: string;
  added: string[];
  changed: string[];
  removed: string[];
};

type Row = Record<string, unknown>;
type Primitive = string | number | boolean | null;

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is Primitive {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** An array of rows: a collection with identities. */
function isCollection(value: unknown): value is Row[] {
  return Array.isArray(value) && value.length > 0 && value.every(isRow);
}

/** An array of scalars: a membership (slack's channel `members`, label ids…). */
function isMembership(value: unknown): value is Primitive[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPrimitive);
}

/**
 * The identity key a collection's rows share, or `undefined` for index-keyed
 * rows. Uniqueness is judged within each side separately: a row present on
 * both sides carries the same identity twice across them, and that is the
 * match, not a collision.
 */
export function identityKeyOf(...sides: readonly (readonly Row[])[]): string | undefined {
  const rows = sides.flat();
  if (rows.length === 0) return undefined;
  for (const key of IDENTITY_KEYS) {
    if (!rows.every((row) => row[key] !== undefined && row[key] !== null)) continue;
    const unique = sides.every((side) => {
      const values = side.map((row) => String(row[key]));
      return new Set(values).size === values.length;
    });
    if (unique) return key;
  }
  return undefined;
}

function label(row: Row, key: string, _index: number): string {
  const value = String(row[key]);
  if (key === "number") return `#${value}`;
  return value;
}

/** A row with its nested collections and memberships stripped: what "changed" is judged on. */
function scalarsOf(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value) && (value.length === 0 || isCollection(value) || isMembership(value))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The label of a row that has no identity field: its scalar content, short.
 * Gmail's message↔label associations are such rows — three ids and nothing
 * else — and matching them by content is exact, where matching by index
 * turns one removal into "changed, changed, removed".
 */
function contentLabel(row: Row): string {
  const parts = Object.entries(scalarsOf(row))
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  const text = `{${parts.join(", ")}}`;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRow(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function sameScalars(a: Row, b: Row): boolean {
  return stableStringify(scalarsOf(a)) === stableStringify(scalarsOf(b));
}

/**
 * Diff two state exports. Entries come out in tree order, one per collection
 * that changed; a collection nothing touched is absent.
 */
export function diffState(before: unknown, after: unknown): CollectionDiff[] {
  const out: CollectionDiff[] = [];
  walk(before, after, "", out);
  return out;
}

function walk(before: unknown, after: unknown, path: string, out: CollectionDiff[]): void {
  if (Array.isArray(before) || Array.isArray(after)) {
    const b = Array.isArray(before) ? before : [];
    const a = Array.isArray(after) ? after : [];
    if (isMembership(b) || isMembership(a)) {
      if ((b.length === 0 || isMembership(b)) && (a.length === 0 || isMembership(a))) {
        diffMembership(b as Primitive[], a as Primitive[], path, out);
      }
      return;
    }
    if ((b.length === 0 || isCollection(b)) && (a.length === 0 || isCollection(a))) {
      diffCollection(b as Row[], a as Row[], path, out);
    }
    return;
  }
  if (isRow(before) && isRow(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      walk(before[key], after[key], path === "" ? key : `${path}.${key}`, out);
    }
  }
}

/** Scalars in, scalars out: added and removed by value, counted as a multiset. */
function diffMembership(before: Primitive[], after: Primitive[], path: string, out: CollectionDiff[]): void {
  const count = (values: Primitive[]) => {
    const map = new Map<string, number>();
    for (const value of values) map.set(String(value), (map.get(String(value)) ?? 0) + 1);
    return map;
  };
  const b = count(before);
  const a = count(after);
  const entry: CollectionDiff = { path: path || "(root)", added: [], changed: [], removed: [] };
  for (const [value, n] of a) for (let i = b.get(value) ?? 0; i < n; i += 1) entry.added.push(value);
  for (const [value, n] of b) for (let i = a.get(value) ?? 0; i < n; i += 1) entry.removed.push(value);
  if (entry.added.length || entry.removed.length) out.push(entry);
}

function diffCollection(before: Row[], after: Row[], path: string, out: CollectionDiff[]): void {
  const key = identityKeyOf(before, after);
  const entry: CollectionDiff = { path: path || "(root)", added: [], changed: [], removed: [] };
  // Rows with no identity field are matched by their scalar content (a
  // repeated identical row gets a counter, so a multiset still matches), and
  // labelled by it; a row whose content changed is a remove plus an add.
  const byId = (rows: Row[]) => {
    const seen = new Map<string, number>();
    return new Map(
      rows.map((row, index) => {
        let id = key === undefined ? stableStringify(scalarsOf(row)) : String(row[key]);
        if (key === undefined) {
          const n = seen.get(id) ?? 0;
          seen.set(id, n + 1);
          if (n > 0) id = `${id}#${n}`;
        }
        return [id, { row, index }] as const;
      }),
    );
  };
  const name = (row: Row, index: number) => (key === undefined ? contentLabel(row) : label(row, key, index));
  const beforeById = byId(before);
  const afterById = byId(after);
  const nested: Array<{ before: Row; after: Row; label: string }> = [];
  for (const [id, { row, index }] of afterById) {
    const prior = beforeById.get(id);
    if (prior === undefined) {
      entry.added.push(name(row, index));
    } else {
      const rowName = name(row, index);
      if (!sameScalars(prior.row, row)) entry.changed.push(rowName);
      nested.push({ before: prior.row, after: row, label: rowName });
    }
  }
  for (const [id, { row, index }] of beforeById) {
    if (!afterById.has(id)) entry.removed.push(name(row, index));
  }
  if (entry.added.length || entry.changed.length || entry.removed.length) out.push(entry);
  for (const pair of nested) {
    const keys = new Set([...Object.keys(pair.before), ...Object.keys(pair.after)]);
    for (const field of [...keys].sort()) {
      const b = pair.before[field];
      const a = pair.after[field];
      if (Array.isArray(b) || Array.isArray(a) || (isRow(b) && isRow(a))) {
        walk(b, a, `${path}[${pair.label}].${field}`, out);
      }
    }
  }
}

/** One human line per changed collection. */
export function renderStateDiff(entries: readonly CollectionDiff[]): string[] {
  if (entries.length === 0) return ["State: unchanged since boot."];
  const lines = ["State diff since boot (seed → now):"];
  const width = Math.max(...entries.map((entry) => entry.path.length));
  for (const entry of entries) {
    const parts: string[] = [];
    if (entry.added.length) parts.push(`+${entry.added.length} added: ${entry.added.join(", ")}`);
    if (entry.changed.length) parts.push(`~${entry.changed.length} changed: ${entry.changed.join(", ")}`);
    if (entry.removed.length) parts.push(`-${entry.removed.length} removed: ${entry.removed.join(", ")}`);
    lines.push(`  ${entry.path.padEnd(width)}  ${parts.join("; ")}`);
  }
  return lines;
}
