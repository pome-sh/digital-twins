// SPDX-License-Identifier: Apache-2.0
//
// Assembles the paste-into-IDE fix prompt for a failed run (FDRS-657).
//
// CAPTURE-ONLY: the OSS CLI does NOT call an LLM here. `pome fix-prompt`
// assembles a self-contained prompt — system instructions + the task's
// criteria + the raw captured trace — and prints it so the developer can paste
// it into THEIR own coding assistant (Cursor / Claude Code). The former BYOK
// local-judge call that generated the handoff CLI-side was removed under
// FDRS-657 (no local LLM/judge anywhere in the OSS CLI). This module was also
// relocated out of the deleted `src/evaluator/` tree.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetPath } from "../cli/assets.js";
import type { CriterionResult, RecorderEvent } from "../types/shared.js";
import type { Criterion, Task } from "../task/taskSchema.js";
import { redactEvent, redactSecrets } from "../recorder/redaction.js";
import { isPreSatisfied, outcomeOf } from "../hosted/evalResultView.js";
import type { VerdictArtifact } from "../hosted/evalResultCache.js";

export const FIX_PROMPT_TEMPLATE_VERSION = "v1";

const MAX_EVENTS = 50;
const BODY_CHAR_LIMIT = 800;

function loadSystemPrompt(): string {
  // `assets/fix-prompt/prompts/fix-prompt-v1.md` at the package root in every
  // layout — see src/cli/assets.ts for why this is not resolved relative to
  // this module.
  return readFileSync(
    assetPath("fix-prompt", "prompts", `fix-prompt-${FIX_PROMPT_TEMPLATE_VERSION}.md`),
    "utf8",
  );
}

export const FIX_PROMPT_SYSTEM_PROMPT = loadSystemPrompt();

export function escapeTagContent(text: string): string {
  return text.replace(/[&<>]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return char;
    }
  });
}

export interface FixPromptContext {
  events: RecorderEvent[];
  task: Task;
}

function truncateBody(body: unknown): unknown {
  if (body === undefined || body === null) return body;
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return "[unserializable]";
  }
  if (serialized.length <= BODY_CHAR_LIMIT) return body;
  return `${serialized.slice(0, BODY_CHAR_LIMIT)}…`;
}

function renderEvent(e: RecorderEvent): string {
  return JSON.stringify({
    twin: e.twin,
    method: e.method,
    path: e.path,
    status: e.status,
    latency_ms: e.latency_ms,
    step_id: e.step_id,
    request_body: truncateBody(e.request_body),
    response_body: truncateBody(e.response_body),
    state_delta: e.state_delta,
  });
}

function renderEvents(events: RecorderEvent[]): string {
  const kept = events.slice(0, MAX_EVENTS);
  const lines = kept.map(renderEvent);
  if (events.length > MAX_EVENTS) {
    lines.push(`(${events.length - MAX_EVENTS} more omitted — kept first ${MAX_EVENTS})`);
  }
  return lines.join("\n");
}

// The OSS CLI holds NO local verdict (evaluation is cloud-only), so the prompt
// lists every criterion the run had to satisfy and lets the developer's own
// assistant diagnose against the trace. No pass/fail is claimed here.
function renderCriteria(criteria: Criterion[]): string {
  if (criteria.length === 0) return "(no criteria declared)";
  return criteria
    .map((c, idx) => `${idx + 1}. [${c.type}] ${c.text}`)
    .join("\n");
}

export function buildFixUserPrompt(ctx: FixPromptContext): string {
  const criteria = redactSecrets(renderCriteria(ctx.task.criteria)) as string;
  const trace = renderEvents(ctx.events.map((event) => redactEvent(event)));
  const taskTitle = redactSecrets(ctx.task.title) as string;
  const taskPrompt = redactSecrets(ctx.task.prompt) as string;

  return `## Task
${taskTitle}

## Task prompt (what the agent was told to do)
${taskPrompt}

## Criteria the run had to satisfy
${escapeTagContent(criteria)}

## Trace (HTTP calls the agent made)
<agent-trace>
${escapeTagContent(trace)}
</agent-trace>`;
}

