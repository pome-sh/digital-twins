// SPDX-License-Identifier: Apache-2.0
//
// Where a state-reading check LOOKED.
//
// `evidenceEventIds` answers "which recorded call produced this
// verdict", and only a `substrate: "tape"` check can fill it. That left 37 of
// the 45 declared checks citing nothing at all — not a call, not a state path,
// nothing a report could turn into an affordance. This module is the other
// pointer: the address, inside the twin's own exported state tree, of the thing
// the predicate compared.
//
// Split from `checks.ts` for the same reason `check-discrimination.ts` is:
// that file DEFINES the grammar a declaration is written in, this one defines a
// second, much smaller grammar — the one a POINTER is written in — and `checks.ts`
// is already at the 500-line health limit. Consumers import both from
// `@pome-sh/sdk/checks`, which re-exports these.
//
// ─── Why RFC 6901, and why not a friendlier syntax ──────────────────────────
//
// A pointer here is a JSON Pointer over the tree the twin's `exportState()`
// produced. Two properties decided it, and both are about the READER rather
// than the writer:
//
//   1. It resolves or it does not. There is no partial match, no fuzzy segment,
//      no "the array moved by one" — so a consumer can ask a total question
//      (`resolveStatePath`) and get a total answer. That is exactly what
//      `apps/dashboard/src/lib/criterion-evidence.ts` needs to decide between
//      rendering an affordance and rendering none: the rule is that a row
//      never advertises a jump that then does nothing, and a pointer language
//      with a maybe in it cannot honour that rule.
//   2. It is somebody else's spec. A hand-rolled `repositories[0].issues[2]`
//      needs an escaping story the first time a key contains a dot, and this
//      tree has keys like `full_name` today and label names tomorrow. RFC 6901
//      already wrote that story down (`~0` for `~`, `~1` for `/`), and the
//      consumer is a browser that will re-implement the walk in fifteen lines
//      whatever we choose.
//
// ─── Which tree a pointer addresses ─────────────────────────────────────────
//
// ALWAYS `final` — the exported end state — even for a `seed+final` check whose
// assertion is a delta. That is not a shortcut, it is what makes the pointer
// usable: the reader has the final tree on screen, and a pointer into a seed it
// is not rendering would be an affordance that lands nowhere, which is the
// defect this module exists to remove rather than relocate.
//
// A delta check therefore cites the field whose CHANGE it asserted about
// (`github.no-new-labels` cites the repo's final label set), and its reason
// sentence carries the before/after. The pointer says where to look; the reason
// says what was wrong there.

import type { CheckDefinition } from "./checks.js";

/**
 * One segment, escaped per RFC 6901 §3.
 *
 * Order matters and is not interchangeable: `~` must be encoded FIRST, or the
 * `/` pass would turn a literal `/` into `~1` and the `~` pass would then turn
 * that into `~01`, which decodes back to `~1` — a different string. This is the
 * canonical ordering the spec spells out, restated here because getting it
 * backwards produces a pointer that looks right and resolves to nothing.
 */
function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * A pointer from the ROOT of the exported tree.
 *
 * Numbers are array indices and strings are object keys, but this function does
 * not enforce that — the tree decides, at resolution time. Passing no segments
 * returns `""`, which RFC 6901 defines as the whole document; a check with
 * nothing narrower to name must OMIT `evidenceStatePaths` rather than cite the
 * root, for the same reason it must omit rather than send `[]`.
 */
export function statePath(...segments: readonly (string | number)[]): string {
  return segments.map((segment) => `/${escapeSegment(String(segment))}`).join("");
}

/**
 * A pointer relative to one a resolver already built.
 *
 * The twins' `resolve*` helpers walk the tree to find an entity and now hand
 * back the pointer they walked; a check appends the field it went on to read.
 * Written as its own function rather than string concatenation at 37 call sites
 * because the escaping has to happen on the appended segments and NOT on the
 * base, which already contains real `/` separators — concatenating by hand is
 * how a `~1` ends up double-encoded.
 */
export function childStatePath(
  base: string,
  ...segments: readonly (string | number)[]
): string {
  return `${base}${statePath(...segments)}`;
}

/**
 * What a pointer addresses in a tree, or `null` when it addresses nothing.
 *
 * `null` is a NORMAL answer and every caller must handle it: the state blob a
 * report renders can be a different export from the one the check read (a
 * re-run, a truncated upload, a snapshot predating a field). A consumer turns
 * `null` into "no affordance", exactly as `findEventIndexForEvidence` turns an
 * unresolvable event id into one.
 *
 * Wrapped in `{ value }` rather than returned bare because `undefined` and
 * `null` are both legal JSON-ish values a tree can hold at a pointer, and a bare
 * return could not tell "the path is absent" from "the path holds null" — the
 * difference between no evidence and evidence that the field is empty.
 */
