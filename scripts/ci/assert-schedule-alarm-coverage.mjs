#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1471 — the guard that keeps F-1230's alarm coverage true. F-1230 wired
// every scheduled workflow that exists TODAY to the reusable alarm; nothing
// stopped a thirteenth from landing next month with no alarm at all, and
// nothing stopped a wired-but-broken alarm (a typo'd `uses:` target, a
// title/label pair that disagrees with itself, a job neutralised by
// `continue-on-error: true` or a dead `if:`) from passing review looking
// correct. This is a PROPERTY check, not a list of which workflows have
// alarms — that list is the same shape as the bug it exists to catch.
//
// Left side (which workflows must reach the alarm) is read from
// list-scheduled-workflows.mjs's own derivation, never re-parsed here; that
// file already asserts its own non-zero floor and its own two-independent-
// reads cross-check, so this file inherits both for free by calling it
// rather than copying its rules.
//
// Right side (does a given workflow reach the alarm) parses PER JOB BLOCK,
// anchored on both ends by indentation, rather than grepping lines — a
// grep-based version of this exact check was defeated three separate times
// during F-1230's own review, by a commented-out step, a
// `continue-on-error: true`, and a step-level `if:`. Comments are already
// stripped before any of this runs (list-scheduled-workflows.mjs's
// workflowLines()), so a commented-out job simply is not there to find.
//
// Usage: node scripts/ci/assert-schedule-alarm-coverage.mjs
// Exits 1, naming every offending workflow/job, on:
//   - a scheduled workflow with no job reaching the alarm's failure leg
//   - a schedule-alarm.yml call missing its required title or label
//   - a title reused with more than one label, or a label reused with more
//     than one title, anywhere in the tree
//   - zero scheduled workflows discovered (a parser regression, not a
//     true fact about the tree — inherited from list-scheduled-workflows.mjs)

import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findScheduledWorkflows,
  workflowLines,
  // list-scheduled-workflows.mjs's own entry point, not just its derivation
  // helper: calling it is what makes "this check inherits that file's floors"
  // TRUE rather than a claim. It throws on zero scheduled workflows, on its
  // two independent reads (`on: schedule:` vs `cron:`) disagreeing, and on any
  // `uses: ./.github/workflows/…` pointing at an absent file — so dropping its
  // separate ci.yml step can no longer quietly retire those three floors.
  main as assertScheduledWorkflowDerivation,
} from "./list-scheduled-workflows.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REUSABLE_ALARM_FILE = "schedule-alarm.yml";

/**
 * The [start, end) line-index range of the block nested under the key at
 * `keyIndex` — every following line whose indent is strictly greater than
 * the key line's own indent, stopping at the first non-blank line whose
 * indent is less than or equal to it (or EOF). Works uniformly for a mapping
 * key (`with:`) and a block-scalar key (`if: >-`): in both cases the
 * "children" are just "more indented than me".
 */
function blockRange(lines, keyIndex) {
  const keyIndent = /^\s*/.exec(lines[keyIndex])[0].length;
  let end = keyIndex + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== "") {
      const indent = /^\s*/.exec(line)[0].length;
      if (indent <= keyIndent) break;
    }
    end++;
  }
  return [keyIndex + 1, end];
}

/**
 * Indices, within [start, end), of lines at the MINIMUM indent seen in the
 * range — i.e. the direct children of whatever block this range is. Anchors
 * the same way list-scheduled-workflows.mjs's `on:` walk does, so a
 * step-level `if:` (deeper than the job's own keys) or a `with:` sub-key
 * (deeper than the job's own `uses:`) is never mistaken for a job-level key.
 */
function directChildLines(lines, start, end) {
  let minIndent = null;
  for (let i = start; i < end; i++) {
    if (lines[i].trim() === "") continue;
    const indent = /^\s*/.exec(lines[i])[0].length;
    if (minIndent === null || indent < minIndent) minIndent = indent;
  }
  if (minIndent === null) return [];
  const out = [];
  for (let i = start; i < end; i++) {
    if (lines[i].trim() === "") continue;
    if (/^\s*/.exec(lines[i])[0].length === minIndent) out.push(i);
  }
  return out;
}

