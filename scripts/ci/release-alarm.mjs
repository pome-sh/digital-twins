#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Does every version main declares reach its registry? Its own cron, in its own
// workflow, so the alarm survives a release.yml that never triggered.
//
// Targets are parsed out of release.yml, never listed here; `--targets` reds if
// the parse finds none. UNMEASURED never folds into UNPUBLISHED — a 401 reads
// identically to "nothing published yet".

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pendingRelease } from "./changelog-entry.mjs";
import { PUBLISHED_PACKAGES } from "./publish-relevance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELEASE_WORKFLOW = "release.yml";
const ALLOCATE_WORKFLOW = "allocate-version.yml";

export function parseTargets(root) {
  const targets = readTargets(root);
  for (const t of targets) {
    if (!existsSync(join(root, t.manifest))) {
      throw new Error(`${RELEASE_WORKFLOW} points ${t.name} at ${t.manifest}, which does not exist`);
    }
  }
  return targets;
}

export function readTargets(root) {
  const file = join(root, ".github/workflows", RELEASE_WORKFLOW);
  if (!existsSync(file)) throw new Error(`${RELEASE_WORKFLOW} not found at ${file}`);
  const yaml = readFileSync(file, "utf8");
  const re = /decide-publish\.sh\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"(?:\s+"([^"]+)")?/g;

  const targets = [];
  for (const [, name, manifest, outputKey, registry] of yaml.matchAll(re)) {
    targets.push({ name, manifest, outputKey, registry: registry ?? "" });
  }
  if (targets.length === 0) {
    throw new Error(
      `no decide-publish.sh calls found in ${RELEASE_WORKFLOW}. Either the release ` +
        `stopped using it or this parser has drifted — an alarm watching zero ` +
        `packages passes forever, so this is a hard failure, not an empty run.`,
    );
  }
  return targets;
}

export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = ""] = String(v).split("-");
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function registryVersion(name, registry) {
  const args = ["view", name, "version", ...(registry ? ["--registry", registry] : [])];
  const r = spawnSync("npm", args, { encoding: "utf8" });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === 0) return { version: r.stdout.trim() };
  if (/E404|404 Not Found/.test(output)) return { version: "0.0.0", unpublished: true };
  return { error: output.trim().split("\n").filter(Boolean).slice(-2).join(" / ") || "unknown npm error" };
}

const minutesSince = (iso, now) => (now - Date.parse(iso)) / 60_000;

