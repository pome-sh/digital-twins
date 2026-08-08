// SPDX-License-Identifier: Apache-2.0
//
// The assertable check vocabulary (F-1073, milestone A2b).
//
// Position 2: the author selects a typed check and the system RENDERS the
// English. Binding cannot fail, because the sentence is what the check
// produced. That is why there is no `pattern` field here — the matcher is
// GENERATED from `template`, so a declaration and its regex cannot drift
// apart, and an author can neither write nor break one.
//
// This module is twin-agnostic. Each twin declares its own checks next to the
// state they read (`packages/twin-<x>/src/checks.ts`), because the twin owns
// that state's shape; pome-cloud imports those declarations from npm and
// adapts them onto its existing predicate engine. There is no second copy to
// reconcile — the drift gate's job is catching a pin that fell behind, not
// reconciling two hand-maintained vocabularies.

import { createHash } from "node:crypto";

export type CheckPolarity = "positive" | "negative";

// The values a `vacuityMutant` substitutes to falsify a check's scanned
// literal. They live here, not in the consumer that probes with them, because
// the declaration WRITES them and the probe RECOGNISES them — two copies of one
// fact is the defect this vocabulary exists to remove, and the failure mode of a
// skew is silent: the probe stops recognising its own mutants and every check
// reads as un-probed.
//
// Three forms because a slot's type has to accept the substitution or the mutant
// cannot re-bind, and a check that stops matching its own pattern evaluates to
// `unmatched`, which reads as "the verdict moved" and blesses the very criterion
// the probe exists to catch.
export const VACUITY_SENTINEL = "pome-vacuity-never";
export const VACUITY_SENTINEL_SNAKE = "pome_vacuity_never";
export const VACUITY_SENTINEL_NUMBER = 987654321;

// Which substrates a check's predicate needs. The consuming engine supplies
// them and, when one is unavailable, returns a NAMED skip instead of calling
// `evaluate` against a hole:
//   "final"       the exported end state only
//   "seed+final"  the seed's state tree AND the end state (a delta assertion)
//   "tape"        the recorded HTTP call tape
export type CheckSubstrateKind = "final" | "seed+final" | "tape";

// A typed parameter slot. `pattern` is a regex SOURCE carrying no capture
// groups of its own — the generator wraps it in exactly one group per slot, so
// group indices line up with `templateSlots().params`.
export interface CheckParamType {
  readonly name: string;
  readonly pattern: string;
  // A valid value for this slot, shown as an author-facing hint (F-1074).
  // `pattern` is a regex source; asking an author to satisfy one directly is
  // hostile. `defineCheck` asserts this against `pattern` at module load, so a
  // type whose own example is invalid cannot ship.
  readonly example: string;
  render(value: string): string;
  parse(raw: string): string;
}

// `owner/name`. Deliberately narrow, and it must NOT accept a bare repo name:
// a sentence with a malformed repo has to be reported as the corrupted
// template instance it is, rather than quietly parsing into a lookup that then
// fails for an unrelated-looking reason.
export const repoRef: CheckParamType = {
  name: "repo",
  pattern: "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+",
  example: "acme/api",
  render: (value) => value,
  parse: (raw) => raw,
};

// A slot whose value comes from a CLOSED set — an issue's `open`/`closed`, a
// review's `APPROVED`/`CHANGES_REQUESTED`, a commit status's four states.
//
// F-1075. The legacy regexes spelled these inline as `(open|closed)`, which
// worked but put the closed set somewhere no authoring surface could read. As a
// param type the set travels with the declaration: `pome checks` prints it, the
// picker offers it, and a value outside it is a corrupted instance rather than
// a lookup that quietly finds nothing.
//
// Non-capturing on purpose — see `defineCheck`'s group assertion. The values are
// escaped because a set member is a LITERAL, never a sub-pattern; `not merged`
// carrying a space is fine, and a member carrying `.` must not become `any`.
export function oneOf(name: string, values: readonly string[], example?: string): CheckParamType {
  if (values.length === 0) throw new Error(`param type ${name}: oneOf needs at least one value`);
  return {
    name,
    pattern: `(?:${values.map(escapeLiteral).join("|")})`,
    example: example ?? values[0]!,
    render: (value) => value,
    parse: (raw) => raw,
  };
}

