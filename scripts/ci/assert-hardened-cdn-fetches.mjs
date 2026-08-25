#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Every third-party network call on the publish path must go through one
// hardened helper: fetches via fetch-pinned-release.sh, registry writes via
// push-scanned-image.sh, cosign via sign-image-digests.sh, binary-installing
// `uses:` steps as a repeated-attempt group.
//
// Cosign covers reads too, where the write shape exempts them: by then every tag
// is already public. The set of actions is derived from the workflows; the
// verdict per action is a reviewed row in cdn-fetch-actions.json, keyed on
// owner/repo, so a sha bump keeps the classification.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workflowLines } from "./list-scheduled-workflows.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const HELPER = "scripts/ci/fetch-pinned-release.sh";

export const PUSH_HELPER = "scripts/ci/push-scanned-image.sh";

export const SIGN_HELPER = "scripts/ci/sign-image-digests.sh";

export const MIN_ATTEMPTS = 3;

const FETCH_COMMANDS = /(?:^|[\s(`$])(?:curl|wget|aria2c|gh\s+release\s+download)(?=\s|$)/;

/**
 * Every way a `run:` block commits a manifest to a registry. Writes
 * only: `docker pull` and `docker buildx imagetools inspect` are reads, and a
 * read that fails cannot leave a tag behind — `imagetools inspect` is in fact
 * the read this repo's hardened push path and pome-cloud's
 * resolve-image-digest.ts both make, so flagging it would red the fix.
 *
 * Not exhaustive over every registry client in existence, and the header says
 * so: `crane`, `skopeo` and `oras` would each need a line here, and none is in
 * this tree today.
 */
const REGISTRY_WRITE_COMMANDS = [
  /(?:^|[\s(`$])docker\s+push(?=\s|$)/,
  /(?:^|[\s(`$])docker\s+manifest\s+push(?=\s|$)/,
  /(?:^|[\s(`$])docker\s+buildx\s+imagetools\s+create(?=\s|$)/,
];

const COMMAND_PREFIX =
  "(?:(?:!|time|exec|sudo|env|command|if|then|else|elif|do|while|until)\\s+|[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*";
const SIGNING_COMMANDS = [
  new RegExp(`^\\s*${COMMAND_PREFIX}cosign(?=\\s|$)`),
  new RegExp(`(?:\\$\\(|\\x60)\\s*${COMMAND_PREFIX}cosign(?=\\s|$)`),
];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

const VALID_HARDENING = new Set(["not-needed", "repeat-attempts", "step-is-the-check"]);

export function loadTable(file = join(HERE, "cdn-fetch-actions.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function parseJobs(lines) {
  const jobs = [];
  let inJobs = false;
  let jobIndent = null;
  let job = null;
  let stepsIndent = null;
  let itemIndent = null;
  let step = null;

  const flushStep = () => {
    if (step && job) job.steps.push(step);
    step = null;
  };
  const flushJob = () => {
    flushStep();
    if (job) jobs.push(job);
    job = null;
    stepsIndent = null;
    itemIndent = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = /^\s*/.exec(line)[0].length;

    if (indent === 0) {
      flushJob();
      inJobs = /^jobs:\s*$/.test(line);
      jobIndent = null;
      continue;
    }
    if (!inJobs) continue;
    if (jobIndent === null) jobIndent = indent;

    if (indent <= jobIndent) {
      flushJob();
      const m = /^\s+([A-Za-z0-9_.-]+):\s*$/.exec(line);
      job = m ? { name: m[1], line: i + 1, steps: [] } : null;
      continue;
    }
    if (!job) continue;

    if (stepsIndent !== null && indent <= stepsIndent) {
      flushStep();
      stepsIndent = null;
      itemIndent = null;
    }
    if (stepsIndent === null) {
      if (/^\s*steps:\s*$/.test(line)) stepsIndent = indent;
      continue;
    }
    if (/^\s*-\s/.test(line) && (itemIndent === null || indent === itemIndent)) {
      flushStep();
      itemIndent = indent;
      step = { line: i + 1, lines: [line] };
      continue;
    }
    if (step) step.lines.push(line);
  }
  flushJob();
  return jobs;
}

export function stepKeys(step) {
  const norm = step.lines.map((l, i) => (i === 0 ? l.replace(/^(\s*)-(\s)/, "$1 $2") : l));
  const base = /^\s*/.exec(norm[0])[0].length;
  const keys = new Map();
  let current = null;
  for (const line of norm) {
    const indent = /^\s*/.exec(line)[0].length;
    if (indent <= base) {
      const m = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
      current = m ? { value: m[2].trim(), lines: [] } : null;
      if (m) keys.set(m[1], current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return keys;
}

export function keyText(keys, name) {
  const k = keys.get(name);
  if (!k) return null;
  const head = /^[|>][-+]?\d*$/.test(k.value) ? "" : k.value;
  return [head, ...k.lines].join("\n");
}

export function blockLines(keys, name) {
  const k = keys.get(name);
  if (!k) return null;
  return k.lines
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .sort();
}

export function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s"'`]+)/i.exec(url);
  if (!m) return null;
  let host = m[1].replace(/^[^@]*@/, "");
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close !== -1) host = host.slice(0, close + 1);
  } else {
    const colon = host.indexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }
  return host;
}

export function isLoopback(url) {
  const host = hostOf(url);
  if (host === null) return false;
  return LOOPBACK.has(host) || /^127(\.\d+){3}$/.test(host);
}

function shellSegments(script) {
  const text = script
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  return {
    text,
    segments: text
      .split(/\n|;|&&|\|\||\|/)
      .map((raw) => raw.trim())
      .filter((segment) => segment !== ""),
  };
}

export function findFetchesInScript(script) {
  const { text, segments } = shellSegments(script);
  const vars = new Map();
  for (const m of text.matchAll(
    /^\s*(?:local\s+|export\s+|declare\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/gm,
  )) {
    vars.set(m[1], m[2] ?? m[3] ?? m[4] ?? "");
  }
  const findings = [];
  for (const segment of segments) {
    if (!FETCH_COMMANDS.test(segment)) continue;
    findings.push({ segment, target: resolveTarget(segment, vars) });
  }
  return findings;
}

export function findRegistryWritesInScript(script) {
  return shellSegments(script).segments.filter((segment) =>
    REGISTRY_WRITE_COMMANDS.some((command) => command.test(segment)),
  );
}

export function findSigningCallsInScript(script) {
  return shellSegments(script).segments.filter((segment) =>
    SIGNING_COMMANDS.some((command) => command.test(segment)),
  );
}

function resolveTarget(segment, vars) {
  const literal = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`)]+/i.exec(segment);
  if (literal) return literal[0];
  for (const m of segment.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) {
    const value = vars.get(m[1]);
    if (value && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  }
  return null;
}

export function findUnhardenedRunFetches(root) {
  const problems = [];
  const hardened = [];
  for (const [file, lines] of workflowLines(root)) {
    for (const job of parseJobs(lines)) {
      for (const step of job.steps) {
        const keys = stepKeys(step);
        const script = keyText(keys, "run");
        if (script === null) continue;
        if (script.includes(HELPER)) hardened.push(`${file}:${step.line} (${job.name})`);
        for (const { segment, target } of findFetchesInScript(script)) {
          if (target !== null && isLoopback(target)) continue;
          if (script.includes(HELPER)) continue;
          problems.push(
            `${file}:${step.line} (job ${job.name}) fetches ${target ?? "an unresolvable target"} ` +
              `outside ${HELPER}: ${segment}`,
          );
        }
      }
    }
  }
  return { problems, hardened: hardened.sort() };
}

export function findUnhardenedRegistryWrites(root) {
  const problems = [];
  const hardened = [];
  for (const [file, lines] of workflowLines(root)) {
    for (const job of parseJobs(lines)) {
      for (const step of job.steps) {
        const keys = stepKeys(step);
        const script = keyText(keys, "run");
        if (script === null) continue;
        if (script.includes(PUSH_HELPER)) {
          hardened.push(`${file}:${step.line} (${job.name})`);
          continue;
        }
        for (const segment of findRegistryWritesInScript(script)) {
          problems.push(
            `${file}:${step.line} (job ${job.name}) writes to a container registry outside ${PUSH_HELPER}: ` +
              `${segment}. A single \`unknown blob\` from GHCR then fails the leg, leaving a commit ` +
              "with no image and nothing to re-run it.",
          );
        }
      }
    }
  }
  return { problems, hardened: hardened.sort() };
}

