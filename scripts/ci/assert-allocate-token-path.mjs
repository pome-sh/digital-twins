#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1511 — THE VERSION-ALLOCATING PUSH CAN ONLY EVER HAPPEN WITH THE APP TOKEN.
//
// `allocate-version.yml`'s checkout carries a fallback:
//
//     token: ${{ steps.app-token.outputs.token || github.token }}
//
// That fallback exists for ONE arm — the `pull_request` arm, which plans and never
// writes, and which on a fork has no secrets at all. Everywhere else it must be
// unreachable, because reaching it is a silent double failure: `github-actions` can
// never be a ruleset bypass actor (so the push is refused), and a push made with
// `GITHUB_TOKEN` does not trigger workflows (so if it somehow landed, no
// `release.yml` run would ever publish it). Both look like a quiet green, which is
// the failure class this whole apparatus exists to remove.
//
// A comment saying "this fallback is only for PRs" is not a guarantee. Four edits
// would each make it reachable on a push, none of them obviously wrong in review:
// dropping the precondition step, marking the precondition or the mint step
// `continue-on-error: true`, narrowing either step's `if:` so it can be false on a
// push, or handing the push step `github.token` directly. So the reachability is a
// PROPERTY over the workflow text, checked here.
//
// ── WHAT IS ASSERTED, AND WHY EACH LINE HOLDS THE PROPERTY ───────────────────
//
//   1. Exactly ONE mint step (`uses: actions/create-github-app-token@…`), with an
//      `id:` (an output nothing can reference is not a token), the non-PR guard,
//      and no `continue-on-error`. This is what makes
//      `steps.<id>.outputs.token` non-empty on every push that reaches the
//      checkout: the step runs, and if it fails the job stops before the checkout,
//      because every later step inherits an implicit `success()`.
//   2. A precondition step BEFORE the mint step, same guard, no
//      `continue-on-error`, naming both secrets and containing `exit 1`. The mint
//      action fails on empty inputs by itself; this is what makes the failure name
//      which secret, on which repository, and what to do — the message someone
//      meets when releases have silently stopped.
//   3. Every step that runs `git push` carries the non-PR guard, has no
//      `continue-on-error`, comes after the mint step, and mentions no ambient
//      token anywhere in it.
//   4. Every `github.token` / `secrets.GITHUB_TOKEN` occurrence in the file is
//      inside the exact fallback expression `steps.<mintId>.outputs.token ||
//      github.token`. A bare `token: ${{ github.token }}` — the shape someone
//      reaches for when the mint step is temporarily commented out — reds.
//   5. The plan-only arm exists, is PR-guarded, and does not push. That arm is the
//      fallback's whole reason for being; if it disappears, the fallback should go
//      with it rather than sit there reachable-in-principle.
//   6. Floors: the file exists, and the push-step and mint-step counts are
//      non-zero. A checker whose subject has gone empty passes forever.
//
// Comment stripping is `list-scheduled-workflows.mjs`'s, not a third copy: its
// stripper is quote-aware because a blanket `#.*$` once truncated two distinct
// quoted values to the same mangled prefix and made a bijection compare two equal
// wrecks (F-1471).
//
// Usage: node scripts/ci/assert-allocate-token-path.mjs [repo root]

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { workflowLines } from "./list-scheduled-workflows.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const WORKFLOW = "allocate-version.yml";
const MINT_ACTION = "actions/create-github-app-token";
const NON_PR_GUARD = "github.event_name != 'pull_request'";
const PR_ONLY_GUARD = "github.event_name == 'pull_request'";
const AMBIENT_TOKEN_RE = /github\.token|secrets\.GITHUB_TOKEN/g;
const SECRET_NAMES = ["OPS_APP_ID", "OPS_APP_PRIVATE_KEY"];

/**
 * The workflow's steps, as raw text blocks in file order.
 *
 * Split on the `- ` items at the `steps:` list indent, so a `- ` inside a `run:`
 * block or a prose line cannot start a step. Deliberately NOT a YAML library:
 * every other workflow-property check in this repo reads the same
 * comment-stripped lines, and adding a parser here would mean two answers to
 * "what does this file say" that can disagree.
 */