// How many capture groups a param type's pattern opens on its own. Must be
// zero: `checkPattern` wraps exactly one group per slot and every consumer reads
// group i+1 as slot i, so a type that smuggles in its own group shifts every
// later slot by one and silently hands each predicate its neighbour's argument.
//
// The `|` trick: appending an empty alternative makes the pattern match "" no
// matter what it is, so the result array is always non-null and its length is
// 1 + the group count.
function captureGroupCount(source: string): number {
  return new RegExp(`${source}|`).exec("")!.length - 1;
}

export interface CheckOutcome {
  passed: boolean;
  reason: string;
  // An explicit override for when the predicate cannot reach a real verdict,
  // so the criterion leaves the score denominator instead of vacuously
  // passing a wrong agent.
  status?: "passed" | "failed" | "unmatched" | "skipped";
  // F-1076 — the recorded calls this outcome asserted against, by
  // `TwinHttpEvent.event_id`. Only a `substrate: "tape"` check can fill it;
  // state-reading checks leave it absent, because their evidence is a path into
  // the state tree and this pointer does not model that.
  //
  // It exists because moving a tape predicate into a declaration would
  // otherwise have DROPPED F-980's citations on the floor: the consuming
  // engine's outcome type has carried this field since F-980, and a declaration
  // that could not express it would have been a silent downgrade sold as a
  // refactor.
  //
  // Absent and `[]` mean the same thing downstream, so a check with nothing to
  // cite must OMIT the key rather than send an empty array — the consumer
  // persists this into a jsonb row, and an empty affordance would have to be
  // special-cased by every reader of it.
  evidenceEventIds?: string[];
  // F-1197 — where in the exported state tree this outcome LOOKED, as RFC 6901
  // JSON Pointers (`/repositories/0/issues/2/labels`). The state-substrate
  // sibling of `evidenceEventIds`, and the thing the comment above calls
  // impossible: state-reading checks left that pointer absent "because their
  // evidence is a path into the state tree and this pointer does not model
  // that". This one models that — 8 of 45 declared checks read the tape, and the
  // other 37 could cite nothing at all, which renders as an inert row a reader
  // cannot tell from a verdict with no evidence.
  //
  // ALWAYS relative to `final`, never `seed`, even for a delta check.
  // `check-state-path.ts` carries that argument and the pointer grammar's;
  // build the value with `statePath` / `childStatePath` rather than by hand.
  //
  // Same omit-don't-empty discipline as its sibling, for the same reason.
  evidenceStatePaths?: string[];
}

