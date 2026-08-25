#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// allocate-version.yml's `steps.app-token.outputs.token || github.token`
// fallback must stay reachable only on the plan-only pull_request arm. On a push
// it is a silent double failure: `github-actions` can never be a ruleset bypass
// actor, and a push made with GITHUB_TOKEN triggers no workflows, so the number
// lands and nothing publishes it. Four one-line edits would each make it
// reachable, so the reachability is asserted here rather than commented.
//
// Also asserts the checkout ref is per arm: an unconditional `ref: main` checks
// out a tree without the PR's own files.

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
      ref: value("ref"),
      pushes: /\bgit push\b/.test(text),
    };
  });
}

const REF_IS_TIP_LITERAL = /^main$/;
const REF_IS_TIP_PER_ARM =
  /^\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*&&\s*[^|]+\|\|\s*'main'\s*\}\}$/;

function neutralised(step) {
  return step.continueOnError !== null && !/^(false|\$\{\{\s*false\s*\}\})$/.test(step.continueOnError);
}

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
    if (!/GH013/.test(step.text)) {
      errors.push(
        `the pushing step "${step.name}" does not distinguish a rule violation (GH013) from a ` +
          `non-fast-forward race. Retrying a refusal wastes every attempt and reports the wrong cause; ` +
          `it must stop on the first refusal and name the layer that refused.`,
      );
    }
  }

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

  const hasPrTrigger = lines.some((line) => /^\s{2}pull_request:\s*$/.test(line));
  const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
  if (checkouts.length === 0) {
    errors.push(`no \`actions/checkout\` step — the allocator cannot read a tree it has not checked out.`);
  }
  for (const step of checkouts) {
    if (step.ref === null) {
      errors.push(
        `the checkout step has no \`ref:\`, so a push run would check out the event sha instead of ` +
          `main's tip — a merge that landed while this run queued would be left out of the release it ` +
          `belongs to.`,
      );
      continue;
    }
    if (REF_IS_TIP_LITERAL.test(step.ref)) {
      if (hasPrTrigger) {
        errors.push(
          `the checkout \`ref: ${step.ref}\` is unconditional while this workflow still has a ` +
            `\`pull_request:\` trigger. On that arm it checks out a tree WITHOUT the PR's own files, so ` +
            `the plan-only arm proves nothing and reds on the first missing module. Use ` +
            `\`\${{ github.event_name == 'pull_request' && github.ref || 'main' }}\`.`,
        );
      }
      continue;
    }
    if (!REF_IS_TIP_PER_ARM.test(step.ref)) {
      errors.push(
        `the checkout \`ref: ${step.ref}\` does not resolve to main's tip on a push. The number belongs ` +
          `to the TIP, not to the event sha: a second merge that landed while this run queued is ` +
          `already on main and belongs in the same release. Accepted forms: \`main\`, or ` +
          `\`\${{ github.event_name == 'pull_request' && <merge ref> || 'main' }}\`.`,
      );
    }
  }

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
      `${precondition ? "1" : "0"} credential precondition, ` +
      `${checkouts.length} checkout(s) (ref: ${checkouts.map((step) => step.ref ?? "absent").join(", ")}).`,
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

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("assert-allocate-token-path.mjs")) {
  throw new Error(`assert-allocate-token-path.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) main();
