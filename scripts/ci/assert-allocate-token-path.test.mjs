#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Regression coverage for scripts/ci/assert-allocate-token-path.mjs (F-1511).
 *
 * Every case below MUTATES THE REAL `allocate-version.yml` rather than a
 * hand-written sample, because the claim under test is about the file that ships:
 * a checker that only ever fails on a synthetic fixture proves nothing about the
 * edits a person would actually make. Each mutation is one plausible edit — the
 * kind that passes review because it looks like tidying — and each must red.
 *
 * The property: on a `push` event, the job either fails before the push step or
 * pushes with the pome-ops-push installation token. It can never reach the push
 * step holding `github.token`. Reaching it is a silent double failure —
 * `github-actions` can never be a ruleset bypass actor (the push is refused), and
 * a push made with `GITHUB_TOKEN` does not trigger workflows (so a landed commit
 * would publish nothing) — and both look like a quiet green.
 *
 * A checker that has never failed is a checker nobody knows works, so the
 * positive case (the real file passes) is asserted alongside fifteen negatives.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkAllocateTokenPath, parseSteps } from "./assert-allocate-token-path.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const REAL = readFileSync(join(ROOT, ".github/workflows/allocate-version.yml"), "utf8");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
}

/** A repo root whose only workflow is a (possibly mutated) copy of the real one. */
function run(mutate = (text) => text) {
  const dir = mkdtempSync(join(tmpdir(), "allocate-token-path-"));
  try {
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/allocate-version.yml"), mutate(REAL));
    return checkAllocateTokenPath(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Drop a whole `- name: <name>` step block, up to the next step at the same indent. */
function dropStep(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(`- name: ${name}`));
  if (start === -1) throw new Error(`fixture drifted: no step named "${name}"`);
  const indent = lines[start].match(/^(\s*)-/)[1].length;
  let end = start + 1;
  while (end < lines.length && !new RegExp(`^\\s{${indent}}-\\s`).test(lines[end])) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** Edit one line inside a named step (the first line matching `match`). */
function editInStep(text, name, match, replacement) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(`- name: ${name}`));
  if (start === -1) throw new Error(`fixture drifted: no step named "${name}"`);
  const indent = lines[start].match(/^(\s*)-/)[1].length;
  let end = start + 1;
  while (end < lines.length && !new RegExp(`^\\s{${indent}}-\\s`).test(lines[end])) end += 1;
  const at = lines.slice(start, end).findIndex((line) => match.test(line));
  if (at === -1) throw new Error(`fixture drifted: no ${match} inside "${name}"`);
  lines[start + at] = replacement(lines[start + at]);
  return lines.join("\n");
}

/** Insert a line after the `- name:` line of a named step. */
function insertInStep(text, name, line) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes(`- name: ${name}`));
  if (start === -1) throw new Error(`fixture drifted: no step named "${name}"`);
  lines.splice(start + 1, 0, line);
  return lines.join("\n");
}

const PRECONDITION = "The pome-ops-push credentials must exist";
const MINT = "Mint a pome-ops-push installation token";
const PUSH = "Allocate, write, and push one commit to main";
const PLAN = "What would this push allocate?";
const names = (result) => result.errors.join("\n");