// One recorded twin HTTP call, as a `substrate: "tape"` check sees it.
//
// This is the frozen v1.0 `TwinHttpEvent` (`@pome-sh/wire`
// recorder-events) minus required-ness: every field is optional/nullable so a
// malformed row can never crash a predicate.
//
// F-1125 closed the gap F-1076 documented here. `headers` used not to exist on
// the recorded event at all — not a narrowing a consumer could lift, but a
// recorder that never captured them, which is why `The retry includes X-PAYMENT`
// was unanswerable at any substrate width. It is `request_headers` now, and
// `tool` alongside it. Both are OPTIONAL for the same reason every field here
// is: a recording made before they existed still has to parse, and a tape check
// reading `undefined` must decide what that means rather than crash.
//
// It lives HERE, not in the consuming engine, for the same reason the
// declarations do: the checks that read it are declared in twin packages, and a
// consumer-side copy of this shape would drift the way the mirrored state shape
// did before F-1075 deleted it — silently, surfacing only when a predicate
// reads a field the copy forgot.
//
// ORDER IS A CONTRACT. The consumer supplies these oldest-first, and a check
// may rely on it. That is the half of D1 this type settles.
export interface CheckTapeEvent {
  ts?: string | null;
  twin?: string | null;
  method?: string | null;
  path?: string | null;
  request_body?: unknown;
  // F-1125 — the request headers as recorded, keys lowercased by the runtime.
  //
  // `undefined` is a THIRD world here and a check must not collapse it into the
  // other two: `{}` is "the call sent no headers", a present map missing a key is
  // "it sent others but not that one", and ABSENT is "this recording predates
  // the field". Only the first two support a verdict; reading absent as "the
  // header was not sent" would answer a negative criterion over a recording that
  // never carried the evidence.
  request_headers?: Record<string, string>;
  status?: number | null;
  response_body?: unknown;
  latency_ms?: number | null;
  fidelity?: string | null;
  state_mutation?: boolean | null;
  error?: string | null;
  // F-1125 — the twin ACTION this call invoked, or null when the surface that
  // served it declares none. Stamped identically by MCP dispatch and by a REST
  // route that performs the same action, which is what lets a check ask "was
  // this ever called" without knowing which transport the examinee chose.
  //
  // A check must treat `null` as "no declared action", NOT as "no action": the
  // twin stamps only the surfaces it has committed to, and the set of actions a
  // check may name is generated from that commitment (see the GitHub twin's
  // `TAPE_ASSERTABLE_TOOLS`). `undefined` means the row predates the field.
  tool?: string | null;
  // F-980 — the citable identity of this call. `event_id` rather than
  // `request_id` because only `event_id` survives onto the OTLP span lane.
  event_id?: string | null;
}

export interface CheckSubstrate<TState> {
  // Non-null whenever the declaration asked for "seed+final" — the engine
  // guards before calling `evaluate`. Predicates still guard defensively, so a
  // consumer that forgets produces a named skip rather than a crash.
  seed: TState | null;
  final: TState;
  // F-1076 — non-null whenever the declaration asked for "tape", already scoped
  // to this criterion's twin by the engine. Ordered oldest-first.
  //
  // Required key, nullable value, exactly like `seed`. An OPTIONAL key is one
  // every later consumer forgets to pass, and forgetting it here silently
  // promotes every tape check to a skip — a fleet of negative criteria that
  // stop asserting, quietly, which is the one failure D4 forbids.
  //
  // `null` and `[]` are DIFFERENT WORLDS and a check must treat them so: `null`
  // is "nobody handed me a tape", `[]` is "the agent called nothing".
  tape: readonly CheckTapeEvent[] | null;
}

// A check's own proof that it discriminates: one world where its assertion
// holds, one where it does not.
//
// A PAIR, and the reason is measured rather than argued (F-1126). Every
// state-reading check resolves its selector before it asserts, and a selector
// miss returns a REAL failure rather than a skip — so 11 of GitHub's 13
// declarations returned `passed: false` against `{ seed: {}, final: {} }`, a
// fixture that proves nothing about the assertion. Requiring the passing side
// forces a world that actually resolves, and `probeDiscrimination`'s third arm
// rejects a failing world whose reason is the one an empty world already gives.
//
// It is also not a new shape. F-1076 shipped it twice as a convention —
// `check-tape.test.ts`'s "THE FAILING WORLD" and, directly below it, the pair
// asserting opposite verdicts against a byte-identical state. This promotes that
// convention to a declaration with a gate behind it.
export interface CheckWorlds<TState> {
  passing: CheckSubstrate<TState>;
  failing: CheckSubstrate<TState>;
}

export type DiscriminationArm = "passing" | "failing" | "degenerate";

