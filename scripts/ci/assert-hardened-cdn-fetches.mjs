#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1489 — every third-party network call `.github/workflows/**` makes on the
// publish path must go through one hardened path, and a new one that does not
// must red CI.
//
// WHY THIS EXISTS. `anchore/sbom-action` fetched syft with no retry; a CDN 503
// killed the stripe twin-image job twice on 2026-08-12 (#390, #391), and on
// `main` — where the cosign sign/attest steps do run — the same 503 fails an
// image publish. The repo already knew the fix (ci.yml's actionlint loop,
// F-1471) and had it in two hand-copied variants with a third install missing
// it entirely. A list of "the installs we hardened" is the same shape as the
// bug: it stays green while a sixth install lands unhardened. So this is a
// PROPERTY check over the workflow tree.
//
// F-1530 widened it from fetches to network calls, because the same shape found
// a third instance: with both twin-image.yml fetches hardened, the REGISTRY
// WRITE standing between them was still a single unretried `docker push`. On
// 2026-08-14 GHCR answered `unknown blob` after every layer had reported
// `Pushed`, `stripe-bbf27bf` was never published, and nothing re-ran the step —
// so four consecutive twin-snapshot-verify runs failed and pome-cloud#752
// reported `stripe — no-image` for four days. The file's NAME still says
// cdn-fetches: renaming it would move a required gate's wiring across ci.yml
// and this file's test for no property gained, and shapes (a) and (b)
// are still what most of it does.
//
// F-1534 closed the residual this header used to record at the bottom. With (a)
// and (c) hardened, `sign-image-digests.sh`'s cosign calls were the last
// unretried GHCR interaction in that job, and on 2026-08-18 they were the ones
// that broke: run 32144441622's stripe leg pushed both tags, signed them and
// attested them, then died on `verify-attestation`'s registry READ with
// `DENIED: denied`. A red job over a published, correct artifact. Shape (d) is
// that call site, and it exists so the sign path and the push path cannot drift
// apart again — a gate that covered only the push would stay green through
// exactly the revert that reopened this.
//
// FOUR SHAPES.
//
//   (a) A `run:` block that fetches a remote URL. Detected by scanning every
//       `run:` script for a `curl` / `wget` / `aria2c` / `gh release download`
//       invocation and resolving its target (literal URLs, plus one level of
//       `VAR="https://…"` assignment in the same block). Anything that is not
//       loopback — INCLUDING a target the resolver cannot work out, which is
//       the fail-safe direction — must go through
//       `scripts/ci/fetch-pinned-release.sh`, which is the only place the retry
//       budget, the backoff and the unconditional sha256 check live.
//
//   (b) A `uses:` step for an action that installs a binary. Detected by
//       collecting every non-local `uses:` in the tree and requiring each to
//       have a row in scripts/ci/cdn-fetch-actions.json. Rows marked
//       `repeat-attempts` must appear as a repeated-attempt group: an action
//       step cannot be wrapped in a shell retry loop, so the retry is the step
//       itself, repeated — at least three attempts, each carrying an `id:`, the
//       earlier ones `continue-on-error: true`, every later one gated on
//       `steps.<earlier-id>.outcome == 'failure'` (a SKIPPED step's outcome is
//       `skipped`, never `failure`, so the chain cannot self-trigger), and the
//       LAST attempt carrying no escape hatch at all. That last part is the
//       fail-closed half: a genuinely unavailable CDN still refuses the
//       publish. Every attempt must also carry a byte-identical `uses:` ref and
//       `with:` block, which is what stops a repeated cosign install from
//       drifting one copy off `cosign-release: 'v2.6.4'` — the pin twin-image.yml
//       carries a paragraph of comment defending, because cosign v3
//       `attest --type spdx` rejects the anchore SBOM predicate.
//
//   (c) A `run:` block that WRITES to a container registry — `docker push`,
//       `docker manifest push`, `docker buildx imagetools create`. Same
//       treatment as shape (a): it must go through
//       `scripts/ci/push-scanned-image.sh`, which is the only place the retry
//       budget, the backoff, the per-tag manifest read-back and the fail-closed
//       message live. Registry READS (`docker pull`, `imagetools inspect`) are
//       deliberately not in the list: a read that fails fails the step it is in
//       and publishes nothing, so it cannot leave a tag behind.
//
//   (d) A `run:` block that invokes `cosign`. Same treatment again: it must go
//       through `scripts/ci/sign-image-digests.sh`, which is the only place the
//       per-operation retry budget, the backoff and the fail-closed message
//       naming what is already public live. EVERY subcommand counts, reads
//       included — which is where (d) parts company with (c), and deliberately.
//       Shape (c) exempts reads because a read that fails publishes nothing;
//       here the opposite holds, because this step runs AFTER the push step has
//       published every tag. `cosign verify-attestation`'s read is the exact
//       call that failed on 2026-08-18, and it failed over an artifact that was
//       already correct and already public. Nor is the finder a list of the four
//       subcommands the script runs today: `cosign copy` writes to a registry
//       and `cosign triangulate` reads from one, and an enumeration would be
//       walked around by either.
//
// WHAT THIS GATE CANNOT DERIVE, STATED PLAINLY. Whether a third-party action
// downloads an executable is a fact about that action's implementation, not
// about this repo — nothing in the string `anchore/sbom-action` says "fetches
// syft from a release CDN", and `actions/checkout` looks identical from here.
// So shape (b) is half-derived: the SET OF ACTIONS TO JUDGE comes from the
// workflows (a new `uses:` is discovered the moment it lands, and reds until
// someone classifies it), while the VERDICT PER ACTION is a reviewed row in
// cdn-fetch-actions.json carrying its evidence. Rows are keyed on `owner/repo`,
// so a sha bump keeps the classification and a major rewrite under the same
// name would not be noticed. Three further known holes, recorded rather than
// papered over: a fetch, a registry write or a signing call smuggled through a
// tool this scanner does not know (a python one-liner, a Makefile,
// `crane`/`skopeo`/`oras`) is invisible to shapes (a), (c) and (d); two
// actions are classified `step-is-the-check` — deliberately not retried, because
// retrying a scanner turns "found a secret / found a CVE" into two swallowed
// failures — each with a `residual` field naming what stays exposed; and shape
// (d) matches cosign in COMMAND POSITION only, so `bash -c "cosign …"` and a
// call assembled in a variable are invisible to it (see SIGNING_COMMANDS below
// for why that precision is bought rather than free).
//
// The hole this header used to record as a FOURTH is closed. It read: shape (c)
// covers the IMAGE write only, and every cosign call in
// scripts/ci/sign-image-digests.sh also talks to GHCR with no retry. That was
// measured, not hypothetical — on 2026-08-18 a degraded GHCR took out three of
// run 32144441622's five legs in two different steps: gmail and linear in the
// push (`error parsing HTTP 403 response body` on the first tag, nothing
// published), and stripe on `verify-attestation`'s read with `DENIED: denied`
// AFTER both tags were pushed, signed and attested. Shape (d) above is what
// closes it, and the helper it points at retries per OPERATION rather than
// around the per-tag body — re-signing a digest because the VERIFY could not
// read it is wasted work and a second signature layer over a good one.
//
// Usage: node scripts/ci/assert-hardened-cdn-fetches.mjs
// Exits 1, naming every offender, on:
//   - a `run:` block fetching a non-loopback URL outside the hardened helper
//   - a `run:` block writing to a container registry outside the hardened push
//     helper
//   - a `run:` block invoking cosign outside the hardened sign helper
//   - a `uses:` action with no row in cdn-fetch-actions.json
//   - a row that is internally inconsistent (fetches from a CDN but claims
//     `not-needed`, a `step-is-the-check` row with no `residual`, an empty `why`)
//   - a `repeat-attempts` action used as a single step, or as a group whose
//     last attempt is `continue-on-error`, whose attempts disagree on `uses:`
//     or `with:`, or whose gating `if:` does not reference every earlier attempt
//   - the structural step parse and the flat line scan disagreeing about which
//     actions the tree uses (a parser regression makes the group check vacuous)
//   - zero fetches, zero classified CDN actions, or zero call sites for any of
//     the three hardened helpers (a vacuous green, not a true fact about the
//     tree)

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workflowLines } from "./list-scheduled-workflows.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The hardened fetch path, relative to the repo root. */
export const HELPER = "scripts/ci/fetch-pinned-release.sh";