function newestFirst(runs) {
  return [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

function runUrl(repo, run) {
  return `https://github.com/${repo}/actions/runs/${run.id}`;
}

function inspectReleaseRuns({ repo, head, runs, now, graceMinutes, stuckMinutes }) {
  const alarms = [];
  const lines = [];
  const headAge = minutesSince(head.date, now);
  const forHead = runs.filter((r) => r.head_sha === head.sha);
  const inFlight = runs.filter((r) => r.status !== "completed");
  const newestCompleted = runs.find((r) => r.status === "completed");

  lines.push(
    `main HEAD ${head.sha.slice(0, 8)} (${headAge.toFixed(0)} min old) — ` +
      (forHead.length
        ? forHead.map((r) => `${r.status}/${r.conclusion ?? "—"} ${runUrl(repo, r)}`).join(", ")
        : "NO release run"),
  );
  lines.push(
    `newest completed release run: ` +
      (newestCompleted
        ? `${newestCompleted.conclusion} ${runUrl(repo, newestCompleted)}`
        : "none in the window"),
  );

  if (forHead.length === 0 && headAge > graceMinutes) {
    alarms.push(
      `NEVER_RAN — main's HEAD ${head.sha.slice(0, 8)} has been on main for ` +
        `${headAge.toFixed(0)} min (grace ${graceMinutes}) and \`${RELEASE_WORKFLOW}\` never ran on it. ` +
        `A push that triggers nothing publishes nothing, and reports nothing.`,
    );
  }

  const hung = inFlight.filter((r) => minutesSince(r.created_at, now) > stuckMinutes);
  if (hung.length > 0) {
    alarms.push(
      `STUCK — a \`${RELEASE_WORKFLOW}\` run has been ${hung[0].status} for ` +
        `${minutesSince(hung[0].created_at, now).toFixed(0)} min (limit ${stuckMinutes}): ` +
        `${runUrl(repo, hung[0])}. \`cancel-in-progress: false\` means it holds the ` +
        `concurrency lock, so every release behind it is waiting too.`,
    );
  }

  const newerInFlight =
    newestCompleted &&
    inFlight.some((r) => Date.parse(r.created_at) > Date.parse(newestCompleted.created_at));
  if (
    newestCompleted &&
    !["success", "skipped"].includes(newestCompleted.conclusion) &&
    !newerInFlight
  ) {
    alarms.push(
      `FAILED — the newest completed \`${RELEASE_WORKFLOW}\` run on main concluded ` +
        `${newestCompleted.conclusion}: ${runUrl(repo, newestCompleted)}. Nothing newer is in flight.`,
    );
  }

  return { alarms, lines, headAge, forHead, inFlight };
}

function inspectPendingEntries({ root }) {
  const alarms = [];
  const lines = [];

  for (const pkg of PUBLISHED_PACKAGES) {
    const file = join(root, pkg.changelog);
    if (!existsSync(file)) {
      alarms.push(
        `UNMEASURED — ${pkg.changelog} is missing, so nothing here can say whether ` +
          `${pkg.name} is waiting for a version number.`,
      );
      continue;
    }
    let pending;
    try {
      pending = pendingRelease(readFileSync(file, "utf8"), pkg.changelog);
    } catch (error) {
      alarms.push(
        `UNALLOCATED — ${pkg.changelog} cannot be read as a release request: ${error.message} ` +
          `allocate-version.yml fails on the same parse, so nothing is being allocated.`,
      );
      continue;
    }
    if (!pending) continue;
    lines.push(`${pkg.name} — pending ${pending.level} entry awaiting a number`);
    alarms.push(
      `UNALLOCATED — ${pkg.changelog} carries a pending \`## Unreleased (${pending.level})\` entry ` +
        `that no allocation consumed. \`${ALLOCATE_WORKFLOW}\` writes the number on main after the ` +
        `merge, so nothing has published this and the registry agrees with main about the OLD ` +
        `version — the outcome check below cannot see it.`,
    );
  }

  return { alarms, lines };
}

function inspectRegistries({ root, targets, readVersion }) {
  const alarms = [];
  const lines = [];

  for (const t of targets) {
    const where = t.registry || "registry.npmjs.org";
    const declared = JSON.parse(readFileSync(join(root, t.manifest), "utf8")).version;
    const seen = readVersion(t.name, t.registry);

    if (seen.error) {
      lines.push(`${t.name} @ ${where} — declared ${declared}, registry UNREADABLE`);
      alarms.push(
        `UNMEASURED — could not read ${t.name} from ${where}: ${seen.error}. ` +
          `This is NOT "unpublished": an auth or transport error for a package that ` +
          `exists reads identically to one that does not, and only one of those is an outage.`,
      );
      continue;
    }

    const order = compareVersions(declared, seen.version);
    lines.push(
      `${t.name} @ ${where} — declared ${declared}, registry ${seen.unpublished ? "(nothing published)" : seen.version}` +
        (order === 0 ? " ✓" : ""),
    );
    if (order > 0) {
      alarms.push(
        `UNPUBLISHED — ${t.name} ${declared} is on main but ${where} serves ` +
          `${seen.unpublished ? "nothing" : seen.version}. Consumers install the old one.`,
      );
    } else if (order < 0) {
      alarms.push(
        `BEHIND — ${t.name} declares ${declared} on main while ${where} already serves ` +
          `${seen.version}. decide-publish.sh hard-fails on this, so the next merge that ` +
          `touches ${t.manifest.replace(/\/package\.json$/, "/")} fails its whole lane.`,
      );
    }
  }

  return { alarms, lines };
}

export function check({
  root,
  repo,
  now,
  readVersion = registryVersion,
  gitHub = gh,
  graceMinutes = Number(process.env.GRACE_MINUTES ?? 90),
  stuckMinutes = Number(process.env.STUCK_MINUTES ?? 360),
}) {
  const targets = parseTargets(root);

  const headCommit = JSON.parse(gitHub(["api", `repos/${repo}/commits/main`]) || "{}");
  const head = {
    sha: headCommit.sha ?? "",
    date: headCommit.commit?.committer?.date ?? headCommit.commit?.author?.date ?? "",
  };
  if (!head.sha || !head.date) throw new Error(`could not read main's HEAD commit for ${repo}`);

  const runs = newestFirst(
    JSON.parse(
      gitHub([
        "api",
        `repos/${repo}/actions/workflows/${RELEASE_WORKFLOW}/runs?branch=main&per_page=30`,
      ]) || "{}",
    ).workflow_runs ?? [],
  );

  const path = inspectReleaseRuns({ repo, head, runs, now, graceMinutes, stuckMinutes });
  const lines = [...path.lines, ""];
  const alarms = [...path.alarms];

  if (path.headAge > graceMinutes) {
    const allocation = inspectPendingEntries({ root });
    lines.push(...allocation.lines);
    alarms.push(...allocation.alarms);
    const registries = inspectRegistries({ root, targets, readVersion });
    lines.push(...registries.lines);
    alarms.push(...registries.alarms);
  } else {
    lines.push(
      `registry drift and pending allocations not evaluated — HEAD is ` +
        `${path.headAge.toFixed(0)} min old (grace ${graceMinutes}); its number may still be ` +
        `being allocated and its release may still be building.`,
    );
  }

  return { alarms, report: lines.join("\n"), targets };
}

export function main(argv = process.argv.slice(2)) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const root = resolve(argv.find((a) => !a.startsWith("--")) ?? join(HERE, "../.."));

  if (flags.includes("--targets")) {
    const targets = parseTargets(root);
    for (const t of targets) {
      console.log(`${t.name}  ←  ${t.manifest}  →  ${t.registry || "registry.npmjs.org"}`);
    }
    console.log(`✅ ${RELEASE_WORKFLOW} declares ${targets.length} publish target(s).`);
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  const now = Number(process.env.NOW_MS ?? Date.now());

  const { alarms, report } = check({ root, repo, now });
  const reason = alarms.join("\n");
  console.log(report);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `alarm=${alarms.length ? "true" : "false"}\n` +
        `reason<<POME_EOF\n${reason}\nPOME_EOF\n` +
        `report<<POME_EOF\n${report}\nPOME_EOF\n`,
    );
  }

  if (alarms.length > 0) {
    for (const a of alarms) console.error(`::error::${a}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n✅ Every version main declares is on its registry, and the release path is alive.");
}

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("release-alarm.mjs")) {
  throw new Error(`release-alarm.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) main();