export type DiscriminationVerdict =
  // Both worlds answered, and they disagreed.
  | { kind: "discriminates" }
  // The declaration returned null. The CALLER must find a ledger entry — this
  // function deliberately does not know about ledgers, so a twin cannot satisfy
  // the gate by shipping an empty one.
  | { kind: "declined" }
  | { kind: "broken"; arm: DiscriminationArm; detail: string };

export interface CheckDefinition<TState, TArgs extends Record<string, string>> {
  // `<twin>.<what-it-asserts>`, unique across the twin's declarations. Reports
  // name the check a criterion bound to; a regex source is not a name.
  id: string;
  // What the predicate ACTUALLY compares, in a sentence or two (F-1074).
  //
  // REQUIRED, for the same reason `polarity` and `vacuityMutant` are: an
  // optional field is one every later declaration omits, and an authoring
  // surface can only show what is declared. A picker that offers nothing but
  // the rendered sentence is the readable surface that hides disagreement
  // (Shankar et al., UIST '24 §7.3.3) — `no-new-labels` reads as an
  // issue-level claim while comparing repo-level label DEFINITIONS, so an
  // agent applying an already-defined label passes, correctly and invisibly.
  description: string;
  // English with typed slots, e.g. "No new labels were created in `{repo}`".
  // This is the ONE grammar: rendering and matching are both derived from it.
  template: string;
  params: { [K in keyof TArgs]: CheckParamType };
  substrate: CheckSubstrateKind;
  // Declared, never inferred from the English (F-1070). A function of the args
  // because one template can carry both directions.
  polarity(args: TArgs): CheckPolarity;
  // The literal this predicate compares against state, when it has one
  // (F-1028). The engine runs it past the redaction pipeline BEFORE calling
  // `evaluate`: a subject a redactor destroys can never appear in the
  // production state, so the predicate could not fire and the criterion must
  // be skipped rather than vacuously passed.
  //
  // Omit — or return null — when the check asserts only on structure. That
  // means "nothing a redactor could silently delete", not "not audited yet".
  subject?(args: TArgs): string | null;
  // F-1072, and note the shape: this returns mutated ARGS, not a mutated
  // sentence. The engine re-renders them.
  //
  // That shape is the point. The legacy interface had every rule write its
  // mutant sentence out by hand, because a generic capture-group splicer keyed
  // on `indexOf(m[n])` mutates the wrong literal whenever a group's text
  // appears earlier in the sentence (`Comment containing "1" on issue #1`).
  // Here nothing ever edits a sentence, so that hazard is unreachable.
  //
  // Return null when there is no literal to falsify. A parameter that only
  // SELECTS (a repo, an issue number) is not a trigger: mutating it moves the
  // verdict for a reason that never reaches the assertion, which is a clean
  // bill the check did not earn. Null is reported as `no_trigger`, never as
  // clean — an admitted blind spot beats a false clean bill.
  vacuityMutant(args: TArgs): TArgs | null;
  // The worlds this check discriminates between (F-1126). Same required-ness as
  // `description` and `vacuityMutant`, for the same reason: an optional field is
  // one every later declaration omits.
  //
  // Return null ONLY when no pair can be built, and state why in the twin's
  // `HONEST_NULL_WORLDS`. Unlike `vacuityMutant` there is no structural excuse —
  // a closed set genuinely has no guaranteed-false member, but every field of
  // `CheckSubstrate<TState>` is hand-fillable — so that ledger ships EMPTY.
  discriminatingWorlds(args: TArgs): CheckWorlds<TState> | null;
  evaluate(args: TArgs, substrate: CheckSubstrate<TState>): CheckOutcome;
}

const SLOT_RE = /\{([a-z][a-z0-9_]*)\}/g;

