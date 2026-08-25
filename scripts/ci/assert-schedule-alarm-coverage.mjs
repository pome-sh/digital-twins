#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Every scheduled workflow must reach schedule-alarm.yml's failure leg. Parses
// per job block rather than grepping, because a grep is defeated by a
// commented-out step, a `continue-on-error`, or a step-level `if:`.
//
// Calls list-scheduled-workflows.mjs rather than re-parsing, inheriting its
// floors. Permissions are checked both ways: a caller's grant is a ceiling, so
// dropping `issues: write` from the callee 403s every alarm while every caller
// still looks compliant.

import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findScheduledWorkflows,
  workflowLines,
  main as assertScheduledWorkflowDerivation,
} from "./list-scheduled-workflows.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REUSABLE_ALARM_FILE = "schedule-alarm.yml";
const ALARM_FILER_SCRIPT = "file-schedule-alarm.sh";
const LEVEL = { none: 0, read: 1, write: 2 };

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

function unquote(value) {
  const tagless = value.trim().replace(/^!!\w+\s+/, "");
  if (/^[|>][-+]?$/.test(tagless)) return "";
  const m = /^["'](.*)["']$/.exec(tagless);
  return m ? m[1] : tagless;
}

function unwrapExpression(value) {
  const m = /^\$\{\{(.*)\}\}$/.exec(value.trim());
  return (m ? m[1] : value).trim();
}

function parsePermissionsValue(lines, keyIdx, inline) {
  if (inline !== "") {
    if (inline.startsWith("{")) {
      if (!inline.endsWith("}")) {
        throw new Error(
          `unsupported permissions: shape — a flow mapping that spans lines (${lines[keyIdx].trim()}). ` +
            "Refusing to read it as an empty grant; write it in block form.",
        );
      }
      const inner = inline.replace(/^\{/, "").replace(/\}$/, "").trim();
      const entries = new Map();
      if (inner !== "") {
        for (const m of inner.matchAll(/["']?([\w-]+)["']?\s*:\s*("[^"]*"|'[^']*'|[^,}]+)/g)) {
          entries.set(unquote(m[1]), unquote(m[2]));
        }
      }
      return { kind: "map", entries };
    }
    return { kind: "scalar", value: unquote(inline) };
  }
  const [s, e] = blockRange(lines, keyIdx);
  const entries = new Map();
  for (const idx of directChildLines(lines, s, e)) {
    const m = /^\s*["']?([\w-]+)["']?:\s*(.+)$/.exec(lines[idx]);
    if (m) entries.set(unquote(m[1]), unquote(m[2]));
  }
  return { kind: "map", entries };
}

function grantsScope(perm, scope, level) {
  if (!perm) return false;
  if (perm.kind === "scalar") {
    if (/^write-all$/i.test(perm.value)) return true;
    return /^read-all$/i.test(perm.value) && LEVEL[level] <= LEVEL.read;
  }
  const granted = LEVEL[(perm.entries.get(scope) ?? "none").toLowerCase()] ?? 0;
  return granted >= (LEVEL[level] ?? 0);
}

function parseWorkflowPermissions(lines) {
  const KEY = /^["']?permissions["']?:\s*(.*)$/;
  const idx = lines.findIndex((l) => KEY.test(l));
  if (idx === -1) return null;
  return parsePermissionsValue(lines, idx, KEY.exec(lines[idx])[1].trim());
}

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
    let permissions = null;

    for (const kIdx of directChildLines(lines, jobStart, jobEnd)) {
      const line = lines[kIdx];
      let m;
      if ((m = /^\s*uses:\s*["']?([^"'\s]+)["']?\s*$/.exec(line))) {
        usesTarget = m[1];
      } else if ((m = /^\s*["']?permissions["']?:\s*(.*)$/.exec(line))) {
        permissions = parsePermissionsValue(lines, kIdx, m[1].trim());
      } else if ((m = /^\s*if:\s*(.*)$/.exec(line))) {
        const inline = m[1].trim();
        if (inline === "" || /^[|>][-+]?\s*$/.test(inline)) {
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

    const runsFiler = lines.slice(jobStart, jobEnd).some((l) => l.includes(ALARM_FILER_SCRIPT));

    jobs.push({ job: jobId, usesTarget, ifExpr, continueOnError, needs, title, label, outcome, permissions, runsFiler });
  }
  return jobs;
}

export function findScheduleAlarmCalls(root) {
  const alarmPath = resolve(root, ".github", "workflows", REUSABLE_ALARM_FILE);
  const calls = [];
  for (const [file, lines] of workflowLines(root)) {
    const workflowPermissions = parseWorkflowPermissions(lines);
    for (const job of parseJobs(lines)) {
      if (!job.usesTarget || resolve(root, job.usesTarget) !== alarmPath) continue;
      calls.push({ file, workflowPermissions, ...job });
    }
  }
  return calls;
}

export function findAlarmPermissionGaps(root, calls) {
  const required = alarmRequiredScopes(root);
  const gaps = [];
  for (const call of calls) {
    const effective = call.permissions ?? call.workflowPermissions ?? null;
    if (effective === null) {
      gaps.push({ file: call.file, job: call.job, reason: "absent at both job and workflow level — the effective grant is an unstated repo default" });
      continue;
    }
    const short = [...required].filter(([scope, level]) => !grantsScope(effective, scope, level));
    if (short.length > 0) {
      gaps.push({
        file: call.file,
        job: call.job,
        reason: `resolved permissions do not grant ${short.map(([s, l]) => `${s}: ${l}`).join(", ")}`,
      });
    }
  }
  return gaps;
}

export function alarmRequiredScopes(root) {
  const entry = [...workflowLines(root)].find(([file]) => file === REUSABLE_ALARM_FILE);
  if (!entry) throw new Error(`${REUSABLE_ALARM_FILE} not found under .github/workflows — the reusable alarm every caller resolves against is gone`);
  const [, lines] = entry;
  const workflowPermissions = parseWorkflowPermissions(lines);
  const filers = parseJobs(lines).filter((j) => j.runsFiler);
  if (filers.length === 0) {
    throw new Error(`no job in ${REUSABLE_ALARM_FILE} runs ${ALARM_FILER_SCRIPT} — the alarm files nothing, and there is no job whose permissions callers could be held to`);
  }
  const scopes = new Map();
  for (const job of filers) {
    const effective = job.permissions ?? workflowPermissions ?? null;
    if (effective === null) {
      throw new Error(`${REUSABLE_ALARM_FILE}:${job.job} runs ${ALARM_FILER_SCRIPT} with no permissions: block at either level — the effective grant is an unstated repo default`);
    }
    if (effective.kind === "scalar") {
      throw new Error(`${REUSABLE_ALARM_FILE}:${job.job} uses the shorthand permissions: ${effective.value} — the scope set callers must grant cannot be enumerated from it; write it as a map`);
    }
    if (!grantsScope(effective, "issues", "write")) {
      throw new Error(`${REUSABLE_ALARM_FILE}:${job.job} runs ${ALARM_FILER_SCRIPT} but its own resolved permissions do not grant issues: write — every alarm in the tree 403s at gh issue create no matter what its caller grants`);
    }
    for (const [scope, level] of effective.entries) {
      if ((LEVEL[level.toLowerCase()] ?? 0) > (LEVEL[(scopes.get(scope) ?? "none").toLowerCase()] ?? 0)) scopes.set(scope, level);
    }
  }
  return scopes;
}

function isTriviallyFalse(ifExpr) {
  return ifExpr !== null && /^false$/i.test(unwrapExpression(ifExpr));
}

function reachesFailureAlarm(call) {
  if (call.continueOnError !== null && /^true$/i.test(unwrapExpression(call.continueOnError))) return false;
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

export function findMissingAlarmInputs(calls) {
  return calls.filter((c) => !c.title || !c.label);
}

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

export function findSharedAlarmKeys(calls) {
  const shared = [];
  for (const key of ["label", "title"]) {
    const files = new Map();
    for (const c of calls) {
      if (!c[key]) continue;
      if (!files.has(c[key])) files.set(c[key], new Set());
      files.get(c[key]).add(c.file);
    }
    for (const [value, fileSet] of files) {
      if (fileSet.size > 1) shared.push({ key, value, files: [...fileSet].sort() });
    }
  }
  return shared;
}

export function findUnclosableAlarms(calls) {
  const outcomes = new Map();
  for (const c of calls) {
    if (!c.label) continue;
    if (!outcomes.has(c.label)) outcomes.set(c.label, new Set());
    outcomes.get(c.label).add(c.outcome);
  }
  return [...outcomes]
    .filter(([, o]) => o.has("failure") && !o.has("success"))
    .map(([label]) => label)
    .sort();
}

export function main() {
  const root = resolve(HERE, "../..");

  const scheduled = assertScheduledWorkflowDerivation([]);

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
  const shared = findSharedAlarmKeys(calls);
  const unclosable = findUnclosableAlarms(calls);
  const requiredScopes = alarmRequiredScopes(root);
  const permissionGaps = findAlarmPermissionGaps(root, calls);
  const permissionsResolvedFor = new Set(calls.map((c) => c.file)).size;

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

  if (shared.length > 0) {
    problems.push(
      "two different workflows share one alarm key, so they share one tracking " +
        "issue — the second one's recovery leg CLOSES an alarm the first is " +
        "still failing on:\n  " +
        shared.map((s) => `${s.key}="${s.value}" used by ${s.files.join(" and ")}`).join("\n  "),
    );
  }
  if (unclosable.length > 0) {
    problems.push(
      "alarm label(s) with a failure leg and no recovery leg — the issue is " +
        "filed and then never closes, so it stays open past the fix and stops " +
        "being read:\n  " +
        unclosable.join("\n  "),
    );
  }
  if (permissionGaps.length > 0) {
    problems.push(
      "calling job(s) whose EFFECTIVE permissions (job-level if present, else " +
        "workflow-level, else the unreadable repo default) do not grant every " +
        `scope ${REUSABLE_ALARM_FILE}'s own filing job requests — the alarm ` +
        "exists, runs, and either 403s at gh issue create/close or is refused " +
        "by GitHub before it starts, which nobody reads as anything but a " +
        "green check:\n  " +
        permissionGaps.map((g) => `${g.file}:${g.job} — ${g.reason}`).join("\n  "),
    );
  }

  if (problems.length > 0) {
    throw new Error(problems.join("\n\n"));
  }

  console.log(
    `schedule-alarm coverage OK: ${covered.length} scheduled workflow(s) all reach the alarm's failure leg, which needs every job in its own workflow; no title/label disagreement; permissions resolved for ${permissionsResolvedFor} calling workflow(s), all granting the ${requiredScopes.size} scope(s) ${REUSABLE_ALARM_FILE}'s own filing job requests (${[...requiredScopes].map(([s, l]) => `${s}: ${l}`).join(", ")}).`,
  );
}

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && basename(ENTRY) === basename(SELF)) {
  throw new Error(
    `assert-schedule-alarm-coverage.mjs entry guard did not fire for ${ENTRY} (expected ${SELF}) — refusing to exit 0 having checked nothing`,
  );
}

if (invokedDirectly) main();
