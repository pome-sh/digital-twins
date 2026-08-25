#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The guard that keeps alarm coverage true. A PROPERTY check, not a list of
// which workflows have alarms — that list would be the same shape as the bug it
// exists to catch. What it stops: a new scheduled workflow landing with no
// alarm, and a wired-but-broken alarm (a typo'd `uses:` target, a title/label
// pair that disagrees with itself, a job neutralised by `continue-on-error` or
// a dead `if:`) passing review looking correct.
//
// Left side (which workflows must reach the alarm) is read from
// list-scheduled-workflows.mjs's own derivation, never re-parsed here, so this
// file inherits that file's non-zero floor and its two-independent-reads
// cross-check by calling it rather than copying its rules.
//
// Right side (does a given workflow reach the alarm) parses PER JOB BLOCK,
// anchored on both ends by indentation, rather than grepping lines: a
// grep-based version is defeated by a commented-out step, a
// `continue-on-error: true`, or a step-level `if:`. Comments are already
// stripped before any of this runs, so a commented-out job is not there to
// find.
//
// Usage: node scripts/ci/assert-schedule-alarm-coverage.mjs
// Exits 1, naming every offending workflow/job, on:
//   - a scheduled workflow with no job reaching the alarm's failure leg
//   - a schedule-alarm.yml call missing its required title or label
//   - a title reused with more than one label, or a label reused with more
//     than one title, anywhere in the tree
//   - zero scheduled workflows discovered (a parser regression, not a
//     true fact about the tree — inherited from list-scheduled-workflows.mjs)
//   - a job calling schedule-alarm.yml whose EFFECTIVE permissions (its own
//     job-level `permissions:` if present, else the workflow-level block,
//     else the unreadable repo default) do not grant every scope
//     schedule-alarm.yml's OWN filing job requests — the alarm exists, runs,
//     and either dies with a 403 at `gh issue create` or is refused by
//     GitHub before it starts, which is the exact "fired, failed, told
//     nobody" outcome the alarm exists to prevent.
//   - schedule-alarm.yml's own filing job not resolving `issues: write`. The
//     caller's grant is a CEILING, not the effective set: a reusable
//     workflow's own `permissions:` can only narrow what the caller handed
//     it, so deleting `issues: write` from the callee 403s every alarm in
//     the tree while every caller stays compliant. The required scope set is
//     therefore DERIVED from the callee and floored with an absolute
//     `issues: write` on the callee itself — a pure derivation would let
//     that deletion lower the bar for everyone and pass.

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
  // separate ci.yml step cannot quietly retire those three floors.
  main as assertScheduledWorkflowDerivation,
} from "./list-scheduled-workflows.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REUSABLE_ALARM_FILE = "schedule-alarm.yml";
// The script that actually does the filing. The job that runs it is the one
// whose permissions decide whether an alarm can file, so the required scope
// set is read off THAT job rather than typed here a second time.
const ALARM_FILER_SCRIPT = "file-schedule-alarm.sh";
// GitHub's three access levels, ordered: a `write` grant satisfies a `read`
// requirement, and an omitted scope is `none`.
const LEVEL = { none: 0, read: 1, write: 2 };

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

/**
 * Strip a single layer of matching quotes, an explicit YAML tag (`!!str
 * failure` is the same string as `failure`, and reading it as the literal
 * `"!!str failure"` red a correctly covered workflow) and surrounding
 * whitespace. A bare block-scalar indicator is NOT a value — `title: >-` with
 * the text on following lines captured the literal `">-"`, which is truthy, so
 * garbage passed the required-input check and then collided with every other
 * workflow that did the same. Reported as absent instead.
 */
