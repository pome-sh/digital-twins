// SPDX-License-Identifier: Apache-2.0
//
// What a detail panel says about one request (F-1850 · D3 amendment).
//
// A twin reports a mutation as `{before, after}`, and there are three kinds:
//
//   insert  before is null            every field arrived with the row
//   update  both sides present        a FEW fields moved, the rest sat still
//   delete  after is null             the row left, and its fields with it
//
// Telling them apart is not a nicety. A `PATCH /issues/2` that closes an issue
// reports twelve fields on both sides, of which three changed — rendering all
// twelve with a `+` would claim the twin just added a title it never touched.
// The panel must never imply a change it cannot show, which is the same rule
// that makes the fold below carry its own count.
//
// Then, of the fields that DID move or arrive, which lead and which fold. The
// rule is derived from the data rather than a per-twin list, so a twin that
// adds a field tomorrow folds it the day it ships:
//
//   fold  a field that did not move   on an update, that is most of them
//   fold  an empty value              `body: ""`, `labels: []`, `closed_at: null`
//   fold  a timestamp                 any `*_at` or `*At` key
//   fold  the parent echo             a value the world panel already shows as a
//                                     bracket identity (`repo: "acme/api"` when
//                                     the world lists `repositories[acme/api]`)
//   lead  everything else             identity first, then source order
//
// Checked against what the GitHub twin really emits. A created issue leads with
// `number, title, state, user_login`; a created label leads with `name, color`;
// closing an issue leads with exactly one line, `state  open → closed`.
//
// Pure, DOM-free, unit-tested on recorded deltas.
import type { StateDelta } from "../api.js";

/**
 * The fields a collection row is identified by, in order of preference.
 *
 * Kept byte-identical to `cli/src/twin/stateDiff.ts`'s list ON PURPOSE: the
 * detail panel and the world panel must agree about what names a row, or the
 * card says `#2` while the diff line says `1438608116`. It is duplicated rather
 * than imported because that module is CLI-internal and this one runs in a
 * browser; `packages/dashboard/test/fields.test.ts` asserts the two lists match,
 * so the copy cannot drift in silence.
 */
export const IDENTITY_KEYS = [
  "full_name",
  "number",
  "name",
  "login",
  "email",
  "path",
  "ts",
  "key",
  "id",
] as const;

/**
 * `+` arrived, `−` left, `~` moved from one value to another, `·` sat still.
 *
 * The fourth one is the reason this type exists. On an update most fields are
 * unchanged, and drawing them with a `+` — even folded away — tells the reader
 * the twin added a title it never touched.
 */
export type FieldMark = "+" | "−" | "~" | "·";

export type FieldRow = {
  field: string;
  /** Rendered for display; for `~`, both ends (`open → closed`). */
  value: string;
  /** True when what the twin reported for it is nothing at all. */
  empty: boolean;
  mark: FieldMark;
};

export type FieldSplit = {
  lead: FieldRow[];
  rest: FieldRow[];
  /** Fields the twin reported for this row, across both sides. */
  total: number;
  /** How many of them actually moved. Equals `total` for an insert or delete. */
  moved: number;
  kind: "insert" | "update" | "delete" | "none";
};

const EMPTY: FieldSplit = { lead: [], rest: [], total: 0, moved: 0, kind: "none" };

/** `""`, `[]`, `{}`, `null` and `undefined` all read as "the twin sent nothing". */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/** What the row shows for a value. Empty ones keep their shape (`""` vs `[]`). */
export function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value.length === 0 ? '""' : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Deep-enough equality for two reported values: same JSON, same field. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The twin's timestamps, which are never the point of a change. Both spellings:
 * GitHub and Stripe write `created_at`, Linear writes `createdAt`.
 */
export function isTimestampKey(field: string): boolean {
  return /(?:_at|[a-z]At)$/.test(field);
}

/**
 * Every bracket identity in the world panel's paths.
 * `repositories[acme/api].issues[#2].labels` yields `acme/api` and `#2`.
 */