// ── FDRS-644: run-set mode ──────────────────────────────────────────────
//
// One prompt for a whole trial group, built from persisted CLOUD verdicts
// (verdict.json — provenance-labeled /finalize payloads, still no local
// scoring) + the raw traces. The judge's per-criterion reasons become
// GROUPED failure signatures; one representative trace keeps the prompt
// bounded (the others are named by path for the developer's own digging).

export interface TrialFixInput {
  /** Terminal-facing label, e.g. "trial 2 · ses_abc123". */
  label: string;
  /** The trial's artifacts dir (for naming non-representative traces). */
  runDir: string;
  verdict: VerdictArtifact;
  events: RecorderEvent[];
}

export interface GroupFixPromptContext {
  taskName: string;
  groupId: string | null;
  /** Parsed task file when it still resolves. Null degrades the prompt to
   *  the verdict-embedded criteria (the file may have moved since the run). */
  task: Task | null;
  /** Completed trials of the run set (verdict.json present), run order. */
  trials: TrialFixInput[];
}

function criterionMarker(c: CriterionResult["criterion"]): string {
  return `[${c.type}]`;
}

function failedResults(verdict: VerdictArtifact): CriterionResult[] {
  return verdict.criteria_results.filter((r) => outcomeOf(r) === "failed");
}

/** F-1404 — a trial whose grading FINISHED: the only kind whose pass/fail
 *  this prompt may count. A trial's `state` is `"incomplete"` whenever the
 *  grader never reached some criterion (`scoreStatus`'s A5 guard), and such a
 *  trial is neither a pass nor a failure — it belongs in no numerator and no
 *  denominator here. Read off `state`, the same field `groupRunSets` routes
 *  on, so the routing decision and this prompt cannot disagree about which
 *  trials were graded.
 *
 *  This is why the partition below is NOT `verdict.passed`: `passed` is false
 *  for a graded failure and for an ungraded trial alike, which listed an
 *  ungraded trial under "Other failing trials" and counted it as a non-pass
 *  in a fraction labelled "completed trials". Both stated more than the
 *  artifact checked. */
function isGraded(t: TrialFixInput): boolean {
  return t.verdict.state !== "incomplete";
}

/** Criteria the grader never reached in this trial — neither graded pass nor
 *  graded failure, and not a seed exclusion (which IS a verdict). */
function ungradedCount(verdict: VerdictArtifact): number {
  return verdict.criteria_results.filter(
    (r) =>
      !isPreSatisfied(r) &&
      outcomeOf(r) !== "passed" &&
      outcomeOf(r) !== "failed",
  ).length;
}

/** Judge reasons and criterion text are DATA rendered into prompt prose —
 *  flatten to one line so a crafted (or just verbose) string can never open
 *  a new markdown heading/section inside the prompt structure. */
function flattenLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Per-criterion failure signatures across the run set: criterion text →
 *  which trials failed it and what the judge said, failing-first. Criteria
 *  that never failed split honestly: "passed everywhere" requires every
 *  outcome to actually be `passed` — skipped/errored are named as such,
 *  never counted as passes.
 *
 *  F-1392 — a criterion the seed already satisfied is `skipped` on the wire
 *  and used to land in "not uniformly evaluated", which sends the reader's
 *  coding agent hunting for a grader gap that does not exist. It is its own
 *  class here, for the same reason it is its own count in `Score`: the grader
 *  reached a verdict, and the verdict is that the criterion was never at
 *  risk. `isPreSatisfied` is the shared predicate, not a second reading of
 *  the reason string. */