export function resolveStatePath(
  tree: unknown,
  pointer: string,
): { value: unknown } | null {
  if (pointer === "") return { value: tree };
  // RFC 6901 §3: a non-empty pointer MUST begin with "/". Anything else is not
  // a pointer, and guessing (say, by prefixing one) would resolve a string the
  // writer never wrote.
  if (!pointer.startsWith("/")) return null;

  let cursor: unknown = tree;
  // `slice(1)` drops the leading "" that splitting on the leading "/" produces.
  // A trailing "/" is meaningful — it is the empty-string KEY, which is legal —
  // so this deliberately does not trim.
  for (const raw of pointer.slice(1).split("/")) {
    const segment = unescapeSegment(raw);
    if (Array.isArray(cursor)) {
      // Array indices are decimal, no leading zeros, no "+", no "-0" — spelled
      // out rather than left to `Number()`, which happily accepts "1e0", " 1"
      // and "0x1" and would resolve pointers nobody could have written.
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return null;
      const index = Number(segment);
      if (index >= cursor.length) return null;
      cursor = cursor[index];
      continue;
    }
    // `typeof null === "object"`, so the null guard is not redundant.
    if (cursor === null || typeof cursor !== "object") return null;
    const record = cursor as Record<string, unknown>;
    // `in` rather than a truthiness test, so a field holding `null`, `0` or `""`
    // resolves. A pointer at a field that exists and is empty is evidence — it
    // is how a reader sees that the label set the check read was empty.
    //
    // Own properties only: `/constructor` must not resolve through the
    // prototype chain and hand a consumer a function to render.
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return null;
    cursor = record[segment];
  }
  return { value: cursor };
}

// ─── The gate ────────────────────────────────────────────────────────────────
//
// A field nobody fills is worse than no field: it advertises a capability the
// report cannot use, and the opening measurement (8 of 45) is exactly
// what an unfilled optional field looks like from the outside. So the citation
// gets the same treatment `discriminatingWorlds` got — a probe here, a
// ledgered assertion in each twin's contract test, and a null that costs
// something to admit.
//
// It reuses the worlds the check ALREADY declares rather than asking for a
// second fixture. That is the whole reason this gate is cheap enough to hold
// across five twins: `discriminatingWorlds` is required, so every state check
// already ships a world its predicate resolves in, and "does the pointer it
// cites resolve in that same world" is a question with no new inputs.

export type StateCitationArm = "passing" | "failing";

export type StateCitationVerdict =
  // Both arms cited at least one pointer, and every pointer resolved.
  | { kind: "cites" }
  // The declaration named no worlds. The CALLER must find a ledger entry — this
  // function deliberately does not know about ledgers, exactly as
  // `probeDiscrimination` does not, so a twin cannot satisfy the gate by
  // shipping an empty one.
  | { kind: "declined" }
  // The outcome named no path at all.
  | { kind: "uncited"; arm: StateCitationArm }
  // A pointer was cited and addresses nothing in the world the check just read.
  | { kind: "unresolvable"; arm: StateCitationArm; pointer: string }
  // A pointer was cited that is not a pointer — `[]`, an empty string, a
  // non-string. Separated from `unresolvable` because the fix is different: one
  // is a bad address, the other is a check that forgot the omit-don't-empty rule.
  | { kind: "malformed"; arm: StateCitationArm; detail: string };

function probeArm<TState, TArgs extends Record<string, string>>(
  def: CheckDefinition<TState, TArgs>,
  args: TArgs,
  arm: StateCitationArm,
  world: { seed: TState | null; final: TState; tape: readonly unknown[] | null },
): StateCitationVerdict {
  const outcome = def.evaluate(args, world as never);
  const paths = outcome.evidenceStatePaths;
  if (paths === undefined) return { kind: "uncited", arm };
  if (!Array.isArray(paths) || paths.length === 0) {
    // The omit-don't-empty rule, enforced rather than documented. `[]` and
    // absent mean the same thing downstream, so a check that sends `[]` has
    // written a key the consumer must special-case for no gain.
    return {
      kind: "malformed",
      arm,
      detail: `evidenceStatePaths must be omitted when empty, not sent as ${JSON.stringify(paths)}`,
    };
  }
  for (const pointer of paths) {
    if (typeof pointer !== "string" || pointer === "") {
      return {
        kind: "malformed",
        arm,
        detail: `${JSON.stringify(pointer)} is not a pointer — the whole-document pointer "" is not a citation`,
      };
    }
    // Against `final`, because that is the tree a pointer addresses and the tree
    // a reader has on screen.
    if (resolveStatePath(world.final, pointer) === null) {
      return { kind: "unresolvable", arm, pointer };
    }
  }
  return { kind: "cites" };
}

/**
 * Does this state-reading check say WHERE it looked, in a form that resolves?
 *
 * Probes BOTH arms, and that is deliberate. A citation present on the passing
 * world and absent on the failing one is worse than no citation at all: its
 * absence starts reading as a verdict class — "no evidence" would come to mean
 * "this one failed" — and the reader has no way to know that is an accident of
 * how the predicate was written. So a check must be able to say where it looked
 * whether or not it liked what it found there.
 *
 * Only meaningful for `final` / `seed+final` checks. A `tape` check cites
 * `evidenceEventIds` instead and is not this gate's business; callers filter on
 * `substrate` before probing.
 */
export function probeStateCitation<TState, TArgs extends Record<string, string>>(
  def: CheckDefinition<TState, TArgs>,
  args: TArgs,
): StateCitationVerdict {
  const worlds = def.discriminatingWorlds(args);
  if (worlds === null) return { kind: "declined" };
  const passing = probeArm(def, args, "passing", worlds.passing);
  if (passing.kind !== "cites") return passing;
  return probeArm(def, args, "failing", worlds.failing);
}