export function bracketIdentities(paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const path of paths) {
    for (const match of path.matchAll(/\[([^\]]*)\]/g)) {
      const identity = match[1];
      if (identity !== undefined && identity.length > 0) out.add(identity);
    }
  }
  return out;
}

/** Identity keys sort to the front, in `IDENTITY_KEYS` order; the rest hold source order. */
function leadRank(field: string): number {
  const index = (IDENTITY_KEYS as readonly string[]).indexOf(field);
  return index === -1 ? IDENTITY_KEYS.length : index;
}

type Judged = FieldRow & { moved: boolean; order: number };

/** One field, read across both sides of the delta. */
function judge(
  field: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  order: number,
): Judged {
  const had = before !== null && field in before;
  const has = after !== null && field in after;
  const old = before?.[field];
  const now = after?.[field];

  if (had && has && !same(old, now)) {
    return {
      field,
      value: `${formatValue(old)} → ${formatValue(now)}`,
      empty: false,
      mark: "~",
      moved: true,
      order,
    };
  }
  if (has && !had) {
    return { field, value: formatValue(now), empty: isEmptyValue(now), mark: "+", moved: true, order };
  }
  if (had && !has) {
    return { field, value: formatValue(old), empty: isEmptyValue(old), mark: "−", moved: true, order };
  }
  // Present on both sides and identical: it sat still through this call.
  return { field, value: formatValue(now), empty: isEmptyValue(now), mark: "·", moved: false, order };
}

/**
 * Split one reported mutation into the fields that name what happened and the
 * ones that fold behind "the twin recorded N more fields".
 *
 * `worldPaths` supplies the parent echo: pass the paths of the world panel this
 * detail sits beside. Passing none simply means nothing is treated as an echo,
 * which is the safe direction — a field shown twice is a smaller failure than a
 * field hidden for the wrong reason.
 */
export function splitFields(delta: StateDelta, worldPaths: readonly string[] = []): FieldSplit {
  if (delta === null) return EMPTY;
  const before = (delta.before ?? null) as Record<string, unknown> | null;
  const after = (delta.after ?? null) as Record<string, unknown> | null;
  if (before === null && after === null) return EMPTY;

  const kind: FieldSplit["kind"] =
    before === null ? "insert" : after === null ? "delete" : "update";
  const echoes = bracketIdentities(worldPaths);
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];

  const judged = keys.map((field, order) => judge(field, before, after, order));
  const lead: Array<Judged & { rank: number }> = [];
  const rest: FieldRow[] = [];

  for (const row of judged) {
    const echo = echoes.has(row.value);
    const folded = !row.moved || row.empty || isTimestampKey(row.field) || echo;
    if (folded) rest.push({ field: row.field, value: row.value, empty: row.empty, mark: row.mark });
    else lead.push({ ...row, rank: leadRank(row.field) });
  }

  lead.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return {
    lead: lead.map(({ field, value, empty, mark }) => ({ field, value, empty, mark })),
    rest,
    total: keys.length,
    moved: judged.filter((row) => row.moved).length,
    kind,
  };
}

/** The disclosure's label, which carries the count whether open or shut. */
export function foldLabel(count: number, open: boolean): string {
  if (count === 0) return "";
  if (open) return `hide the other ${count} field${count === 1 ? "" : "s"}`;
  return `the twin recorded ${count} more field${count === 1 ? "" : "s"} — show them`;
}

/**
 * The sentence under a detail. Never claims completeness: the twins genuinely
 * differ in how much of a mutation they report, and a panel implying otherwise
 * would be worse than no panel.
 */
export function detailNote(split: FieldSplit): string {
  const fields = (n: number) => `${n} field${n === 1 ? "" : "s"}`;
  switch (split.kind) {
    case "none":
      return "Nothing changed — the twin reported no before and no after for this call.";
    case "insert":
      return `The row arrived with ${fields(split.total)}. That is all the twin reported.`;
    case "delete":
      return `The row left. The twin reported ${fields(split.total)} of what it held.`;
    case "update":
      return `${fields(split.moved)} of ${split.total} moved. The rest sat still through this call.`;
  }
}