export function findUnhardenedSigningCalls(root) {
  const problems = [];
  const hardened = [];
  for (const [file, lines] of workflowLines(root)) {
    for (const job of parseJobs(lines)) {
      for (const step of job.steps) {
        const keys = stepKeys(step);
        const script = keyText(keys, "run");
        if (script === null) continue;
        if (script.includes(SIGN_HELPER)) {
          hardened.push(`${file}:${step.line} (${job.name})`);
          continue;
        }
        for (const segment of findSigningCallsInScript(script)) {
          problems.push(
            `${file}:${step.line} (job ${job.name}) calls cosign outside ${SIGN_HELPER}: ${segment}. ` +
              "Every cosign subcommand talks to the registry, and this step runs after the image is " +
              "already published — a single `DENIED` from a degraded GHCR then reds the job over a correct, " +
              "public artifact. Reads are in scope here for exactly that reason, unlike shape (c).",
          );
        }
      }
    }
  }
  return { problems, hardened: hardened.sort() };
}

export function actionRepo(ref) {
  if (!ref || ref.startsWith("./") || ref.startsWith(".\\")) return null;
  if (ref.startsWith("docker://")) return ref;
  const [path] = ref.split("@");
  const parts = path.split("/");
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

export function findActionRefsByLine(root) {
  const refs = new Map();
  for (const [file, lines] of workflowLines(root)) {
    lines.forEach((line, i) => {
      const m = /^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)["']?\s*$/.exec(line);
      if (!m) return;
      const repo = actionRepo(m[1]);
      if (repo === null) return;
      if (!refs.has(repo)) refs.set(repo, []);
      refs.get(repo).push(`${file}:${i + 1}`);
    });
  }
  return refs;
}

export function findActionStepsByStructure(root) {
  const steps = [];
  for (const [file, lines] of workflowLines(root)) {
    for (const job of parseJobs(lines)) {
      job.steps.forEach((step, index) => {
        const keys = stepKeys(step);
        const uses = keys.get("uses")?.value;
        const repo = actionRepo(uses);
        if (repo === null) return;
        steps.push({ file, job: job.name, index, line: step.line, ref: uses, repo, keys });
      });
    }
  }
  return steps;
}

export function findTableDefects(table, refs) {
  const problems = [];
  const actions = table?.actions ?? {};
  for (const [repo, sites] of [...refs].sort()) {
    if (!Object.hasOwn(actions, repo)) {
      problems.push(
        `${repo} is used at ${sites.join(", ")} but has no row in scripts/ci/cdn-fetch-actions.json. ` +
          "Read the action's own definition at the pinned ref and record whether it downloads an " +
          "executable, with the evidence — this gate cannot read that from here.",
      );
    }
  }
  for (const [repo, row] of Object.entries(actions).sort()) {
    if (typeof row.why !== "string" || row.why.trim() === "") {
      problems.push(`${repo}: row has no \`why\` — an unexplained classification is not a reviewed one.`);
    }
    if (!VALID_HARDENING.has(row.hardening)) {
      problems.push(
        `${repo}: \`hardening: ${JSON.stringify(row.hardening)}\` is not one of ${[...VALID_HARDENING].join(", ")}.`,
      );
      continue;
    }
    if (row.fetchesFromCdn === true && row.hardening === "not-needed") {
      problems.push(
        `${repo}: claims it fetches from a CDN but also \`hardening: not-needed\`. Pick one — either it ` +
          "pulls an executable and needs a repeated-attempt group, or it does not.",
      );
    }
    if (row.fetchesFromCdn !== true && row.hardening !== "not-needed") {
      problems.push(
        `${repo}: \`hardening: ${row.hardening}\` on a row that says it fetches nothing. Hardening a step ` +
          "that pulls nothing is decoration.",
      );
    }
    if (row.hardening === "step-is-the-check" && (typeof row.residual !== "string" || row.residual.trim() === "")) {
      problems.push(
        `${repo}: \`step-is-the-check\` is a deliberate exemption, so it must carry a \`residual\` naming ` +
          "what stays exposed and what would close it. An exemption with no residual reads as coverage.",
      );
    }
  }
  return problems;
}

export function checkAttemptGroup(where, repo, attempts) {
  const problems = [];
  const at = (a) => `${where} step ${a.line}`;

  if (attempts.length < MIN_ATTEMPTS) {
    problems.push(
      `${where}: ${repo} appears ${attempts.length} time(s); it downloads a binary from a release CDN, so it ` +
        `needs a repeated-attempt group of at least ${MIN_ATTEMPTS} steps (${attempts.length === 1 ? "the single step at line " + attempts[0].line + " dies on the first 5xx" : "too few attempts to survive a degraded CDN"}).`,
    );
    return problems;
  }

  const ids = attempts.map((a) => a.keys.get("id")?.value ?? null);
  ids.forEach((id, i) => {
    if (!id) {
      problems.push(
        `${at(attempts[i])}: attempt ${i + 1} of the ${repo} group has no \`id:\`, so no later attempt can gate on it.`,
      );
    }
  });

  const refs = new Set(attempts.map((a) => a.ref));
  if (refs.size > 1) {
    problems.push(
      `${where}: the ${repo} attempts disagree on \`uses:\` (${[...refs].join(" vs ")}) — a retry must install the same pinned build, not a different one.`,
    );
  }

  const withBlocks = attempts.map((a) => (blockLines(a.keys, "with") ?? []).join("\n"));
  const distinct = new Set(withBlocks);
  if (distinct.size > 1) {
    problems.push(
      `${where}: the ${repo} attempts disagree on their \`with:\` inputs, so a retry would run with different ` +
        "settings than the first try. (This is the check that keeps every repeated cosign install on the same " +
        "`cosign-release`.)\n    " +
        withBlocks.map((b, i) => `attempt ${i + 1} (line ${attempts[i].line}): ${b.replace(/\n/g, " | ") || "(none)"}`).join("\n    "),
    );
  }

  attempts.forEach((a, i) => {
    const cont = a.keys.get("continue-on-error")?.value;
    const escapable = cont !== undefined && /true/.test(cont);
    if (i < attempts.length - 1 && !escapable) {
      problems.push(
        `${at(a)}: attempt ${i + 1} of ${attempts.length} for ${repo} is not \`continue-on-error: true\`, so the ` +
          "job dies on the first 5xx and the later attempts never run.",
      );
    }
    if (i === attempts.length - 1 && escapable) {
      problems.push(
        `${at(a)}: the LAST ${repo} attempt is \`continue-on-error: true\`, so a genuinely unavailable CDN would ` +
          "let an unsigned/unattested image through. The last attempt carries no escape hatch — that is the " +
          "fail-closed half of the pattern.",
      );
    }
  });

  attempts.forEach((a, i) => {
    if (i === 0) return;
    const cond = keyText(a.keys, "if") ?? "";
    for (let j = 0; j < i; j++) {
      const id = ids[j];
      if (!id) continue;
      if (!new RegExp(`steps\\.${id}\\.outcome\\s*==\\s*'failure'`).test(cond)) {
        problems.push(
          `${at(a)}: attempt ${i + 1} for ${repo} does not gate on \`steps.${id}.outcome == 'failure'\`, so it ` +
            "either runs when the earlier attempt succeeded (a duplicate install) or is unreachable. A skipped " +
            "step's outcome is `skipped`, never `failure`, so the chain must name every earlier attempt.",
        );
      }
    }
  });

  return problems;
}

export function findUnhardenedActionGroups(root, table) {
  const problems = [];
  const groups = [];
  const byJob = new Map();
  for (const step of findActionStepsByStructure(root)) {
    const row = table?.actions?.[step.repo];
    if (!row || row.hardening !== "repeat-attempts") continue;
    const key = `${step.file}::${step.job}::${step.repo}`;
    if (!byJob.has(key)) byJob.set(key, []);
    byJob.get(key).push(step);
  }
  for (const [key, attempts] of [...byJob].sort()) {
    const [file, job, repo] = key.split("::");
    groups.push(`${file} (job ${job}) ${repo} x${attempts.length}`);
    problems.push(...checkAttemptGroup(`${file} (job ${job})`, repo, attempts));
  }
  return { problems, groups };
}

export function findParseDisagreements(root) {
  const byLine = new Set(findActionRefsByLine(root).keys());
  const byStructure = new Set(findActionStepsByStructure(root).map((s) => s.repo));
  const missed = [...byLine].filter((r) => !byStructure.has(r)).sort();
  const extra = [...byStructure].filter((r) => !byLine.has(r)).sort();
  return { missed, extra };
}

export function main(root = resolve(HERE, "../.."), table = loadTable()) {
  const failures = [];

  if (!existsSync(join(root, HELPER))) {
    throw new Error(`${HELPER} is missing — the one hardened fetch path this gate points every workflow at.`);
  }
  if (!existsSync(join(root, PUSH_HELPER))) {
    throw new Error(`${PUSH_HELPER} is missing — the one hardened registry-write path this gate points every workflow at.`);
  }
  if (!existsSync(join(root, SIGN_HELPER))) {
    throw new Error(`${SIGN_HELPER} is missing — the one hardened signing path this gate points every workflow at.`);
  }

  const { problems: runProblems, hardened } = findUnhardenedRunFetches(root);
  failures.push(...runProblems);

  const { problems: writeProblems, hardened: hardenedWrites } = findUnhardenedRegistryWrites(root);
  failures.push(...writeProblems);

  const { problems: signProblems, hardened: hardenedSigns } = findUnhardenedSigningCalls(root);
  failures.push(...signProblems);

  const refs = findActionRefsByLine(root);
  failures.push(...findTableDefects(table, refs));

  const { missed, extra } = findParseDisagreements(root);
  if (missed.length > 0 || extra.length > 0) {
    failures.push(
      "the flat `uses:` scan and the jobs->steps parse disagree about which actions this tree uses, so the " +
        "repeated-attempt check is running on an incomplete step list:\n" +
        `  seen only by the line scan  -> ${missed.join(", ") || "(none)"}\n` +
        `  seen only by the step parse -> ${extra.join(", ") || "(none)"}\n` +
        "Fix parseJobs() in this file, not the assertion — a step it cannot see is a step it cannot check.",
    );
  }

  const { problems: groupProblems, groups } = findUnhardenedActionGroups(root, table);
  failures.push(...groupProblems);

  if (refs.size === 0) {
    throw new Error("found zero `uses:` actions in .github/workflows — a parser regression, not a true fact.");
  }
  const classifiedCdn = Object.entries(table.actions).filter(([repo, row]) => row.fetchesFromCdn === true && refs.has(repo));
  if (classifiedCdn.length === 0) {
    throw new Error(
      "no action this tree uses is classified as fetching from a CDN, so the repeated-attempt half of this " +
        "gate checked nothing. Refusing to report a vacuous green.",
    );
  }
  if (groups.length === 0) {
    throw new Error(
      "no `repeat-attempts` action group was found in the tree, so the group shape check ran on nothing. " +
        "Refusing to report a vacuous green.",
    );
  }
  if (hardened.length === 0) {
    throw new Error(
      `no workflow calls ${HELPER}, so the hardened fetch path is dead code and shape (a) checked nothing. ` +
        "Refusing to report a vacuous green.",
    );
  }
  if (hardenedWrites.length === 0) {
    throw new Error(
      `no workflow calls ${PUSH_HELPER}, so the hardened registry-write path is dead code and shape (c) checked ` +
        "nothing. Refusing to report a vacuous green.",
    );
  }
  if (hardenedSigns.length === 0) {
    throw new Error(
      `no workflow calls ${SIGN_HELPER}, so the hardened signing path is dead code and shape (d) checked ` +
        "nothing. Refusing to report a vacuous green.",
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} unhardened network call(s) in .github/workflows:\n  - ${failures.join("\n  - ")}\n\n` +
        `Shape (a): route the fetch through ${HELPER} (pin + sha256, retry with backoff, fail closed by name).\n` +
        "Shape (b): give the action a row in scripts/ci/cdn-fetch-actions.json, and if it downloads a binary, " +
        "repeat the step (see this file's header for the exact shape).\n" +
        `Shape (c): route the registry write through ${PUSH_HELPER} (retry with backoff, read the manifest back ` +
        "per tag, fail closed by name).\n" +
        `Shape (d): route the cosign call through ${SIGN_HELPER} (retry each operation with backoff, fail closed ` +
        "naming which operation ran out and what is already published).",
    );
  }

  console.log(`hardened CDN fetches OK: ${refs.size} action(s) classified, ${classifiedCdn.length} of them CDN-fetching`);
  for (const [repo, row] of classifiedCdn) console.log(`  - ${repo}: ${row.hardening}`);
  console.log(`  ${groups.length} repeated-attempt group(s): ${groups.join(", ")}`);
  console.log(`  ${hardened.length} hardened fetch call site(s): ${hardened.join(", ")}`);
  console.log(`  ${hardenedWrites.length} hardened registry-write call site(s): ${hardenedWrites.join(", ")}`);
  console.log(`  ${hardenedSigns.length} hardened signing call site(s): ${hardenedSigns.join(", ")}`);
  return { refs, groups, hardened, hardenedWrites, hardenedSigns };
}

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && basename(ENTRY) === basename(SELF)) {
  throw new Error(
    `assert-hardened-cdn-fetches.mjs entry guard did not fire for ${ENTRY} (expected ${SELF}) — refusing to exit 0 having checked nothing`,
  );
}

if (invokedDirectly) main();