export function parseSteps(lines) {
  const stepsAt = lines.findIndex((line) => /^\s*steps:\s*$/.test(line));
  if (stepsAt === -1) return [];

  const steps = [];
  let itemIndent = null;
  let current = null;
  for (const line of lines.slice(stepsAt + 1)) {
    const item = line.match(/^(\s*)-\s/);
    if (item && (itemIndent === null || item[1].length === itemIndent)) {
      itemIndent = item[1].length;
      if (current) steps.push(current);
      current = { lines: [line] };
      continue;
    }
    if (!current) continue;
    // A line at or left of the list indent that is not a new item has left the
    // steps block (the next job key, or the next job).
    const indent = line.match(/^(\s*)\S/);
    if (indent && itemIndent !== null && indent[1].length <= itemIndent && !/^\s*-\s/.test(line)) {
      break;
    }
    current.lines.push(line);
  }
  if (current) steps.push(current);

  return steps.map((step, index) => {
    const text = step.lines.join("\n");
    const value = (key) => {
      const hit = step.lines.find((line) => new RegExp(`^\\s*(-\\s+)?${key}:`).test(line));
      return hit ? hit.replace(new RegExp(`^\\s*(-\\s+)?${key}:\\s*`), "").trim() : null;
    };
    return {
      index,
      text,
      name: value("name") ?? value("uses") ?? `step ${index + 1}`,
      id: value("id"),
      uses: value("uses"),
      guard: value("if"),
      continueOnError: value("continue-on-error"),
      pushes: /\bgit push\b/.test(text),
    };
  });
}

/** Absent or literally `false`. Anything else — including `${{ true }}` — is not. */
function neutralised(step) {
  return step.continueOnError !== null && !/^(false|\$\{\{\s*false\s*\}\})$/.test(step.continueOnError);
}

/** Runs on every push, and cannot be turned off by an expression that reads as config. */
function guardedToRunOnPush(step) {
  if (!step.guard) return false;
  if (!step.guard.includes(NON_PR_GUARD)) return false;
  if (step.guard.includes(PR_ONLY_GUARD)) return false;
  return !/\bfalse\b/.test(step.guard);
}

