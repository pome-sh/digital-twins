#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Writes the version numbers main's tip has earned. Owed if EITHER a pending
// `## Unreleased (level)` entry exists OR a publish-relevant path moved since
// the last commit that changed the version.
//
// The unit is main's TIP, never the pushed range, so two merges in one window
// get one number. Loop safety is structural, not a marker match: relevance is
// measured from `lastVersionChange()`, and the bump commit is one.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { planExampleRepins } from "../check-example-pins-published.mjs";
import { bumpVersion, pendingRelease, writeRelease } from "./changelog-entry.mjs";
import { PUBLISHED_PACKAGES, packagesTouchedBy } from "./publish-relevance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const BUMP_COMMIT_MARKER = "[release-bump]";

const VERSION_WALK_LIMIT = 500;

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitLines(root, args) {
  return git(root, args).split("\n").filter(Boolean);
}

function versionAt(root, ref, manifest) {
  try {
    return JSON.parse(git(root, ["show", `${ref}:${manifest}`])).version ?? null;
  } catch {
    return null;
  }
}

export function lastVersionChange(root, manifest) {
  const shas = gitLines(root, ["log", "--format=%H", "--", manifest]);
  for (const sha of shas.slice(0, VERSION_WALK_LIMIT)) {
    if (versionAt(root, sha, manifest) !== versionAt(root, `${sha}^`, manifest)) return { sha };
  }
  return { sha: null, exhausted: shas.length > VERSION_WALK_LIMIT };
}

function derivedEntry({ pkg, files, commits }) {
  const paths = [...new Set(files.map((file) => file.replace(/[^/]+$/, "")))].sort().slice(0, 6);
  return [
    `Version-only release: publish-relevant paths changed and no \`## Unreleased\``,
    `entry was supplied, so this heading is the whole record. \`${pkg.name}\`'s bytes`,
    `moved under ${paths.map((p) => `\`${p}\``).join(", ")}.`,
    "",
    ...(commits.length ? commits.map((line) => `- ${line}`) : ["- (no commit subjects available)"]),
  ].join("\n");
}

export function planAllocations({ root = resolve(HERE, "../.."), date = today(), npmView } = {}) {
  if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error(
      "refusing to allocate versions in a shallow clone: the walk for 'when did this " +
        "version last move' would be truncated, and a truncated walk silently mis-scopes " +
        "which packages are owed a release. Check out with fetch-depth: 0.",
    );
  }

  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const allocations = [];
  const notes = [];

  for (const pkg of PUBLISHED_PACKAGES) {
    const manifestPath = join(root, pkg.manifest);
    const manifest = readFileSync(manifestPath, "utf8");
    const from = JSON.parse(manifest).version;
    const changelogPath = join(root, pkg.changelog);
    const changelog = readFileSync(changelogPath, "utf8");

    const pending = pendingRelease(changelog, pkg.changelog);

    const since = lastVersionChange(root, pkg.manifest);
    if (since.exhausted) {
      notes.push(
        `${pkg.name}: no version change found in the last ${VERSION_WALK_LIMIT} commits touching ` +
          `${pkg.manifest} — measuring relevance against the whole history, which over-allocates.`,
      );
    }
    const range = since.sha ? [since.sha, head] : [head];
    const changed = since.sha ? gitLines(root, ["diff", "--name-only", since.sha, head]) : gitLines(root, ["ls-files"]);
    const relevance = packagesTouchedBy(changed).find((hit) => hit.pkg.name === pkg.name);

    if (!pending && !relevance) continue;

    const level = pending?.level ?? "patch";
    const to = bumpVersion(from, level);
    const commits = since.sha
      ? gitLines(root, [
          "log",
          "--format=%h %s",
          `${since.sha}..${head}`,
          "--",
          ...(relevance?.files ?? []),
        ]).slice(0, 20)
      : [];
    const body = pending?.body || derivedEntry({ pkg, files: relevance?.files ?? [], commits });

    allocations.push({
      name: pkg.name,
      manifest: pkg.manifest,
      changelog: pkg.changelog,
      from,
      to,
      level,
      reason: [pending ? "entry" : null, relevance ? "relevance" : null].filter(Boolean).join("+"),
      relevantFiles: relevance?.files ?? [],
      since: range,
      regenerate: pkg.regenerate ? [pkg.regenerate] : [],
      versionedArtifacts: pkg.versionedArtifacts ?? [],
      writes: [
        { path: pkg.manifest, contents: rewriteVersion(manifest, { from, to, path: pkg.manifest }) },
        {
          path: pkg.changelog,
          contents: writeRelease(changelog, { version: to, date, body, label: pkg.changelog }),
        },
      ],
    });
  }

  let repins = [];
  try {
    repins = npmView ? planExampleRepins(root, npmView) : planExampleRepins(root);
  } catch (err) {
    notes.push(
      `example re-pin planning failed and was SKIPPED so it cannot block this allocation — ${err.message}. ` +
        "check-example-pins-published.mjs still reds on the drift.",
    );
  }

  return { head, date, allocations, repins, notes, message: commitMessage(allocations, repins, head) };
}

function rewriteVersion(manifest, { from, to, path }) {
  const line = (version) => `"version": "${version}"`;
  const occurrences = manifest.split(line(from)).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${path}: expected exactly one \`${line(from)}\`, found ${occurrences}. Refusing to guess ` +
        `which one is the package's own version.`,
    );
  }
  return manifest.replace(line(from), line(to));
}