/** The hardened registry-write path, relative to the repo root (F-1530). */
export const PUSH_HELPER = "scripts/ci/push-scanned-image.sh";

/** The hardened sign/attest/verify path, relative to the repo root (F-1534). */
export const SIGN_HELPER = "scripts/ci/sign-image-digests.sh";

/**
 * The F-1494 pattern is 2 escapable attempts + 1 fatal one. Fewer than three
 * means a single transient 5xx can still reach the fatal attempt on its heels;
 * the ticket's own failure was two 503s minutes apart on consecutive PRs.
 */
export const MIN_ATTEMPTS = 3;

const FETCH_COMMANDS = /(?:^|[\s(`$])(?:curl|wget|aria2c|gh\s+release\s+download)(?=\s|$)/;

/**
 * Every way a `run:` block commits a manifest to a registry (F-1530). Writes
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

/**
 * Every way a `run:` block reaches a registry through cosign (F-1534). ANY
 * subcommand, not a list of the four sign-image-digests.sh runs: `sign` and
 * `attest` write, `verify` and `verify-attestation` read, `copy` writes,
 * `triangulate` reads, and `initialize` pulls the TUF root off a CDN. Every one
 * is a third-party network call on the publish path, which is the property this
 * gate is about — and an enumeration is the list-shaped thing this file's header
 * refuses. A cosign invocation that genuinely needs no hardening does not exist
 * in this tree; if one ever does, it belongs in a reviewed row, not in a widened
 * regex.
 *
 * Matched in COMMAND POSITION, which is where this shape parts company from the
 * `[\s(`$]`-prefixed patterns above. `docker push` reads as a command wherever
 * it appears; `cosign` is also an ENGLISH WORD in this tree — twin-image.yml's
 * three-attempt install ladder annotates every attempt with an
 * `echo "…cosign-installer fetches cosign from…"`, and a rule that read those
 * as invocations would red the whole tree on its own prose, which is a rule
 * someone deletes. So: the start of a segment (behind any prefix a command can
 * hide behind), or immediately inside a command substitution.
 *
 * The trade, stated rather than hidden: a call assembled in a variable or run
 * through `bash -c "cosign …"` is invisible here — the same class of hole this
 * file's header already records for `crane`, `skopeo` and a Makefile.
 */
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

// ---------------------------------------------------------------------------
// Structural read of a workflow file: jobs -> steps -> keys.
//
// Line-based and indentation-anchored, the same stance as
// list-scheduled-workflows.mjs (whose comment-stripped lines this consumes):
// a workflow's own prose contains the literal strings this looks for, and a
// YAML parser is not a dependency this repo's always-on, pre-`npm ci` block can
// take.
// ---------------------------------------------------------------------------

/** Jobs, each with its ordered list of raw step blocks. */
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

/**
 * A step's top-level keys as `name -> { value, lines }`, where `lines` holds
 * the nested block (a `with:` mapping, a `run: |` script body).
 */
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

/** A key's full text, block scalar body included. */
export function keyText(keys, name) {
  const k = keys.get(name);
  if (!k) return null;
  const head = /^[|>][-+]?\d*$/.test(k.value) ? "" : k.value;
  return [head, ...k.lines].join("\n");
}

/** A nested mapping (`with:`) as sorted, dedented, comparable lines. */
export function blockLines(keys, name) {
  const k = keys.get(name);
  if (!k) return null;
  return k.lines
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .sort();
}

// ---------------------------------------------------------------------------
// Shape (a): remote fetches inside `run:` scripts.
// ---------------------------------------------------------------------------

export function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s"'`]+)/i.exec(url);
  if (!m) return null;
  let host = m[1].replace(/^[^@]*@/, "");
  // The port is cut by POSITION, not by a `:\d+$` match: workflow scripts
  // reach loopback through an expansion (`http://127.0.0.1:${port}/healthz`,
  // `:${{ env.PORT }}`), and a digits-only strip leaves `127.0.0.1:${port}` as
  // the "host" — which reads as a remote CDN and reds two smoke workflows that
  // are doing nothing wrong.
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

/**
 * One shell script as `{ text, segments }`: comments dropped, then split at
 * every separator a command can start after.
 *
 * workflowLines() has already stripped YAML comments, which inside a `run: |`
 * block are the same `#` a shell comment uses — so in production this second
 * strip is a no-op. It is here so the rule holds for a script handed straight
 * to one of the finders below: a commented-out fetch is not a fetch, and a gate
 * that read one as a violation is a gate someone deletes.
 */
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

/**
 * Every fetch invocation in one shell script, with the URL it targets when
 * that can be worked out. An unresolvable target is reported as `null`, which
 * every caller must treat as remote — the fail-safe direction.
 */
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

/** Every registry-WRITE invocation in one shell script (F-1530). */
export function findRegistryWritesInScript(script) {
  return shellSegments(script).segments.filter((segment) =>
    REGISTRY_WRITE_COMMANDS.some((command) => command.test(segment)),
  );
}

/** Every cosign invocation in one shell script (F-1534). */
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

/** `run:` blocks that fetch something remote without using the hardened path. */
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

// ---------------------------------------------------------------------------
// Shape (c): registry writes inside `run:` scripts (F-1530).
// ---------------------------------------------------------------------------

/** `run:` blocks that write to a registry without using the hardened path. */
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
              `${segment}. A single \`unknown blob\` from GHCR then fails the leg (F-1530), leaving a commit ` +
              "with no image and nothing to re-run it.",
          );
        }
      }
    }
  }
  return { problems, hardened: hardened.sort() };
}