function renderGroupedSignatures(trials: TrialFixInput[]): string {
  const byCriterion = new Map<
    string,
    { marker: string; hits: Array<{ label: string; reason: string }> }
  >();
  // Criterion text → the set of outcome classes seen for it. "excluded" is a
  // class here and not in `outcomeOf` (the per-criterion marker stays `-`,
  // F-1392's trap): this map exists to decide which NOTE a criterion belongs
  // under, and "the seed already satisfied it" is a different note from "the
  // grader never reached it".
  const outcomesSeen = new Map<string, Set<string>>();
  // F-1404 — per-criterion denominator: how many trials actually GRADED this
  // criterion (reached a pass or a fail on it). The old denominator was
  // `trials.length`, which counted trials that never graded the criterion at
  // all — and once a set may hold an INCOMPLETE trial, a criterion can be
  // failed in more trials than that count admits, printing "failed in 2 of 1".
  const gradedFor = new Map<string, number>();
  for (const trial of trials) {
    for (const result of trial.verdict.criteria_results) {
      const key = result.criterion.text;
      const outcome = isPreSatisfied(result) ? "excluded" : outcomeOf(result);
      if (outcome === "passed" || outcome === "failed") {
        gradedFor.set(key, (gradedFor.get(key) ?? 0) + 1);
      }
      if (outcome === "failed") {
        const entry = byCriterion.get(key) ?? {
          marker: criterionMarker(result.criterion),
          hits: [],
        };
        entry.hits.push({ label: trial.label, reason: result.reason });
        byCriterion.set(key, entry);
      }
      const seen = outcomesSeen.get(key) ?? new Set<string>();
      seen.add(outcome);
      outcomesSeen.set(key, seen);
    }
  }

  const passedEverywhere: string[] = [];
  const preSatisfiedEverywhere: string[] = [];
  const notUniformlyEvaluated: string[] = [];
  for (const [key, seen] of outcomesSeen) {
    if (byCriterion.has(key)) continue;
    if (seen.size === 1 && seen.has("passed")) passedEverywhere.push(key);
    else if (seen.size === 1 && seen.has("excluded")) preSatisfiedEverywhere.push(key);
    else notUniformlyEvaluated.push(key);
  }

  const blocks = [...byCriterion.entries()]
    .sort((a, b) => b[1].hits.length - a[1].hits.length)
    .map(([text, { marker, hits }], idx) => {
      const lines = hits.map(
        (h) => `   - ${h.label}: ${flattenLine(h.reason)}`,
      );
      const graded = gradedFor.get(text) ?? hits.length;
      return `${idx + 1}. ${marker} ${flattenLine(text)} — failed in ${hits.length} of ${graded} trials that graded it\n${lines.join("\n")}`;
    });
  if (
    blocks.length === 0 &&
    passedEverywhere.length === 0 &&
    preSatisfiedEverywhere.length === 0 &&
    notUniformlyEvaluated.length === 0
  ) {
    return "(no criteria recorded)";
  }
  const notes: string[] = [];
  if (blocks.length === 0) {
    notes.push("(no criterion failed in any completed trial)");
  }
  if (passedEverywhere.length > 0) {
    notes.push(
      `passed in every completed trial: ${passedEverywhere.map((t) => `"${flattenLine(t)}"`).join(" · ")}`,
    );
  }
  if (preSatisfiedEverywhere.length > 0) {
    notes.push(
      `already true in the seed in every completed trial — excluded from the score, nothing here to fix: ${preSatisfiedEverywhere.map((t) => `"${flattenLine(t)}"`).join(" · ")}`,
    );
  }
  if (notUniformlyEvaluated.length > 0) {
    // "not evaluated", not "skipped or errored": a criterion that mixes a
    // seed exclusion with a real pass across trials lands here too, and the
    // old parenthetical asserted an instrument gap that may not have
    // happened.
    notes.push(
      `not uniformly evaluated (not evaluated in some trials — no pass is claimed for these): ${notUniformlyEvaluated.map((t) => `"${flattenLine(t)}"`).join(" · ")}`,
    );
  }
  return [...blocks, ...notes].join("\n");
}

/** The failing trial with the most failed criteria — the representative
 *  whose full trace anchors the prompt.
 *
 *  F-1404 — `state === "fail"`, not `!passed`: an INCOMPLETE trial is not a
 *  failing one, and anchoring the prompt's one trace on it under the heading
 *  "the most-failing trial" asserted a failure the grading never reached. */
export function representativeFailingTrial(
  trials: TrialFixInput[],
): TrialFixInput | null {
  const failing = trials.filter((t) => t.verdict.state === "fail");
  if (failing.length === 0) return null;
  return failing.reduce((worst, t) =>
    failedResults(t.verdict).length > failedResults(worst.verdict).length
      ? t
      : worst,
  );
}