// Splits "a {x} b" into { literals: ["a ", " b"], params: ["x"] }.
// `literals.length` is always `params.length + 1`, which is what lets the
// pattern builder interleave them without a special case for either end.
export function templateSlots(template: string): { literals: string[]; params: string[] } {
  const literals: string[] = [];
  const params: string[] = [];
  let cursor = 0;
  for (const match of template.matchAll(SLOT_RE)) {
    literals.push(template.slice(cursor, match.index));
    params.push(match[1]!);
    cursor = match.index + match[0].length;
  }
  literals.push(template.slice(cursor));
  return { literals, params };
}

function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The args a `params` map implies: one string per declared slot. Inference
// runs through `params` rather than through `TArgs` directly, because a mapped
// type is a poor inference site — `TArgs` inferred from
// `{ [K in keyof TArgs]: CheckParamType }` widens to `Record<string, string>`
// and every caller loses its slot names.
type ArgsOfParams<TParams extends Record<string, CheckParamType>> = {
  [K in keyof TParams]: string;
};

// Validates a declaration at module load, so a broken check cannot ship: a
// slot with no type, a type no slot uses, or a repeated slot are all authoring
// mistakes that would otherwise surface as a check that silently binds nothing.
export function defineCheck<TState, TParams extends Record<string, CheckParamType>>(
  def: Omit<CheckDefinition<TState, ArgsOfParams<TParams>>, "params"> & { params: TParams },
): CheckDefinition<TState, ArgsOfParams<TParams>> {
  const { params } = templateSlots(def.template);
  const seen = new Set<string>();
  for (const param of params) {
    if (seen.has(param)) {
      throw new Error(`check ${def.id}: duplicate template slot {${param}}`);
    }
    seen.add(param);
    if (!def.params[param as keyof TParams]) {
      throw new Error(`check ${def.id}: template slot {${param}} has no declared param type`);
    }
  }
  for (const declared of Object.keys(def.params)) {
    if (!seen.has(declared)) {
      throw new Error(`check ${def.id}: declared param \`${declared}\` is not used by the template`);
    }
  }
  // F-1074 — a param type whose own example violates its own pattern would put
  // an invalid value in front of an author as the suggested one.
  for (const [name, type] of Object.entries(def.params)) {
    const paramType = type as CheckParamType;
    if (!new RegExp(`^${paramType.pattern}$`).test(paramType.example)) {
      throw new Error(
        `check ${def.id}: param \`${name}\` example ${JSON.stringify(paramType.example)} ` +
          `does not match its own pattern /${paramType.pattern}/`,
      );
    }
    // F-1075 — the failure this prevents is silent and total. Every consumer
    // reads capture group i+1 as template slot i (`parseCheck` here,
    // `argsFromMatch` in the cloud's adapter); one extra group inside a param's
    // pattern shifts all of them, so each predicate is handed its neighbour's
    // argument and grades a sentence nobody wrote. Cheap to assert, invisible
    // to debug — `oneOf` is non-capturing for exactly this reason.
    const groups = captureGroupCount(paramType.pattern);
    if (groups > 0) {
      throw new Error(
        `check ${def.id}: param \`${name}\` pattern /${paramType.pattern}/ opens ${groups} ` +
          `capture group(s). Slot patterns must be group-free — use (?:…) — or every ` +
          `slot after this one binds the wrong value.`,
      );
    }
  }
  return def as CheckDefinition<TState, ArgsOfParams<TParams>>;
}

export function renderCheck<TState, TArgs extends Record<string, string>>(
  def: CheckDefinition<TState, TArgs>,
  args: TArgs,
): string {
  const { literals, params } = templateSlots(def.template);
  let rendered = literals[0]!;
  params.forEach((param, index) => {
    const type = def.params[param as keyof TArgs]!;
    rendered += type.render(args[param as keyof TArgs]) + literals[index + 1]!;
  });
  return rendered;
}