export function checkAllocateTokenPath(root) {
  const entry = workflowLines(root).find(([file]) => file === WORKFLOW);
  if (!entry) {
    throw new Error(
      `${WORKFLOW} not found under ${root}/.github/workflows. This check's whole subject is ` +
        `that file's credential path; a missing file is a hard failure, not an empty pass.`,
    );
  }
  const [, lines] = entry;
  const steps = parseSteps(lines);
  const errors = [];

  if (steps.length === 0) {
    throw new Error(`${WORKFLOW}: parsed zero steps — the parser has drifted from the file.`);
  }

  // 1 — the mint step.
  const mintSteps = steps.filter((step) => step.uses?.startsWith(`${MINT_ACTION}@`));
  if (mintSteps.length !== 1) {
    errors.push(
      `expected exactly one \`uses: ${MINT_ACTION}@…\` step, found ${mintSteps.length}. ` +
        `The app token is the only credential that can push to main and trigger release.yml.`,
    );
  }
  const mint = mintSteps[0];
  if (mint) {
    if (!mint.id) {
      errors.push(`the ${MINT_ACTION} step has no \`id:\`, so nothing can reference its token output.`);
    }
    if (!guardedToRunOnPush(mint)) {
      errors.push(
        `the ${MINT_ACTION} step's \`if:\` (${mint.guard ?? "absent"}) does not guarantee it runs on a ` +
          `push. A skipped mint step leaves \`steps.${mint.id ?? "<id>"}.outputs.token\` empty, which is ` +
          `exactly when the \`|| github.token\` fallback goes live on the push path.`,
      );
    }
    if (neutralised(mint)) {
      errors.push(
        `the ${MINT_ACTION} step is \`continue-on-error: ${mint.continueOnError}\`, so a failed mint no ` +
          `longer stops the job and the checkout below falls back to the ambient token.`,
      );
    }
  }

  // 2 — the precondition step, before the mint step.
  const preconditions = steps.filter(
    (step) =>
      SECRET_NAMES.every((secret) => step.text.includes(secret)) &&
      /\bexit 1\b/.test(step.text) &&
      !step.uses,
  );
  const precondition = preconditions.find((step) => !mint || step.index < mint.index);
  if (!precondition) {
    errors.push(
      `no step before the mint step names both ${SECRET_NAMES.join(" and ")} and exits 1. The mint ` +
        `action fails on empty inputs by itself, but its error does not say which secret on which ` +
        `repository, and that message is what a human meets when releases have stopped.`,
    );
  } else {
    if (!guardedToRunOnPush(precondition)) {
      errors.push(
        `the credential precondition step's \`if:\` (${precondition.guard ?? "absent"}) does not ` +
          `guarantee it runs on a push, so a push with missing secrets would sail past it.`,
      );
    }
    if (neutralised(precondition)) {
      errors.push(
        `the credential precondition step is \`continue-on-error: ${precondition.continueOnError}\`, ` +
          `which turns the one loud failure in this file into a warning.`,
      );
    }
  }

  // 3 — every pushing step.
  const pushSteps = steps.filter((step) => step.pushes);
  if (pushSteps.length === 0) {
    errors.push(
      `no step runs \`git push\` — either this workflow stopped writing the version to main, or the ` +
        `parser has drifted. Both must red rather than pass on an empty subject.`,
    );
  }
  for (const step of pushSteps) {
    if (!guardedToRunOnPush(step)) {
      errors.push(
        `the pushing step "${step.name}" has \`if: ${step.guard ?? "absent"}\`, which does not confine ` +
          `it to non-pull_request events — on a PR run the checkout credential is the ambient token.`,
      );
    }
    if (neutralised(step)) {
      errors.push(
        `the pushing step "${step.name}" is \`continue-on-error: ${step.continueOnError}\`, so a ` +
          `refused push would report green.`,
      );
    }
    if (mint && step.index < mint.index) {
      errors.push(`the pushing step "${step.name}" runs BEFORE the token is minted.`);
    }
    const ambient = step.text.match(AMBIENT_TOKEN_RE);
    if (ambient) {
      errors.push(
        `the pushing step "${step.name}" mentions ${[...new Set(ambient)].join(", ")}. The push must ` +
          `use the app installation token and nothing else: \`github-actions\` can never be a ruleset ` +
          `bypass actor, and a push made with it does not trigger release.yml.`,
      );
    }
  }

  // 4 — every ambient-token occurrence is the one sanctioned fallback.
  const fallbackRe = mint?.id
    ? new RegExp(`steps\\.${mint.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.outputs\\.token\\s*\\|\\|\\s*github\\.token`)
    : null;
  let ambientOccurrences = 0;
  for (const [offset, line] of lines.entries()) {
    const hits = line.match(AMBIENT_TOKEN_RE);
    if (!hits) continue;
    ambientOccurrences += hits.length;
    if (fallbackRe && fallbackRe.test(line)) continue;
    errors.push(
      `${WORKFLOW}:${offset + 1} mentions an ambient token outside the sanctioned fallback: ` +
        `${line.trim()}. The only accepted form is ` +
        `\`steps.${mint?.id ?? "<mint-id>"}.outputs.token || github.token\`, whose fallback branch is ` +
        `reachable only on the pull_request arm — a bare \`github.token\` is reachable on a push.`,
    );
  }

  // 5 — the plan-only arm the fallback exists for.
  const planOnly = steps.filter((step) => step.guard?.includes(PR_ONLY_GUARD) && !step.pushes);
  if (ambientOccurrences > 0 && planOnly.length === 0) {
    errors.push(
      `the file carries the \`|| github.token\` fallback but has no pull_request-only step for it to ` +
        `serve. The fallback exists for the plan-only arm (a fork PR has no secrets at all); with that ` +
        `arm gone it is reachable-in-principle and nothing else, so it should go too.`,
    );
  }
  for (const step of steps.filter((step) => step.guard?.includes(PR_ONLY_GUARD) && step.pushes)) {
    errors.push(`the pull_request-only step "${step.name}" runs \`git push\`. That arm must plan and never write.`);
  }

  return {
    errors,
    summary:
      `${WORKFLOW}: ${steps.length} step(s), ${mintSteps.length} mint step(s)` +
      `${mint?.id ? ` (id: ${mint.id})` : ""}, ${pushSteps.length} pushing step(s), ` +
      `${planOnly.length} plan-only step(s), ${ambientOccurrences} ambient-token mention(s), ` +
      `${precondition ? "1" : "0"} credential precondition.`,
  };
}

export function main(argv = process.argv.slice(2)) {
  const root = resolve(argv.find((arg) => !arg.startsWith("--")) ?? resolve(HERE, "../.."));
  const { errors, summary } = checkAllocateTokenPath(root);
  console.log(summary);
  if (errors.length > 0) {
    console.error("The version-allocating push could reach the ambient GITHUB_TOKEN:");
    for (const error of errors) console.error(`::error::${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "✅ On a push, the allocation either fails before the push step or pushes with the pome-ops-push " +
      "installation token. The `|| github.token` fallback is reachable only on the plan-only arm.",
  );
}

// Realpath'd on both sides — node resolves symlinks before deriving
// `import.meta.url`, so a bare `pathToFileURL()` of argv[1] misses through a
// symlinked checkout (a worktree, or macOS's symlinked `/tmp`) in the same silent
// shape (F-1488), and a guard miss while invoked as this file throws rather than
// exits 0.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("assert-allocate-token-path.mjs")) {
  throw new Error(`assert-allocate-token-path.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) main();