export function buildGroupFixUserPrompt(ctx: GroupFixPromptContext): string {
  // F-1404 — every fraction below is over GRADED trials only. An INCOMPLETE
  // trial gets its own named section instead of being counted as a non-pass
  // in a denominator labelled "completed".
  const incomplete = ctx.trials.filter((t) => !isGraded(t));
  const completed = ctx.trials.length - incomplete.length;
  const passed = ctx.trials.filter((t) => t.verdict.state === "pass").length;
  const representative = representativeFailingTrial(ctx.trials);
  const otherFailing = ctx.trials.filter(
    (t) => t.verdict.state === "fail" && t !== representative,
  );

  const signatures = redactSecrets(
    renderGroupedSignatures(ctx.trials),
  ) as string;
  const criteriaBlock = ctx.task
    ? (redactSecrets(renderCriteria(ctx.task.criteria)) as string)
    : (redactSecrets(
        renderCriteria(
          (ctx.trials[0]?.verdict.criteria_results ?? []).map((r) => ({
            type: r.criterion.type,
            text: r.criterion.text,
          })) as Criterion[],
        ),
      ) as string);
  const promptBlock = ctx.task
    ? (redactSecrets(ctx.task.prompt) as string)
    : `(task file not found at ${ctx.trials[0]?.verdict.task_path ?? "?"} — criteria above come from the cloud verdicts)`;

  // "0 of 0 completed trials passed" would be a fraction over an empty
  // denominator — the A5 sin this milestone exists to remove. Name the state
  // instead. (Reachable: `pome fix-prompt <trial-dir>` deliberately targets
  // the trial the user pointed at whatever its outcome.)
  const tally =
    completed === 0
      ? "no trial in this set was graded end to end"
      : `${passed} of ${completed} completed trials passed`;
  const gapNote =
    incomplete.length > 0
      ? ` · ${incomplete.length} INCOMPLETE (counted in nothing below — see the last section)`
      : "";

  const sections: string[] = [];
  sections.push(`## Run set (cloud-judged)
task ${redactSecrets(ctx.taskName) as string} · ${
    ctx.groupId ? `group ${ctx.groupId}` : "single run"
  } · ${tally}${gapNote}`);

  sections.push(`## Grouped failure signatures (from the cloud judge)
${escapeTagContent(signatures)}`);

  sections.push(`## Task prompt (what the agent was told to do)
${promptBlock}`);

  sections.push(`## Criteria the run had to satisfy
${escapeTagContent(criteriaBlock)}`);

  if (representative) {
    const trace = renderEvents(
      representative.events.map((event) => redactEvent(event)),
    );
    sections.push(`## Trace of the most-failing trial (${representative.label})
<agent-trace>
${escapeTagContent(trace)}
</agent-trace>`);
  }

  if (otherFailing.length > 0) {
    const lines = otherFailing.map((t) => {
      const failed = failedResults(t.verdict)
        .map((r) => criterionPhraseSafe(r.criterion.text))
        .join(" · ");
      return `- ${t.label} — failed: ${failed || "(see verdict)"} — trace at ${join(t.runDir, "events.jsonl")}`;
    });
    sections.push(`## Other failing trials (traces on disk)
${escapeTagContent(redactSecrets(lines.join("\n")) as string)}`);
  }

  // F-1404 — the gap, named, as the LAST thing the reading agent sees before
  // it starts work. The prompt is allowed to be built over a set holding an
  // ungraded trial (a genuine failure alongside it, or a trial dir the user
  // pointed at directly); it is not allowed to let that trial read as
  // evidence. Nothing above counts these, and this says so.
  if (incomplete.length > 0) {
    const lines = incomplete.map(
      (t) =>
        `- ${t.label} — ${ungradedCount(t.verdict)} criterion(s) never graded — trace at ${join(t.runDir, "events.jsonl")}`,
    );
    sections.push(`## Trials the grader never finished (INCOMPLETE)
The grader never reached every criterion in these trials, so they are neither
passes nor failures and are counted in no fraction above. Do NOT treat them as
evidence for or against any fix: a criterion that never ran is a grader or seed
gap, not something the agent did wrong.
${escapeTagContent(redactSecrets(lines.join("\n")) as string)}`);
  }

  if (passed > 0 && passed < completed) {
    sections.push(`## Variance note
${passed} of ${completed} completed trials passed the same criteria — the failure is variance, not a hard wall. Prefer fixes that remove the variance source (ambiguous instructions, missing determinism) over pattern-matching to one trace.`);
  }

  return sections.join("\n\n");
}

/** Short criterion phrase without pulling in the demo renderer's styling. */
function criterionPhraseSafe(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}
