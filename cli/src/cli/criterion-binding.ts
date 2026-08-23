// SPDX-License-Identifier: Apache-2.0
/**
 * Does a `[code]` criterion bind to a check its twin declares?
 *
 * A criterion that binds nothing is not an error anywhere: the grader skips it
 * and the score is computed over the rest, so the denominator moves for a reason
 * nobody wrote down. Three doors already refuse one — `save_task` and
 * `validate_task` over the hosted MCP, and the corpus gate in CI — and a
 * local-only author authoring tasks in their own repo reaches none of them.
 * `pome` is meant to work offline, so a gap that only appears offline is a gap.
 *
 * OFFLINE BY CONSTRUCTION. Nothing here consults the cloud. Binding is a
 * question about the sentence and the CLI's own pinned declaration, and any
 * answer that needed the network would inherit the pin-skew problem in the one
 * mode where this gap lives. The digest handshake in `checks-add.ts` remains the
 * place where the two pins are compared — that is a question about WRITING a
 * sentence, and it is a different question from whether one already binds.
 *
 * Resolution comes from `./checks.js` and nowhere else. That module is already a
 * deliberate SECOND resolution point (pome-cloud's registry is the first); a
 * third would be a third thing that can silently resolve nothing.
 */
import { checkNearMissPattern, checkPattern, templateSlots } from "@pome-sh/sdk/checks";

import { readCodeCriteria, type CodeCriterion } from "../task/parseTask.js";
import { checksFor, type DeclaredCheck } from "./checks.js";

export type CriterionBinding =
  // Grades as `checkId`.
  | { kind: "bound"; checkId: string }
  // Says `checkId`'s sentence but fills a slot with a value the slot's type
  // rejects. Reported as `corrupted_check_instance:<id>` at finalize — named, so
  // it is the less dangerous of the two failures, but only after a run.
  | { kind: "corrupted"; checkId: string; slot: string; value: string; example: string }
  // Matches no declared sentence. This is the silent one.
  | { kind: "unbound" }
  // The twin EXISTS but has not migrated its vocabulary, so this CLI holds no
  // declaration to judge the sentence by. Distinct from `unbound` for the same
  // reason `pome checks slack` says "not migrated yet" rather than "no such
  // twin": claiming a criterion will not be graded when the answer is unknown
  // would be wrong on every stripe / slack / gmail / linear task shipped today.
  | { kind: "no-vocabulary" };

export function bindCriterion(criterion: CodeCriterion): CriterionBinding {
  const declared = checksFor(criterion.twin);
  if (declared.length === 0) return { kind: "no-vocabulary" };
  const text = criterion.text.trim();

  // EVERY exact pattern first, across the whole twin, before any near-miss. A
  // near-miss opens each slot to `.+?`, so one check's near-miss can swallow
  // another's perfectly valid sentence; interleaving the two passes would report
  // a criterion that grades fine as a corrupted instance of its neighbour.
  for (const def of declared) {
    if (checkPattern(def).test(text)) return { kind: "bound", checkId: def.id };
  }

  for (const def of declared) {
    const near = text.match(checkNearMissPattern(def));
    if (!near) continue;
    const offender = firstInvalidSlot(def, near);
    // A near-miss whose every slot value is valid would have matched the exact
    // pattern, unless the non-greedy split landed elsewhere than the typed one
    // would. Keep looking rather than reporting a corruption we cannot name.
    if (offender) return { kind: "corrupted", checkId: def.id, ...offender };
  }

  return { kind: "unbound" };
}

/** Which slot the sentence filled with something its type rejects. Group `i + 1`
 *  is slot `i` — `defineCheck` asserts every slot pattern is group-free so those
 *  indices cannot shift, and the near-miss pattern's `.+?` is group-free too. */
function firstInvalidSlot(
  def: DeclaredCheck,
  match: RegExpMatchArray,
): { slot: string; value: string; example: string } | undefined {
  const { params } = templateSlots(def.template);
  for (const [index, name] of params.entries()) {
    const type = def.params[name]!;
    const value = match[index + 1]!;
    if (!new RegExp(`^${type.pattern}$`).test(value)) {
      return { slot: name, value, example: type.example };
    }
  }
  return undefined;
}

export interface BindingFinding {
  criterion: CodeCriterion;
  binding: Extract<CriterionBinding, { kind: "corrupted" | "unbound" }>;
}

export interface BindingAudit {
  /** How many criteria bind. A count, not a list — a pass line needs the number. */
  bound: number;
  /** Criteria whose twin has not migrated its vocabulary. NEITHER a pass nor a
   *  failure: this CLI holds no declaration to judge them by, and folding them
   *  into either bucket would be the false clean bill the vocabulary exists to
   *  remove. Kept separate so a caller has to decide what to say about them. */
  unanswerable: CodeCriterion[];
  /** The criteria that will not be graded. */
  findings: BindingFinding[];
}

/** Classify every `[code]` criterion in a task file. Three buckets, because the
 *  interesting one is the third and lumping the second into the first is how a
 *  tool ends up promising more than it checked. */
export function auditCodeCriteria(markdown: string): BindingAudit {
  const audit: BindingAudit = { bound: 0, unanswerable: [], findings: [] };
  for (const criterion of readCodeCriteria(markdown)) {
    const binding = bindCriterion(criterion);
    if (binding.kind === "bound") audit.bound += 1;
    else if (binding.kind === "no-vocabulary") audit.unanswerable.push(criterion);
    else audit.findings.push({ criterion, binding });
  }
  return audit;
}

/** The author-facing report, one block per finding. Names the file so it stands
 *  on its own in a scrollback that already carries a write summary, and echoes
 *  each sentence verbatim so the author can find the line. */
export function formatBindingReport(findings: BindingFinding[], file: string): string {
  const count = findings.length;
  const blocks = findings.flatMap(({ criterion, binding }) => [
    `    - ${criterion.marker} ${criterion.text}`,
    ...(binding.kind === "unbound"
      ? [
          `      Binds nothing ${criterion.twin} declares, so the grader skips it and`,
          `      the score is computed without it.`,
        ]
      : [
          `      Says ${binding.checkId}, but \`${binding.slot}\` = ${JSON.stringify(binding.value)} is not a valid`,
          `      value for that slot (e.g. ${binding.example}). It will be reported as`,
          `      corrupted_check_instance:${binding.checkId}.`,
        ]),
    "",
  ]);
  const twins = [...new Set(findings.map((f) => f.criterion.twin))].sort();
  return [
    `⚠ ${file} — ${count} [code] ${count === 1 ? "criterion" : "criteria"} will not be graded:`,
    "",
    ...blocks,
    `  Run ${twins.map((t) => `\`pome checks ${t}\``).join(", ")} to see the sentences that do bind,`,
    `  then \`pome checks add\` to write one — pome renders the English, so a`,
    `  criterion it wrote cannot fail to bind.`,
  ].join("\n");
}