function unquote(value) {
  const tagless = value.trim().replace(/^!!\w+\s+/, "");
  if (/^[|>][-+]?$/.test(tagless)) return "";
  const m = /^["'](.*)["']$/.exec(tagless);
  return m ? m[1] : tagless;
}

/** `${{ false }}` is the same dead job as `if: false`; unwrap before testing. */
function unwrapExpression(value) {
  const m = /^\$\{\{(.*)\}\}$/.exec(value.trim());
  return (m ? m[1] : value).trim();
}

/**
 * A `permissions:` value, in every shape GitHub Actions accepts: absent
 * (`null`), the shorthand scalars `read-all`/`write-all`, or a mapping
 * (`{kind: "map", entries: Map<string,string>}`) — including the explicit
 * empty mapping `permissions: {}`, which GRANTS NOTHING and is a distinct
 * fact from "unset" even though both read as "no issues: write" below.
 * Parsed the same way `with:` already is (flow map on the same line, or a
 * block of `directChildLines` underneath), because it is the same YAML
 * shape and a second reader of that shape drifting from the first is its
 * own bug.
 */
function parsePermissionsValue(lines, keyIdx, inline) {
  if (inline !== "") {
    if (inline.startsWith("{")) {
      // A flow mapping that SPANS lines is refused, not parsed: stripping a
      // closing brace that is not there yielded an EMPTY grant, so a workflow
      // that really does grant `issues: write` red with "resolved permissions
      // do not grant issues: write" — a guard reddening on a right answer, on
      // a shape GitHub and actionlint both accept. Same stance
      // list-scheduled-workflows.mjs takes for a multi-line `on:` mapping: an
      // unsupported shape must never be indistinguishable from a parsed one.
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
    // Quoted keys accepted for the same reason `["']jobs["']` is below: this
    // repo's yamllint truthy workaround produces them, and reading
    // `"issues": write` as absent reds a workflow that grants the scope.
    const m = /^\s*["']?([\w-]+)["']?:\s*(.+)$/.exec(lines[idx]);
    if (m) entries.set(unquote(m[1]), unquote(m[2]));
  }
  return { kind: "map", entries };
}

/**
 * Does a resolved `permissions:` value grant at least `level` on `scope`?
 * `write-all` grants everything, `read-all` grants every read, a mapping
 * grants what it lists (and `write` satisfies a `read` requirement, the way
 * GitHub's own levels nest). `null` (nothing to resolve — see
 * findAlarmPermissionGaps below) is handled by the caller, not here, because
 * "absent" and "present but insufficient" are different failures this check
 * reports differently.
 */
function grantsScope(perm, scope, level) {
  if (!perm) return false;
  if (perm.kind === "scalar") {
    if (/^write-all$/i.test(perm.value)) return true;
    return /^read-all$/i.test(perm.value) && LEVEL[level] <= LEVEL.read;
  }
  const granted = LEVEL[(perm.entries.get(scope) ?? "none").toLowerCase()] ?? 0;
  return granted >= (LEVEL[level] ?? 0);
}

/**
 * The workflow-level `permissions:` block — the top-level key, never a
 * nested one (a job-level or `with:`-level key of the same name is a
 * different fact) — or `null` if the file has none.
 */
function parseWorkflowPermissions(lines) {
  const KEY = /^["']?permissions["']?:\s*(.*)$/;
  const idx = lines.findIndex((l) => KEY.test(l));
  if (idx === -1) return null;
  return parsePermissionsValue(lines, idx, KEY.exec(lines[idx])[1].trim());
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
        // Both spellings of the same mapping. `with:` alone on its line opens a
                // block; `with: {title: …, outcome: failure}` is flow form. Missing the
                // flow form parses as no inputs, so a CORRECTLY covered workflow reads
                // as both uncovered and missing its inputs — and a guard that reds on
                // right answers is a guard someone deletes.
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

    // Does this job actually run the filing script? Only meaningful inside
    // schedule-alarm.yml itself, where it identifies the job whose permissions
    // decide whether ANY alarm in the tree can file.
    const runsFiler = lines.slice(jobStart, jobEnd).some((l) => l.includes(ALARM_FILER_SCRIPT));

    jobs.push({ job: jobId, usesTarget, ifExpr, continueOnError, needs, title, label, outcome, permissions, runsFiler });
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
    const workflowPermissions = parseWorkflowPermissions(lines);
    for (const job of parseJobs(lines)) {
      if (!job.usesTarget || resolve(root, job.usesTarget) !== alarmPath) continue;
      calls.push({ file, workflowPermissions, ...job });
    }
  }
  return calls;
}

/**
 * Every call to schedule-alarm.yml whose EFFECTIVE permissions do not grant
 * every scope the alarm's own filing job requests — `gh issue create`/`gh
 * issue edit`/`gh issue close` (file-schedule-alarm.sh) 403s without
 * `issues: write`, and `actions/checkout` cannot run without `contents:
 * read`. The CALLING job's grant is what GitHub uses as the ceiling for a
 * reusable workflow call; the required set itself is derived from the callee
 * (see alarmRequiredScopes below), because the callee can only NARROW that
 * ceiling and so is the other half of the same property.
 * "Effective" is resolved exactly the way GitHub resolves it: a
 * job-level `permissions:` block REPLACES the workflow-level one rather than
 * merging with it, so a job-level block missing `issues: write` is checked
 * as-is — the workflow-level grant next to it is not consulted as a
 * fallback, because GitHub does not consult it either.
 *
 * If `permissions:` is absent at BOTH the job and the workflow level, the
 * effective grant is the repository/organization default — a setting this
 * script cannot read from the filesystem. Treating "cannot resolve" as a
 * silent pass would be exactly the silent degradation this exists to catch (an
 * unstated grant one settings-page click away from
 * losing `issues: write` entirely, with nothing in the diff to review), so
 * it is reported as a hard failure naming the workflow and job instead —
 * the same "unsupported shape must never be indistinguishable from a
 * passing one" stance list-scheduled-workflows.mjs takes for a multi-line
 * `on:` mapping.
 */
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

/**
 * The scopes a caller must grant, READ OFF schedule-alarm.yml's own filing job
 * rather than typed here.
 *
 * The caller's grant is a CEILING, not the effective set. A reusable
 * workflow's own `permissions:` can only NARROW what the caller handed it, and
 * a callee requesting a scope the caller withheld is refused by GitHub before
 * the job starts. So two things are wrong with checking `issues: write` on
 * callers alone: deleting `issues: write` from schedule-alarm.yml's `alarm`
 * job 403s every alarm in the tree while every caller stays compliant, and a
 * caller that grants ONLY `issues: write` — the exact minimal edit this
 * check's own error message invites — withholds the `contents: read` that
 * job's `actions/checkout` needs.
 *
 * Derivation alone would be self-defeating (deleting `issues: write` from the
 * callee would simply lower the bar for everyone and pass), so the callee is
 * ALSO held to an absolute `issues: write` floor here. `write-all` on the
 * callee is refused rather than expanded: there is no scope list to hand
 * callers, and a check that cannot enumerate its own requirement must not
 * report a pass.
 */
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

/** `false`, in any casing, with nothing else in the expression. */
function isTriviallyFalse(ifExpr) {
  return ifExpr !== null && /^false$/i.test(unwrapExpression(ifExpr));
}

/**
 * A call counts as reaching the alarm's FAILURE leg — the half that must
 * exist for every scheduled workflow — only if it is not neutralised. Three
 * independent ways a wired-looking call is dead in production:
 * `continue-on-error: true` swallows the reusable call's own failure so a
 * broken alarm still reports green; a literal `if: false` means the job
 * never runs at all; and `outcome` has to be the literal string `failure` —
 * a call that only ever passes `success` (a recovery job with no failure
 * sibling) is not covering the failure path either.
 */
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

/**
 * Two DIFFERENT workflows using the same label (or the same title).
 *
 * The bijection above is satisfied by an identical pair copy-pasted into a
 * second workflow — consistent, and wrong: `schedule-alarm.yml` documents the
 * label as "one label per alarm, so unrelated alarms never share an issue", and
 * `file-schedule-alarm.sh` looks the issue up by label alone. Sharing one means
 * two workflows share one tracking issue, so B's recovery leg CLOSES the alarm
 * A is still failing on. That is the alarm silencing itself — the exact fact
 * this whole milestone exists to make impossible — while every other assertion
 * here reports green.
 */
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

/**
 * An alarm label that files but can never close.
 *
 * "Files or updates a tracking issue when its scheduled run fails, AND closes
 * it on recovery" is one property, not two — a failure leg with no recovery
 * sibling leaves its issue open forever after the first red, which is how an
 * alarm stops being read. Derived per label from the calls themselves, so a new
 * alarm cannot land half-wired.
 */
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

  // Inherited floors, actually inherited: this calls
    // list-scheduled-workflows' OWN entry point, which throws on zero scheduled
    // workflows, on its two independent reads disagreeing, and on an absent
    // `uses: ./.github/workflows/…` target. Re-implementing only the zero check
    // here would claim the set-equality floor without holding it.
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
  const shared = findSharedAlarmKeys(calls);
  const unclosable = findUnclosableAlarms(calls);
  const requiredScopes = alarmRequiredScopes(root);
  const permissionGaps = findAlarmPermissionGaps(root, calls);
  // Distinct files among the calls whose permissions were actually resolved.
  // This is NOT an independent denominator — it is derived from `calls`, so a
  // parser regression drops a file from numerator and denominator together.
  // What holds the floor is findMissingAlarmCoverage above: every scheduled
  // workflow must appear in `calls` with a live failure leg, so this count
  // cannot fall below `covered.length` without that check reddening first.
  // No separate assertion on it: it is implied by the coverage check, and an
  // early throw here would MASK the coverage error it is downstream of.
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