function buildPattern(template: string, slotSource: (index: number) => string): RegExp {
  const { literals, params } = templateSlots(template);
  let source = `^${escapeLiteral(literals[0]!)}`;
  params.forEach((_param, index) => {
    source += `(${slotSource(index)})${escapeLiteral(literals[index + 1]!)}`;
  });
  // Case-SENSITIVE and anchored on purpose. Any text this matches must
  // re-render byte-identically, which makes the render→parse→render round trip
  // a property of the generator rather than a condition to re-test at run time.
  return new RegExp(`${source}$`);
}

// The subset of a declaration that decides what BINDS. Named as a type because
// it is exactly what `checksDigest` hashes and exactly what a stale pin can
// move. Taking this instead of `CheckDefinition` also lets a heterogeneous
// registry be hashed without the args-erasing cast the engine needs elsewhere.
export interface CheckBindingShape {
  readonly id: string;
  readonly template: string;
  readonly substrate: CheckSubstrateKind;
  readonly params: Readonly<Record<string, CheckParamType>>;
}

export function checkPattern(def: CheckBindingShape): RegExp {
  const { params } = templateSlots(def.template);
  return buildPattern(def.template, (index) => def.params[params[index]!]!.pattern);
}

// One implementation, called by BOTH the control plane and the CLI (F-1074).
// They resolve declarations from independent npm pins and must be able to prove
// they agree before an author writes a sentence; two implementations of "hash
// the binding surface" would be the same two-representations-of-one-fact defect
// this vocabulary exists to remove, one level down — a sort or key-order
// difference would make every pin look skewed, or a real skew look equal.
//
// `description` and `example` are deliberately NOT hashed. This digest gates an
// author's write, and a prose edit changes no sentence. Neither is
// `discriminatingWorlds` (F-1126) — a fixture is not part of the binding
// surface, so adding the field skews no pin and a changed world moves no
// sentence.
export function checksDigest(defs: readonly CheckBindingShape[]): string {
  const rows = defs
    .map((def) => ({
      id: def.id,
      substrate: def.substrate,
      // The compiled source, not the template: this also catches a change in
      // `buildPattern` itself, which comparing templates would miss.
      pattern: checkPattern(def).source,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return `sha256:${createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex")}`;
}

// The literal segments intact, every slot wide open. A text matching THIS and
// not `checkPattern` is a corrupted instance of this check: it says the
// check's sentence but fills a slot with something the slot's type rejects.
// A text that fails this too is a stranger, and stays on the unmatched path —
// which is what keeps this gate off the legacy phrases that resemble nothing.
export function checkNearMissPattern(def: CheckBindingShape): RegExp {
  return buildPattern(def.template, () => ".+?");
}

export function parseCheck<TState, TArgs extends Record<string, string>>(
  def: CheckDefinition<TState, TArgs>,
  text: string,
): TArgs | null {
  const matched = text.trim().match(checkPattern(def));
  if (!matched) return null;
  const { params } = templateSlots(def.template);
  const args: Record<string, string> = {};
  params.forEach((param, index) => {
    args[param] = def.params[param as keyof TArgs]!.parse(matched[index + 1]!);
  });
  return args as TArgs;
}

// Everything above DEFINES the grammar; the three modules below EXERCISE a
// declaration written in it — do its declared worlds disagree (F-1126), does its
// state citation resolve (F-1197), and what protects a slot the `subject` arm
// never looks at when a redactor eats its literal (F-1157). Each split off when
// this file reached the 500-LOC health limit, a fair reading of that seam. All
// three are re-exported here so `@pome-sh/sdk/checks` keeps ONE import site:
// consumers ask the vocabulary module about the vocabulary, and the split stays
// internal.
export { probeDiscrimination } from "./check-discrimination.js";
export {
  statePath, childStatePath, resolveStatePath, probeStateCitation,
  type StateCitationArm, type StateCitationVerdict,
} from "./check-state-path.js";
export {
  REDACTION_PLACEHOLDER, isRedacted, probeRedactionSurvival,
  type RedactionGuard, type RedactionSurvivalRow, type RedactionSurvivalVerdict,
} from "./check-redaction.js";