console.log("assert-allocate-token-path.mjs — the real file");
{
  const result = run();
  check("the shipped workflow passes", result.errors.length === 0, names(result));
  check(
    "…and the summary names a non-empty subject, so a green cannot mean an empty parse",
    /1 mint step\(s\) \(id: app-token\), 1 pushing step\(s\)/.test(result.summary),
    result.summary,
  );

  // The parser is the part that can silently drift and make every case below
  // vacuous, so it is asserted directly too.
  const steps = parseSteps(REAL.split("\n").map((line) => line.replace(/\s+#.*$/, "")));
  check(
    "parseSteps finds each step exactly once, in file order",
    [PRECONDITION, MINT, PUSH, PLAN].every(
      (name) => steps.filter((step) => step.name === name).length === 1,
    ) &&
      steps.findIndex((s) => s.name === MINT) < steps.findIndex((s) => s.name === PUSH),
    steps.map((s) => s.name).join(" | "),
  );
  check(
    "…and a `- ` inside a run: block does not start a step",
    steps.every((step) => !/^\s*#/.test(step.name)) && steps.length < 12,
    `${steps.length} steps: ${steps.map((s) => s.name).join(" | ")}`,
  );
}

console.log("the precondition must red on a push when the secrets are missing");
{
  const gone = run((t) => dropStep(t, PRECONDITION));
  check(
    "deleting it reds, naming both secrets",
    gone.errors.length > 0 && /OPS_APP_ID and OPS_APP_PRIVATE_KEY/.test(names(gone)),
    names(gone),
  );

  const swallowed = run((t) => insertInStep(t, PRECONDITION, "        continue-on-error: true"));
  check(
    "continue-on-error: true on it reds",
    /precondition step is `continue-on-error: true`/.test(names(swallowed)),
    names(swallowed),
  );

  const skipped = run((t) =>
    editInStep(t, PRECONDITION, /^\s*if:/, () => "        if: github.event_name == 'schedule'"),
  );
  check(
    "a guard that lets a push skip it reds",
    /precondition step's `if:`/.test(names(skipped)),
    names(skipped),
  );

  const dead = run((t) =>
    editInStep(
      t,
      PRECONDITION,
      /^\s*if:/,
      () => "        if: github.event_name != 'pull_request' && false",
    ),
  );
  check("a neutralised guard (`&& false`) reds", /precondition step's `if:`/.test(names(dead)), names(dead));
}

console.log("the mint step is what makes the fallback unreachable on a push");
{
  const gone = run((t) => dropStep(t, MINT));
  check(
    "deleting it reds, and says why the app token is the only credential that works",
    /expected exactly one .*create-github-app-token/.test(names(gone)),
    names(gone),
  );

  const swallowed = run((t) => insertInStep(t, MINT, "        continue-on-error: true"));
  check(
    "continue-on-error: true on it reds — a failed mint would fall through to the checkout",
    /create-github-app-token step is `continue-on-error: true`/.test(names(swallowed)),
    names(swallowed),
  );

  const expressionForm = run((t) => insertInStep(t, MINT, "        continue-on-error: ${{ true }}"));
  check(
    "…and so does the expression spelling, which reads as configuration",
    /continue-on-error: \$\{\{ true \}\}/.test(names(expressionForm)),
    names(expressionForm),
  );

  const narrowed = run((t) =>
    editInStep(t, MINT, /^\s*if:/, () => "        if: github.event_name == 'workflow_dispatch'"),
  );
  check(
    "a guard that can be false on a push reds, naming the empty-output consequence",
    /does not guarantee it runs on a push/.test(names(narrowed)) && /fallback goes live/.test(names(narrowed)),
    names(narrowed),
  );

  const anonymous = run((t) => editInStep(t, MINT, /^\s*id:/, () => "        # id removed"));
  check(
    "removing its `id:` reds — an output nothing can reference is not a token",
    /no `id:`/.test(names(anonymous)),
    names(anonymous),
  );
}

console.log("the pushing step");
{
  const unguarded = run((t) => editInStep(t, PUSH, /^\s*if:/, () => "        # if removed"));
  check(
    "losing its `if:` reds — on a PR run the checkout credential is the ambient token",
    /pushing step .* does not confine it to non-pull_request events|pushing step .*`if: absent`/.test(names(unguarded)),
    names(unguarded),
  );

  const handed = run((t) =>
    insertInStep(t, PUSH, "        env:\n          GH_TOKEN: ${{ github.token }}"),
  );
  check(
    "handing it github.token reds twice over (in the step, and outside the fallback)",
    /pushing step .* mentions github\.token/.test(names(handed)) &&
      /outside the sanctioned fallback/.test(names(handed)),
    names(handed),
  );

  const swallowed = run((t) => insertInStep(t, PUSH, "        continue-on-error: true"));
  check(
    "continue-on-error: true on it reds — a refused push would report green",
    /pushing step .* is `continue-on-error: true`/.test(names(swallowed)),
    names(swallowed),
  );

  const neutralised = run((t) =>
    editInStep(t, PUSH, /^\s*if:/, () => "        if: github.event_name != 'pull_request' && false"),
  );
  check("a neutralised guard reds", names(neutralised).includes("pushing step"), names(neutralised));
}

console.log("the fallback itself");
{
  const bare = run((t) =>
    t.replace(
      "token: ${{ steps.app-token.outputs.token || github.token }}",
      "token: ${{ github.token }}",
    ),
  );
  check(
    "a bare `token: ${{ github.token }}` reds, naming the only accepted form",
    /outside the sanctioned fallback/.test(names(bare)) &&
      /steps\.app-token\.outputs\.token \|\| github\.token/.test(names(bare)),
    names(bare),
  );

  const secretsForm = run((t) =>
    t.replace(
      "token: ${{ steps.app-token.outputs.token || github.token }}",
      "token: ${{ secrets.GITHUB_TOKEN }}",
    ),
  );
  check(
    "…and so does the `secrets.GITHUB_TOKEN` spelling of the same thing",
    /outside the sanctioned fallback/.test(names(secretsForm)),
    names(secretsForm),
  );

  const noArm = run((t) => dropStep(t, PLAN));
  check(
    "keeping the fallback with no plan-only arm left to serve reds",
    /no pull_request-only step for it to serve/.test(names(noArm)),
    names(noArm),
  );

  const armPushes = run((t) =>
    insertInStep(t, PLAN, "        run: git push origin HEAD:main # not on this arm"),
  );
  check(
    "a plan-only arm that pushes reds",
    /pull_request-only step .* runs `git push`/.test(names(armPushes)),
    names(armPushes),
  );
}

console.log("the checker's own floors");
{
  let threw = "";
  const dir = mkdtempSync(join(tmpdir(), "allocate-token-path-empty-"));
  try {
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/ci.yml"), "name: ci\njobs: {}\n");
    checkAllocateTokenPath(dir);
  } catch (error) {
    threw = error.message;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  check(
    "a missing allocate-version.yml throws rather than passing on an empty subject",
    /not found under/.test(threw),
    threw,
  );

  const noPush = run((t) => t.replace(/git push/g, "git nope"));
  check(
    "a file with no pushing step at all reds",
    /no step runs `git push`/.test(names(noPush)),
    names(noPush),
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