// ---------------------------------------------------------------------------
// Shape (d): cosign calls inside `run:` scripts (F-1534).
// ---------------------------------------------------------------------------

/** `run:` blocks that invoke cosign without using the hardened path. */
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
              "public artifact (F-1534). Reads are in scope here for exactly that reason, unlike shape (c).",
          );
        }
      }
    }
  }
  return { problems, hardened: hardened.sort() };
}

// ---------------------------------------------------------------------------
// Shape (b): `uses:` steps for binary-installing actions.
// ---------------------------------------------------------------------------

/** `owner/repo` for a `uses:` ref, or null for a local reusable workflow. */
export function actionRepo(ref) {
  if (!ref || ref.startsWith("./") || ref.startsWith(".\\")) return null;
  if (ref.startsWith("docker://")) return ref;
  const [path] = ref.split("@");
  const parts = path.split("/");
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** Flat line scan: every non-local `uses:` in the tree. The SECOND read. */
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

/** Structural read: every non-local `uses:` reached through jobs -> steps. */
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

/** Rows that contradict themselves, and actions with no row at all. */
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

/** One repeated-attempt group, checked against the F-1494 shape. */
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

/** The two reads of "which actions does this tree use" must agree. */
export function findParseDisagreements(root) {
  const byLine = new Set(findActionRefsByLine(root).keys());
  const byStructure = new Set(findActionStepsByStructure(root).map((s) => s.repo));
  const missed = [...byLine].filter((r) => !byStructure.has(r)).sort();
  const extra = [...byStructure].filter((r) => !byLine.has(r)).sort();
  return { missed, extra };
}

// ---------------------------------------------------------------------------

// `table` is injectable so the regression suite can drive the whole assembly
// over a scratch tree — the assertions are about the RULES, not about which
// actions this repo happens to use today.
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

  // Dead guards. Every one of these floors has been at a non-zero value since
  // this gate landed, so a zero here is a parser that stopped matching, not a
  // tree that stopped fetching. A gate that reports "all clear" over nothing
  // is the failure mode this whole file exists to refuse.
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

// NOT `import.meta.main` (Node 24.2+; root `engines` allows >=24, so on
// 24.0/24.1 it is `undefined` and this guard would be false, exiting 0 having
// checked nothing). Same entry-guard idiom as list-scheduled-workflows.mjs.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && basename(ENTRY) === basename(SELF)) {
  throw new Error(
    `assert-hardened-cdn-fetches.mjs entry guard did not fire for ${ENTRY} (expected ${SELF}) — refusing to exit 0 having checked nothing`,
  );
}

if (invokedDirectly) main();
