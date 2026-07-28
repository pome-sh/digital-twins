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

export type CheckPolarity = "positive" | "negative";

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
  render: (value) => value,
  parse: (raw) => raw,
};

export interface CheckOutcome {
  passed: boolean;
  reason: string;
  // An explicit override for when the predicate cannot reach a real verdict,
  // so the criterion leaves the score denominator instead of vacuously
  // passing a wrong agent.
  status?: "passed" | "failed" | "unmatched" | "skipped";
}

export interface CheckSubstrate<TState> {
  // Non-null whenever the declaration asked for "seed+final" — the engine
  // guards before calling `evaluate`. Predicates still guard defensively, so a
  // consumer that forgets produces a named skip rather than a crash.
  seed: TState | null;
  final: TState;
}

export interface CheckDefinition<TState, TArgs extends Record<string, string>> {
  // `<twin>.<what-it-asserts>`, unique across the twin's declarations. Reports
  // name the check a criterion bound to; a regex source is not a name.
  id: string;
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

export function checkPattern<TState, TArgs extends Record<string, string>>(
  def: CheckDefinition<TState, TArgs>,
): RegExp {
  const { params } = templateSlots(def.template);
  return buildPattern(def.template, (index) => def.params[params[index] as keyof TArgs]!.pattern);
}

// The literal segments intact, every slot wide open. A text matching THIS and
// not `checkPattern` is a corrupted instance of this check: it says the
// check's sentence but fills a slot with something the slot's type rejects.
// A text that fails this too is a stranger, and stays on the unmatched path —
// which is what keeps this gate off the legacy phrases that resemble nothing.
export function checkNearMissPattern<TState, TArgs extends Record<string, string>>(
  def: CheckDefinition<TState, TArgs>,
): RegExp {
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
