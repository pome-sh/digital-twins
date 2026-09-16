// SPDX-License-Identifier: Apache-2.0
//
// The state diff `pome twin tape --diff` prints (F-1837): what a twin's state
// looks like now against what it looked like when it booted, said per
// collection — `repositories[acme/api].issues: +1 added (#2 "Login…")` — so a
// reader sees what the agent's run left behind without reading two exports.
//
// Twin-agnostic on purpose. Every twin's `exportState()` is a tree of objects
// whose arrays are collections of rows (repositories, issues, channels,
// messages, customers, …). Rows are matched by the first identity field the
// collection carries (`id`, `number`, `full_name`, …), so a row that moved or
// re-sorted is not an add plus a remove, and a row whose scalar fields
// changed is "changed" while a row that only gained nested rows reports those
// under its own path. Nothing here knows a twin's schema; a twin that adds a
// collection tomorrow diffs the day it ships.
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

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCollection(value: unknown): value is Row[] {
  return Array.isArray(value) && value.length > 0 && value.every(isRow);
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

function label(row: Row, key: string | undefined, index: number): string {
  if (key === undefined) return `#${index}`;
  const value = String(row[key]);
  if (key === "number") return `#${value}`;
  return value;
}

/** A row with its nested collections stripped: what "changed" is judged on. */
function scalarsOf(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (isCollection(value) || (Array.isArray(value) && value.length === 0)) continue;
    out[key] = value;
  }
  return out;
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
  const beforeRows = isCollection(before) ? before : Array.isArray(before) ? [] : undefined;
  const afterRows = isCollection(after) ? after : Array.isArray(after) ? [] : undefined;
  if (beforeRows !== undefined || afterRows !== undefined) {
    if (beforeRows !== undefined && afterRows !== undefined) {
      diffCollection(beforeRows, afterRows, path, out);
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

function diffCollection(before: Row[], after: Row[], path: string, out: CollectionDiff[]): void {
  const key = identityKeyOf(before, after);
  const entry: CollectionDiff = { path: path || "(root)", added: [], changed: [], removed: [] };
  const byId = (rows: Row[]) =>
    new Map(rows.map((row, index) => [key === undefined ? String(index) : String(row[key]), { row, index }]));
  const beforeById = byId(before);
  const afterById = byId(after);
  const nested: Array<{ before: Row; after: Row; label: string }> = [];
  for (const [id, { row, index }] of afterById) {
    const prior = beforeById.get(id);
    if (prior === undefined) {
      entry.added.push(label(row, key, index));
    } else {
      const name = label(row, key, index);
      if (!sameScalars(prior.row, row)) entry.changed.push(name);
      nested.push({ before: prior.row, after: row, label: name });
    }
  }
  for (const [id, { row, index }] of beforeById) {
    if (!afterById.has(id)) entry.removed.push(label(row, key, index));
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