/** Strip a single layer of matching quotes and surrounding whitespace. */
function unquote(value) {
  const trimmed = value.trim();
  const m = /^["'](.*)["']$/.exec(trimmed);
  return m ? m[1] : trimmed;
}

/**
 * `needs:` in all three shapes GitHub accepts — scalar (`needs: main`), flow
 * sequence (`needs: [a, b]`) and block sequence (`needs:` then `- a`).
 */
function parseNeeds(lines, keyIdx, inline) {
  if (inline !== "") {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => unquote(s))
      .filter(Boolean);
  }
  const [s, e] = blockRange(lines, keyIdx);
  return lines
    .slice(s, e)
    .map((l) => /^\s*-\s*(.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => unquote(m[1]))
    .filter(Boolean);
}

/**
 * Every job in one workflow file, as the job-level facts this check reasons
 * about. Parsed PER JOB BLOCK, anchored on indentation at both ends: job-level
 * keys are read only at the job's own minimum indent, so a step-level `if:`
 * (deeper) can never be mistaken for the job-level one gating an alarm call.
 */
function parseJobs(lines) {
  const jobsKey = lines.findIndex((l) => /^(?:jobs|["']jobs["']):\s*$/.test(l));
  if (jobsKey === -1) return [];
  const [jobsStart, jobsEnd] = blockRange(lines, jobsKey);
  const jobs = [];
  for (const jobKeyIdx of directChildLines(lines, jobsStart, jobsEnd)) {
    const jobIdMatch = /^\s*([\w.-]+|["'][^"']+["']):\s*$/.exec(lines[jobKeyIdx]);
    if (!jobIdMatch) continue; // a job entry is always a bare mapping key
    const jobId = unquote(jobIdMatch[1]);
    const [jobStart, jobEnd] = blockRange(lines, jobKeyIdx);

    let usesTarget = null;
    let ifExpr = null;
    let continueOnError = null;
    let needs = [];
    let title = null;
    let label = null;
    let outcome = null;

    for (const kIdx of directChildLines(lines, jobStart, jobEnd)) {
      const line = lines[kIdx];
      let m;
      if ((m = /^\s*uses:\s*["']?([^"'\s]+)["']?\s*$/.exec(line))) {
        usesTarget = m[1];
      } else if ((m = /^\s*if:\s*(.*)$/.exec(line))) {
        const inline = m[1].trim();
        if (inline === "" || /^[|>][-+]?\s*$/.test(inline)) {
          // Block scalar (`if: >-` / `if: |`) or a value on the next
          // line — join every deeper-indented continuation line.
          const [s, e] = blockRange(lines, kIdx);
          ifExpr = lines
            .slice(s, e)
            .map((l) => l.trim())
            .filter(Boolean)
            .join(" ");
        } else {
          ifExpr = unquote(inline);
        }
      } else if ((m = /^\s*continue-on-error:\s*(.+)$/.exec(line))) {
        continueOnError = unquote(m[1]);
      } else if ((m = /^\s*needs:\s*(.*)$/.exec(line))) {
        needs = parseNeeds(lines, kIdx, m[1].trim());
      } else if ((m = /^\s*with:\s*(.*)$/.exec(line))) {
        // Both spellings of the same mapping. `with:` alone on its line opens
        // a block; `with: {title: …, outcome: failure}` is flow form, which an
        // earlier revision of this file did not recognise at all — it parsed
        // as no inputs, so a CORRECTLY covered workflow was reported both
        // uncovered and missing its inputs. A guard that reds on right answers
        // is a guard someone deletes.
        const inline = m[1].trim();
        const found = inline
          ? [...inline.matchAll(/\b(title|label|outcome)\s*:\s*("[^"]*"|'[^']*'|[^,}]+)/g)].map((f) => [f[1], f[2]])
          : directChildLines(lines, ...blockRange(lines, kIdx))
              .map((wIdx) => /^\s*(title|label|outcome):\s*(.+)$/.exec(lines[wIdx]))
              .filter(Boolean)
              .map((f) => [f[1], f[2]]);
        for (const [key, raw] of found) {
          const value = unquote(raw);
          if (key === "title") title = value;
          else if (key === "label") label = value;
          else outcome = value;
        }
      }
    }

    jobs.push({ job: jobId, usesTarget, ifExpr, continueOnError, needs, title, label, outcome });
  }
  return jobs;
}

/**
 * Every job, in every workflow file, that calls the reusable schedule-alarm
 * workflow — resolved by PATH, not by string equality with the literal
 * `uses:` text, so `./.github/workflows/schedule-alarm.yml` and any other
 * spelling that resolves to the same file both count, and a typo'd path that
 * resolves to nothing or to a DIFFERENT file does not.
 */
export function findScheduleAlarmCalls(root) {
  const alarmPath = resolve(root, ".github", "workflows", REUSABLE_ALARM_FILE);
  const calls = [];
  for (const [file, lines] of workflowLines(root)) {
    for (const job of parseJobs(lines)) {
      if (!job.usesTarget || resolve(root, job.usesTarget) !== alarmPath) continue;
      calls.push({ file, ...job });
    }
  }
  return calls;
}

/** `false`, in any casing, with nothing else in the expression. */
function isTriviallyFalse(ifExpr) {
  return ifExpr !== null && /^false$/i.test(ifExpr.trim());
}

/**
 * A call counts as reaching the alarm's FAILURE leg — the half that must
 * exist for every scheduled workflow — only if it is not neutralised. Three
 * independent ways a wired-looking call is dead in production, each one a
 * real defect this milestone hit once already (see this file's header):
 * `continue-on-error: true` swallows the reusable call's own failure so a
 * broken alarm still reports green; a literal `if: false` means the job
 * never runs at all; and `outcome` has to be the literal string `failure` —
 * a call that only ever passes `success` (a recovery job with no failure
 * sibling) is not covering the failure path either.
 */
function reachesFailureAlarm(call) {
  if (call.continueOnError !== null && /^true$/i.test(call.continueOnError)) return false;
  if (isTriviallyFalse(call.ifExpr)) return false;
  return call.outcome === "failure";
}

export function findMissingAlarmCoverage(root, calls) {
  const scheduled = findScheduledWorkflows(root).filter((f) => f !== REUSABLE_ALARM_FILE);
  const byFile = new Map();
  for (const call of calls) {
    if (!byFile.has(call.file)) byFile.set(call.file, []);
    byFile.get(call.file).push(call);
  }
  return scheduled.filter((file) => !(byFile.get(file) ?? []).some(reachesFailureAlarm));
}

/**
 * Work jobs a scheduled workflow's failure alarm cannot see.
 *
 * `failure()` in a job-level `if:` is scoped to that job's own dependency
 * graph, not to the run as a whole: an alarm job that `needs:` only ONE of a
 * workflow's jobs is skipped when a SIBLING it does not depend on fails, so
 * that failure files nothing. This is the same "present in the diff, present
 * in review, dead in production" class as `continue-on-error: true` and a
 * literal `if: false`, and it is what copy-pasting repo-policy.yml's
 * `needs: assert` into a workflow that later grows a second job produces.
 *
 * Closure is TRANSITIVE, so a legitimate chain (`alarm` needs `b` needs `a`)
 * counts — requiring every work job to be listed directly would red correct
 * work. Only the failure leg is held to this; a recovery job intentionally
 * watches whatever it is gated on.
 */
export function findAlarmNeedsGaps(root) {
  const alarmPath = resolve(root, ".github", "workflows", REUSABLE_ALARM_FILE);
  const scheduled = new Set(findScheduledWorkflows(root).filter((f) => f !== REUSABLE_ALARM_FILE));
  const gaps = [];
  for (const [file, lines] of workflowLines(root)) {
    if (!scheduled.has(file)) continue;
    const jobs = parseJobs(lines);
    const isAlarm = (j) => j.usesTarget && resolve(root, j.usesTarget) === alarmPath;
    const workJobs = jobs.filter((j) => !isAlarm(j)).map((j) => j.job);
    const byId = new Map(jobs.map((j) => [j.job, j]));
    for (const call of jobs.filter((j) => isAlarm(j) && reachesFailureAlarm({ ...j, file }))) {
      const seen = new Set();
      const queue = [...call.needs];
      while (queue.length > 0) {
        const next = queue.pop();
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(...(byId.get(next)?.needs ?? []));
      }
      const unseen = workJobs.filter((j) => !seen.has(j));
      if (unseen.length > 0) gaps.push({ file, job: call.job, unseen });
    }
  }
  return gaps;
}

/** Every schedule-alarm call missing a required `title` or `label` input. */
export function findMissingAlarmInputs(calls) {
  return calls.filter((c) => !c.title || !c.label);
}

/**
 * The title/label pair is typed twice per alarm — once on the failure-side
 * job, once on the recovery job — with nothing gating that the two calls
 * agree. A mismatch means the alarm FILES under one key and the recovery job
 * LOOKS UP a different one, so it never closes and opens a fresh issue every
 * run instead. Derived from the calls themselves (a title <-> label
 * bijection across the whole tree), never a restated pairing: any title
 * that maps to more than one label, or label that maps to more than one
 * title, is reported.
 */
export function findTitleLabelMismatches(calls) {
  const byTitle = new Map();
  const byLabel = new Map();
  for (const c of calls) {
    if (!c.title || !c.label) continue; // reported separately by findMissingAlarmInputs
    if (!byTitle.has(c.title)) byTitle.set(c.title, new Set());
    byTitle.get(c.title).add(c.label);
    if (!byLabel.has(c.label)) byLabel.set(c.label, new Set());
    byLabel.get(c.label).add(c.title);
  }
  const badTitles = new Set([...byTitle].filter(([, labels]) => labels.size > 1).map(([t]) => t));
  const badLabels = new Set([...byLabel].filter(([, titles]) => titles.size > 1).map(([l]) => l));
  if (badTitles.size === 0 && badLabels.size === 0) return [];
  return calls.filter((c) => badTitles.has(c.title) || badLabels.has(c.label));
}

export function main() {
  const root = resolve(HERE, "../..");

  // Inherited floors, actually inherited: this calls list-scheduled-workflows'
  // OWN entry point, which throws on zero scheduled workflows, on its two
  // independent reads (`on: schedule:` vs `cron:`) disagreeing, and on a
  // `uses: ./.github/workflows/…` target that is absent. Re-implementing only
  // the zero check here (an earlier revision) meant the set-equality floor was
  // claimed but not held: retiring ci.yml's separate step would have silently
  // taken it with it.
  const scheduled = assertScheduledWorkflowDerivation([]);

  // Belt-and-braces on the count this check itself reasons about: the floor
  // above counts every scheduled workflow, while coverage is asserted over the
  // set with the reusable alarm file excluded. If those two ever differ down to
  // zero, the pass below would be vacuous.
  const covered = scheduled.filter((f) => f !== REUSABLE_ALARM_FILE);
  if (covered.length === 0) {
    throw new Error(
      "every scheduled workflow discovered is the reusable alarm itself — " +
        "refusing to report a pass on an alarm-coverage check that examined " +
        "no callers.",
    );
  }

  const calls = findScheduleAlarmCalls(root);
  const missing = findMissingAlarmCoverage(root, calls);
  const missingInputs = findMissingAlarmInputs(calls);
  const mismatches = findTitleLabelMismatches(calls);
  const needsGaps = findAlarmNeedsGaps(root);

  const problems = [];
  if (missing.length > 0) {
    problems.push(
      "workflow(s) with a schedule: trigger and no job reaching the alarm's " +
        "failure leg (a job calling ./.github/workflows/schedule-alarm.yml " +
        "with outcome: failure, not neutralised by continue-on-error: true " +
        `or a false if:):\n  ${missing.join("\n  ")}`,
    );
  }
  if (missingInputs.length > 0) {
    problems.push(
      "schedule-alarm.yml call(s) missing a required title or label:\n  " +
        missingInputs.map((c) => `${c.file}:${c.job} (title=${c.title ?? "MISSING"}, label=${c.label ?? "MISSING"})`).join("\n  "),
    );
  }
  if (mismatches.length > 0) {
    problems.push(
      "title/label pair disagrees between two calls to the same alarm — one " +
        "will file under a key the other cannot look up, so it never " +
        "closes and opens a fresh issue every run:\n  " +
        mismatches.map((c) => `${c.file}:${c.job} title="${c.title}" label="${c.label}"`).join("\n  "),
    );
  }

  if (needsGaps.length > 0) {
    problems.push(
      "a failure alarm cannot see job(s) it does not depend on — failure() is " +
        "scoped to the alarm job's own needs: graph, so a sibling failing " +
        "SKIPS the alarm and files nothing:\n  " +
        needsGaps.map((g) => `${g.file}:${g.job} does not (transitively) need ${g.unseen.join(", ")}`).join("\n  "),
    );
  }

  if (problems.length > 0) {
    throw new Error(problems.join("\n\n"));
  }

  console.log(`schedule-alarm coverage OK: ${covered.length} scheduled workflow(s) all reach the alarm's failure leg, which needs every job in its own workflow; no title/label disagreement.`);
}

// Realpath'd on BOTH sides, not `import.meta.main` (Node 24.2+; this repo's
// `engines` allows >=24, so on an earlier 24.x it is `undefined` and the
// bare form would silently exit 0 having checked nothing). A guard that
// looks like it should have fired but did not throws rather than running
// nothing quietly.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && basename(ENTRY) === basename(SELF)) {
  throw new Error(
    `assert-schedule-alarm-coverage.mjs entry guard did not fire for ${ENTRY} (expected ${SELF}) — refusing to exit 0 having checked nothing`,
  );
}

if (invokedDirectly) main();