function commitMessage(allocations, repins, head) {
  if (allocations.length === 0 && repins.length === 0) return "";
  const named = allocations.map((a) => `${a.name} ${a.to}`);
  const subject =
    allocations.length === 0
      ? `chore: re-pin ${repins.length} example dep(s) to the published version ${BUMP_COMMIT_MARKER}`
      : allocations.length <= 2
        ? `release: ${named.join(", ")} ${BUMP_COMMIT_MARKER}`
        : `release: ${allocations.length} packages ${BUMP_COMMIT_MARKER}`;
  return [
    subject,
    "",
    ...allocations.map((a) => `- ${a.name} ${a.from} → ${a.to} (${a.level}, ${a.reason})`),
    ...repins.map((r) => `- agent-examples/${r.example} ${r.dep} ${r.from} → ${r.to} (published pin re-pin)`),
    "",
    `Allocated from ${head.slice(0, 8)} by .github/workflows/allocate-version.yml.`,
    "The version number is written here, after the merge, and never in a PR.",
    "",
  ].join("\n");
}

export function applyAllocations(plan, { root = resolve(HERE, "../..") } = {}) {
  const written = [];
  for (const allocation of [...plan.allocations, ...plan.repins]) {
    for (const write of allocation.writes) {
      writeFileSync(join(root, write.path), write.contents);
      written.push(write.path);
    }
  }
  return written;
}

function today() {
  return process.env.POME_ALLOCATION_DATE ?? new Date().toISOString().slice(0, 10);
}

export function main(argv = process.argv.slice(2)) {
  const flagValue = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const flagValues = new Set(["--plan-out", "--message-out", "--regen-out"].map(flagValue).filter(Boolean));
  const root = resolve(argv.find((arg) => !arg.startsWith("--") && !flagValues.has(arg)) ?? resolve(HERE, "../.."));

  const plan = planAllocations({ root });
  for (const note of plan.notes) console.log(`::warning::${note}`);

  if (plan.allocations.length === 0 && plan.repins.length === 0) {
    console.log(`Nothing to allocate at ${plan.head.slice(0, 8)} — no pending entry, no unreleased`);
    console.log("publish-relevant change, no example pin drifted from an already-published sibling.");
    console.log("(This is what the bump commit's own push looks like.)");
  }
  for (const a of plan.allocations) {
    console.log(`${a.name}: ${a.from} → ${a.to}  (${a.level}, ${a.reason})`);
    for (const file of a.relevantFiles.slice(0, 10)) console.log(`    ${file}`);
    if (a.relevantFiles.length > 10) console.log(`    … ${a.relevantFiles.length - 10} more`);
  }
  for (const r of plan.repins) {
    console.log(`agent-examples/${r.example}: ${r.dep} ${r.from} → ${r.to}  (published pin drift)`);
  }

  const planOut = flagValue("--plan-out");
  if (planOut) writeFileSync(planOut, `${JSON.stringify(plan, null, 2)}\n`);
  const messageOut = flagValue("--message-out");
  if (messageOut) writeFileSync(messageOut, plan.message);
  const regenOut = flagValue("--regen-out");
  if (regenOut) {
    const commands = [...plan.allocations, ...plan.repins].flatMap((a) => a.regenerate);
    writeFileSync(regenOut, commands.length ? `set -euo pipefail\n${commands.join("\n")}\n` : "");
  }

  if (argv.includes("--write")) {
    const written = applyAllocations(plan, { root });
    for (const path of written) console.log(`wrote ${path}`);
  }
  return plan;
}

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("allocate-release-versions.mjs")) {
  throw new Error(`allocate-release-versions.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) main();
