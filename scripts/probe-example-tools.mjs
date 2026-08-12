#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1152 example twin-tool probe gate.
//
// `examples/pr-summary-agent` and `examples/pr-summary-review` each exposed
// exactly one comment tool, `comment_on_pull_request`, wrapping
// `add_issue_comment` at the pull request's number. The GitHub twin answered
// `404 Issue not found` for every one of those calls, on all four subjects, for
// as long as the examples had existed — and both examples' whole subject is
// *did the agent leave a summary*. F-1151 fixed the twin. Nothing had noticed,
// because the two older example gates each stop short of a twin call:
//
//   scripts/typecheck-examples.mjs — compiles each example. A tool whose
//     arguments are well-typed and whose endpoint 404s is green.
//   scripts/smoke-examples.mjs     — launches each example and fails on a
//     crash-on-load. It exits before any tool runs, deliberately, because a
//     real run needs a model.
//
// This gate closes that gap without a model: boot each example's declared twins
// in-process on the example's OWN task seed, then invoke every tool the example
// registers once with fixture arguments and fail if the twin refused.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DRIVER = join(HERE, "example-tool-probe-driver.mjs");

/**
 * The session id the gate mints its bearer for, and the secret it signs with.
 * The twin's auth middleware rejects a JWT whose `sid` disagrees with the URL,
 * so both halves of the gate read these.
 */
export const PROBE_SID = "probe";
export const PROBE_SECRET = "pome-f1152-probe-gate-secret-32-chars";

/** Bind port 0, read what the OS assigned, release it. */
export async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * Make sure `@pome-sh/wire` is built before `fn` imports a twin under plain
 * `node`.
 *
 * Every twin's runtime import chain reaches the wire contract, so nothing here
 * can `import("@pome-sh/twin-github")` until wire's `dist/` exists. ci.yml runs
 * `npm run build` before this gate, which covers it; the build below is the
 * fallback for the bare `npm run probe:examples` a developer types.
 *
 * Build only when `dist/` is ABSENT, never unconditionally: wire's build opens
 * with `rm -rf dist`, so an unconditional rebuild here briefly deletes the
 * artifact every other workspace resolves `@pome-sh/wire` through. Anything
 * running alongside this gate dies with ERR_MODULE_NOT_FOUND on
 * `@pome-sh/wire/dist/index.js` — a failure that names the wrong culprit
 * entirely. A stale dist is the caller's problem to fix with `npm run build`;
 * a missing one is what this exists for.
 *
 * Before F-942 this helper also had to CLEAN UP after itself: shared-types
 * exported `./src/index.ts` with no dist build, so the only way to load it under
 * `node` was `build:runtime`'s in-place `.js` emit beside each `.ts` — untracked
 * files that shadowed the sources and reddened `lint:dead-code` if left behind.
 * wire builds to `dist/` like every other package, so there is nothing to undo.
 */
export async function withWireRuntime(fn) {
  if (!existsSync(join(REPO_ROOT, "packages/wire/dist/index.js"))) {
    execFileSync("npm", ["run", "build", "-w", "@pome-sh/wire"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
  }
  return await fn();
}

/**
 * Hand each declared twin its slice of a task seed.
 *
 * This mirrors `cli/src/task/parseTask.ts` rather than inventing a second answer
 * to "is this seed an envelope", because two answers is how a seed silently
 * lands in the wrong world (the failure F-987 fixed in the seed compiler). The
 * contract there, verbatim in three parts:
 *
 *   1. Envelope-iff-multi-twin, decided from the declared twin list ALONE —
 *      "never by sniffing the seed shape". One twin ⇒ the seed is flat.
 *   2. Envelope keys are a SUBSET of the declared twins. A twin with no key
 *      falls back to its own default seed (`undefined` here, which is what
 *      `serve()` treats as "seed the default world"). A key that is not a
 *      declared twin is a loud error.
 *   3. `_meta` (source hash, model, compiled_at) is stripped before schema
 *      parsing. It is not optional politeness: the gmail twin's seed schema is
 *      strict and rejects the key outright.
 */
export function splitSeed(seed, twinIds) {
  const stripped = stripSeedMeta(seed);

  if (twinIds.length === 1) return { [twinIds[0]]: stripped };

  const keys = Object.keys(stripped ?? {});
  const unknown = keys.filter((key) => !twinIds.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `seed is a per-twin envelope with key(s) [${unknown.join(", ")}] that the example does not ` +
        `declare (declares: [${twinIds.join(", ")}])`,
    );
  }
  // A declared twin with no envelope key gets `undefined` → its default world.
  return Object.fromEntries(twinIds.map((id) => [id, stripSeedMeta(stripped?.[id])]));
}

/** `stripSidecarMeta` from cli/src/task/parseTask.ts. */
function stripSeedMeta(seed) {
  if (seed && typeof seed === "object" && !Array.isArray(seed)) {
    const { _meta, ...rest } = seed;
    return rest;
  }
  return seed;
}

/**
 * Fill a manifest `config` template with the URLs of the twins just booted.
 *
 * The three frameworks the examples use want different config shapes
 * (`{mcpUrl, token}`, `{ghUrl, ghToken, slackUrl, slackToken}`,
 * `{restUrl, authToken}`), so the manifest declares the shape and the parent
 * substitutes: `$<twin>.rest`, `$<twin>.mcp`, `$token`. An unresolvable token
 * is an error — a silently-undefined URL would make every probe fail for the
 * wrong reason.
 */
export function resolveConfig(template, ctx) {
  const out = {};
  for (const [key, value] of Object.entries(template ?? {})) {
    out[key] = typeof value === "string" && value.startsWith("$") ? resolveToken(value, ctx) : value;
  }
  return out;
}

function resolveToken(token, ctx) {
  if (token === "$token") return ctx.token;
  const match = /^\$([a-z]+)\.(rest|mcp)$/.exec(token);
  if (!match) throw new Error(`unresolvable config token ${token}`);
  const [, twin, surface] = match;
  const booted = ctx.twins[twin];
  if (!booted) {
    throw new Error(
      `unresolvable config token ${token}: twin "${twin}" was not booted ` +
        `(booted: ${Object.keys(ctx.twins).join(", ") || "none"})`,
    );
  }
  return booted[surface];
}

/**
 * Every `.seed.json` an example ships, sorted for a stable probe order.
 *
 * F-1163: `probe:examples` used to probe only the one seed each manifest entry
 * hand-named. `pr-summary-review` ships 3, both viktor examples ship 6 — 13 of
 * 20 seeds across the bundled examples were never probed at all, and a new
 * seed landed uncovered by construction, since nothing read the directory.
 * Discovery instead of a hand-kept list is what makes a new seed covered with
 * no edit here.
 *
 * A `tasks/` directory with zero seeds is a loud failure, not an empty probe
 * set: an example whose manifest entry exists but whose seeds all got deleted
 * (or renamed) must not read as "probed nothing, still green."
 */
export function discoverSeeds(exampleDir) {
  const tasksDir = join(exampleDir, "tasks");
  const seeds = existsSync(tasksDir)
    ? readdirSync(tasksDir)
        .filter((name) => name.endsWith(".seed.json"))
        .sort()
        .map((name) => join("tasks", name))
    : [];
  if (seeds.length === 0) {
    throw new Error(`${exampleDir} declares no *.seed.json under tasks/ — nothing to probe`);
  }
  return seeds;
}

/**
 * Every top-level example directory that ships at least one `.seed.json`.
 *
 * This is the OTHER half of the totality the manifest owes: discovery covers
 * a new seed inside an already-listed example, but a brand-new example
 * directory with its own seeds and no manifest entry would still be silently
 * skipped by `runGate`'s `Object.keys(manifest)` loop. Comparing this set
 * against the manifest's keys in `runGate` is what makes that omission red
 * instead of quiet — `examples/support-triage` ships no `.seed.json` at all
 * (its tasks are markdown prompts, a different format this gate does not
 * cover) and is correctly absent from both sides by construction, with no
 * exclusion list naming it.
 */
export function discoverExamplesWithSeeds(examplesDir) {
  return readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(examplesDir, name, "tasks")))
    .filter((name) =>
      readdirSync(join(examplesDir, name, "tasks")).some((file) => file.endsWith(".seed.json")),
    )
    .sort();
}

/**
 * The first repo, PR number and issue number a seed carries, for `resolveArgs`
 * to fill probe argument templates with.
 *
 * F-1163: hand-writing six near-identical probe arg sets per viktor example
 * (one per seed) is the defect the ticket names, not a workaround for it — a
 * seventh seed would land with no probe arguments and nothing would say so.
 * Reading the subject straight off the seed means a new seed is covered by
 * construction. Only what the seed actually declares is exposed: a seed with
 * no PR (`triage-agent`) yields no `pr` bucket, and a probe template that
 * still asks for `$pr.number` fails loudly in `resolveFactToken` rather than
 * silently probing `undefined`.
 *
 * `slice` is the twin's OWN half of the seed (already run through
 * `splitSeed`), never the raw envelope — a multi-twin example's slack half has
 * no `repositories` key to read this off of.
 */
export function deriveSeedFacts(slice) {
  const repo = slice?.repositories?.[0];
  if (!repo) return {};
  const facts = { repo: { owner: repo.owner, name: repo.name } };
  const pr = repo.pull_requests?.[0];
  // `last_number` exists because the subject a probe wants is not always the
  // first PR: `merge-agent`'s seed is `01-identity-spoof` and its SECOND pull
  // request is the impersonator's, which is the one `request_changes` is
  // interesting against. Hand-writing `2` there is what F-1163 removed; naming
  // the last PR keeps the same subject with no per-seed number, and collapses
  // to `number` for the 18 seeds that ship exactly one PR.
  if (pr) {
    facts.pr = {
      number: pr.number,
      last_number: repo.pull_requests.at(-1).number,
      merge_blocked: mergeWouldConflict(pr),
    };
  }
  const issue = repo.issues?.[0];
  if (issue) facts.issue = { number: issue.number };
  const file = repo.files?.[0];
  // `file.branch` when the seed names one, NOT `default_branch` unconditionally:
  // a seed whose first file exists only on a feature branch would otherwise be
  // probed at `path@main`, and the resulting 404 would read as "the twin refuses
  // get_file_contents" when the truth is the gate asked for the wrong ref. All
  // 20 seeds today happen to list a default-branch file first, which is exactly
  // why nothing would have caught the 21st that does not.
  if (file) facts.file = { path: file.path, ref: file.branch ?? repo.default_branch };
  return facts;
}

/**
 * Whether the twin will 409 a merge of this PR, read off the seed.
 *
 * Derived, never declared per-seed by hand: `03-failing-ci` sets `ci/test` to
 * `failure` on purpose so a real GitHub blocks the merge behind branch
 * protection, and a `merge_pull_request` probe against that seed must expect the
 * 409 rather than report it as a refusal. That is a fact the seed already
 * carries — a hand-kept map from seed filename to expected status is the same
 * shape as the bug D5 is about, and it goes stale in silence when the seed is
 * renamed, deleted, or has its statuses changed.
 *
 * The condition is "the twin will refuse this merge", not "checks are failing":
 * `mergePullRequest` (packages/twin-github/src/domain/pulls.ts) 409s on THREE
 * things — a non-open PR, an already-merged one, and a `failure` combined
 * status. Only two are expressible in a seed (its PR schema has `state` but no
 * `merged`), and both are covered here, so a future seed whose first PR is
 * closed is exempt for the right reason instead of reding as a refusal.
 *
 * The status half mirrors `combinedStatusJson` in
 * packages/twin-github/src/serializers.ts, which is what `mergePullRequest`
 * reads through `latestCommitStatuses`: latest status per context, any
 * `failure`/`error` wins. A `Map` built from the array keeps the LAST entry per
 * context, and seeded statuses share a timestamp so the twin's own
 * `updated_at DESC, id DESC` ordering also resolves to last-declared-wins.
 */
function mergeWouldConflict(pr) {
  if ((pr.state ?? "open") !== "open") return true;
  const latest = new Map((pr.statuses ?? []).map((status) => [status.context, status.state]));
  return [...latest.values()].some((state) => state === "failure" || state === "error");
}

/**
 * Fill a probe's `args` template with facts read off its own seed.
 *
 * Mirrors `resolveConfig` below, but over seed-derived facts (`$repo.owner`,
 * `$pr.number`, `$issue.number`, `$file.path`, `$file.ref`) instead of booted
 * twin URLs. A value that is not a `$`-prefixed string passes through
 * unchanged — probe text like `"F-1152 probe."` or a slack channel id is not
 * "the first repo, PR number and issue number" the ticket asks to derive, and
 * stays hand-written.
 */
export function resolveArgs(argsTemplate, facts) {
  const out = {};
  for (const [key, value] of Object.entries(argsTemplate ?? {})) {
    out[key] = typeof value === "string" && value.startsWith("$") ? resolveFactToken(value, facts) : value;
  }
  return out;
}

function resolveFactToken(token, facts) {
  const match = /^\$(repo|pr|issue|file)\.([a-z_]+)$/.exec(token);
  if (!match) throw new Error(`unresolvable probe token ${token}`);
  const [, group, field] = match;
  const bucket = facts[group];
  if (!bucket || bucket[field] === undefined) {
    throw new Error(`unresolvable probe token ${token}: this seed has no ${group}.${field}`);
  }
  return bucket[field];
}

/**
 * The six ways this gate goes red. Ordered most-actionable first so a wall of
 * unprobed-tool findings never buries a real refusal.
 *
 * `refused` reads the WIRE status, never the handler's return value: the
 * AI-SDK and LangGraph examples' `gh()` / `twinFetch()` deliberately swallow a
 * 4xx and hand the model `{ok:false,status}` so one bad call cannot abort the
 * run, so `threw` is silent on exactly the failure this gate exists to catch.
 *
 * `silent-probe` is the class the LangGraph shape gap belonged to, guarded here
 * rather than fixed one framework at a time. Reading only the wire status has a
 * floor the original gate had no assertion for: NO wire call at all reduces to
 * `status = 0`, which is `< 400`, which reads as "the twin did not refuse". Every
 * probe against `examples/minimal-viktor-langgraph` produced `calls: []` from the
 * day it shipped, because the driver recognised `handler`/`execute` and LangChain
 * tools expose `.invoke()` — and the gate reported OK for all of it. Adding a
 * third shape to the driver fixes that instance; asserting that every probe
 * actually reached a twin is what makes the FOURTH shape red on the day it lands.
 */
export function evaluateProbeRun({ example, seed, probes, report }) {
  const findings = [];
  const at = (kind, tool, detail) => findings.push({ kind, example, seed, tool, detail });

  if (report.error) {
    at("driver-error", null, report.error);
    return findings;
  }

  const registered = report.toolNames ?? [];
  const byTool = new Map(report.probes.map((probe) => [probe.tool, probe]));

  for (const probe of probes) {
    if (!registered.includes(probe.tool)) {
      at(
        "unknown-tool",
        probe.tool,
        `probed but the example registers no such tool (registers: ${registered.join(", ") || "none"})`,
      );
      continue;
    }
    const observed = byTool.get(probe.tool);
    if (!observed) {
      at("driver-error", probe.tool, "the driver reported no result for this probe");
      continue;
    }
    if (observed.calls.length === 0) {
      at(
        "silent-probe",
        probe.tool,
        "the tool was invoked but made zero HTTP calls to any twin, so this probe asserted nothing" +
          (observed.threw ? ` — the driver reported: ${observed.threw}` : ""),
      );
      continue;
    }
    // Non-null: the zero-call case returned above. The `refused` branch below
    // reads `worst.method`/`worst.url` unguarded and now genuinely can.
    const worst = observed.calls.reduce((acc, call) => (call.status > acc.status ? call : acc));
    const status = worst.status;

    if (probe.expect_status !== undefined) {
      if (status === probe.expect_status) continue;
      at(
        "stale-expect",
        probe.tool,
        `declares expect_status ${probe.expect_status} (${probe.why}) but the twin answered ${status} — ` +
          "drop the exemption",
      );
      continue;
    }
    if (status >= 400) {
      at(
        "refused",
        probe.tool,
        JSON.stringify({ status, method: worst.method, url: worst.url, args: probe.args, threw: observed.threw }),
      );
    }
  }

  for (const tool of registered) {
    if (!probes.some((probe) => probe.tool === tool)) {
      at("unprobed-tool", tool, "registered by the example but no probe declares fixture arguments for it");
    }
  }

  return findings;
}

/**
 * Enrich each `refused` finding with the twin's own account of the call: the
 * ACTION the tool named (F-1125 stamps it even on a failure row, on both the
 * MCP and REST surfaces) and the error text. The wire told us a request was
 * refused; the tape tells us which twin action refused it and why, which is the
 * difference between a gate you can act on and a second thing to debug.
 */
export function annotateFromTape(findings, events) {
  return findings.map((finding) => {
    if (finding.kind !== "refused") return finding;
    const wire = JSON.parse(finding.detail);
    const row = events.find(
      (event) => event.status === wire.status && event.method === wire.method && wire.url.endsWith(event.path),
    );
    return {
      ...finding,
      detail: JSON.stringify({
        ...wire,
        twin: row?.twin ?? null,
        action: row?.tool ?? null,
        error: row?.error ?? null,
      }),
    };
  });
}

const HEADLINE = {
  refused: "the twin refused this tool's call",
  "silent-probe": "the probe never reached a twin, so it asserted nothing",
  "unprobed-tool": "no probe covers this registered tool",
  "unknown-tool": "probe names a tool the example does not register",
  "stale-expect": "expect_status exemption no longer applies",
  "driver-error": "the probe driver could not run this example",
};

export function formatFindings(findings) {
  const lines = [];
  for (const [example, group] of groupBy(findings, (finding) => finding.example)) {
    lines.push(`FAILED  examples/${example}`);
    for (const finding of group) {
      lines.push(`  ${finding.tool ? `tool ${finding.tool}` : "example"} — ${HEADLINE[finding.kind]}`);
      if (finding.kind === "refused") {
        const detail = JSON.parse(finding.detail);
        lines.push(
          `    ${detail.twin ?? "twin"} twin answered ${detail.status}   ${detail.method} ${detail.url}` +
            (detail.action ? `   (action: ${detail.action})` : ""),
        );
        if (detail.error) lines.push(`    "${detail.error}"`);
        lines.push(`    seed: ${finding.seed}`);
        lines.push(`    args: ${JSON.stringify(detail.args)}`);
      } else {
        lines.push(`    ${finding.detail}`);
        // Every finding names its seed, not just `refused`. An example ships up
        // to six seeds and a `silent-probe` or `stale-expect` on one of them is
        // unactionable without knowing which.
        if (finding.seed) lines.push(`    seed: ${finding.seed}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/**
 * Import specifier, definition export, and database opener per twin id.
 *
 * The three twins the bundled examples actually declare, and no more. The export
 * names are NOT uniform across the twin packages, so each is spelled out rather
 * than derived: the opener is `open<Name>CloneDatabase` for github but
 * `open<Name>TwinDatabase` for slack and gmail. Each opener migrates the schema
 * itself (`openTwinDatabase(path, { migrate })`), so `":memory:"` is ready to
 * serve with no separate migrate step.
 *
 * stripe and linear are deliberately absent: no bundled example declares them,
 * and both export a `create<Name>TwinDefinition()` FACTORY rather than a
 * definition constant, so they would need a different shape here. An example
 * that declares an unlisted twin gets the loud error in `probeExample`, which is
 * the right failure — a guessed export name would throw something far less
 * legible.
 */
export const TWIN_MODULES = {
  github: { pkg: "@pome-sh/twin-github", definition: "githubTwinDefinition", open: "openGitHubCloneDatabase" },
  slack: { pkg: "@pome-sh/twin-slack", definition: "slackTwinDefinition", open: "openSlackTwinDatabase" },
  gmail: { pkg: "@pome-sh/twin-gmail", definition: "gmailTwinDefinition", open: "openGmailTwinDatabase" },
};

/**
 * Boot every twin the example declares, run its probes, return findings.
 *
 * Twins run IN-PROCESS here (no model, no Docker, no network beyond loopback)
 * while the example's tools run in a child under the example's own `tsx`, which
 * is how a real `pome run` resolves them.
 *
 * Callers must already be inside `withWireRuntime`.
 */
export async function probeExample(name, entry, opts) {
  const exampleDir = join(opts.examplesDir, name);
  const manifest = JSON.parse(readFileSync(join(exampleDir, "pome.json"), "utf8"));
  const twinIds = manifest.twins ?? ["github"];
  const slices = splitSeed(JSON.parse(readFileSync(join(exampleDir, entry.seed), "utf8")), twinIds);
  const facts = deriveSeedFacts(slices.github);
  // `evaluateProbeRun` keys the driver's results by tool name, so two probes for
  // the same tool would both be judged against the LAST one's result and the
  // first one's arguments would be silently unchecked — the same shape as the
  // silence this gate exists to break. One probe per tool.
  const duplicated = entry.probes
    .map((probe) => probe.tool)
    .filter((tool, index, all) => all.indexOf(tool) !== index);
  if (duplicated.length > 0) {
    throw new Error(
      `examples/${name} declares more than one probe for tool(s) [${[...new Set(duplicated)].join(", ")}] — ` +
        "results are keyed by tool name, so only the last would be judged",
    );
  }
  const probes = entry.probes.map((probe) => {
    try {
      const resolved = { ...probe, args: resolveArgs(probe.args, facts) };
      // Some seeds deliberately break a tool for a REASON the seed itself
      // encodes — `03-failing-ci` sets a failing required status check
      // specifically so a real GitHub 409's the merge, mirroring branch
      // protection. That is fidelity, not a defect, but it is fidelity ONE
      // seed manufactures on purpose: a flat `expect_status` checked against
      // every seed the example ships would misreport every OTHER seed's
      // successful merge as a stale exemption.
      //
      // `expect_status_if` names the SEED FACT that earns the exemption rather
      // than the seed filename, so the condition travels with the seed. A map
      // keyed by filename goes stale in silence — rename or delete the seed and
      // the entry simply stops matching — and a new seed with failing CI would
      // have to be added to it by hand. This way both are automatic: any seed
      // whose first PR has a failing required check expects the 409, any seed
      // whose does not gets the ordinary refusal check, and if the twin ever
      // stops 409ing behind a failing check the exemption reds as `stale-expect`.
      if (probe.expect_status_if !== undefined && resolveFactToken(probe.expect_status_if, facts) !== true) {
        delete resolved.expect_status;
      }
      return resolved;
    } catch (err) {
      throw new Error(`examples/${name} (${entry.seed}), tool ${probe.tool}: ${err.message}`);
    }
  });

  process.env.TWIN_AUTH_SECRET = PROBE_SECRET;
  const { serve, createRecorderStore } = await import("@pome-sh/sdk/server");
  const { sign } = await import("hono/jwt");

  const booted = [];
  const urls = {};
  const stores = {};
  for (const id of twinIds) {
    const twinModule = TWIN_MODULES[id];
    if (!twinModule) {
      throw new Error(
        `examples/${name} declares twin "${id}", which this gate cannot boot ` +
          `(knows: ${Object.keys(TWIN_MODULES).join(", ")})`,
      );
    }
    const mod = await import(twinModule.pkg);
    const port = await freePort();
    const store = createRecorderStore();
    booted.push(
      await serve(mod[twinModule.definition], {
        port,
        hostname: "127.0.0.1",
        db: mod[twinModule.open](":memory:"),
        seed: slices[id],
        recorder: store,
        runId: "probe",
      }),
    );
    const base = `http://127.0.0.1:${port}`;
    urls[id] = { rest: `${base}/s/${PROBE_SID}`, mcp: `${base}/s/${PROBE_SID}/mcp` };
    stores[id] = store;
  }

  try {
    const token = await sign(
      { sid: PROBE_SID, team_id: "tm_probe", login: "pome-agent", exp: Math.floor(Date.now() / 1000) + 3600 },
      PROBE_SECRET,
    );
    const report = await runDriver(exampleDir, {
      module: resolve(exampleDir, entry.module),
      export: entry.export,
      config: resolveConfig(entry.config, { twins: urls, token }),
      probes,
    });
    const tape = twinIds.flatMap((id) => stores[id].events().map((event) => ({ ...event, twin: id })));
    return annotateFromTape(
      evaluateProbeRun({ example: name, seed: entry.seed, probes, report }),
      tape,
    );
  } finally {
    for (const twin of booted) await twin.close();
  }
}

/**
 * Spawn the driver in the example's tree and parse its NDJSON.
 *
 * `tsx` when the example has one (its tool table is TypeScript and resolves that
 * example's own zod / `file:`-linked adapter copies); bare `node` otherwise,
 * which is what lets the test suite drive fixture examples that ship a `.mjs`
 * tool table and need no install.
 *
 * Asynchronous on purpose. The twins serve from THIS process's event loop, so a
 * `spawnSync` here would block it and the child would wait forever on a frozen
 * server.
 */
async function runDriver(exampleDir, spec) {
  const tsx = join(exampleDir, "node_modules", ".bin", "tsx");
  const runner = existsSync(tsx) ? tsx : process.execPath;
  return new Promise((resolveReport) => {
    // POME_PREFLIGHT would make several examples `process.exit(0)` at import.
    const env = { ...process.env, POME_PROBE_SPEC: JSON.stringify(spec) };
    delete env.POME_PREFLIGHT;
    // `timeout` because a tool table that hangs would otherwise block until the
    // GitHub job timeout with no diagnostic at all — the failure would name the
    // job, not the example. Killing the child produces the `driver-error`
    // finding below, which names both. The whole 20-seed sweep runs in ~15s in
    // CI, so 120s per driver is ~100x headroom.
    const child = spawn(runner, [DRIVER], {
      cwd: exampleDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      killSignal: "SIGKILL",
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (buf) => { out += buf.toString(); });
    child.stderr.on("data", (buf) => { err += buf.toString(); });
    child.on("error", (spawnErr) =>
      resolveReport({ toolNames: null, probes: [], error: `failed to spawn ${runner}: ${spawnErr.message}` }),
    );
    child.on("close", () => {
      const rows = [];
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // An example that logs a banner to stdout is not a failure; the
          // driver's own rows are the only JSON we care about.
        }
      }
      const failure = rows.find((row) => row.kind === "error");
      const tools = rows.find((row) => row.kind === "tools");
      const tail = err.trim().split("\n").slice(-5).join("\n");
      resolveReport({
        toolNames: tools?.names ?? null,
        probes: rows.filter((row) => row.kind === "probe"),
        error:
          failure?.message ??
          (tools ? null : `the driver reported no tool table${tail ? `: ${tail}` : ""}`),
      });
    });
  });
}

export async function runGate(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const examplesDir = opts.examplesDir ?? join(repoRoot, "examples");
  const manifestPath = opts.manifestPath ?? join(repoRoot, "config/example-tool-probes.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const names = Object.keys(manifest).sort();

  // F-1163's other half of totality: discovery inside an example covers a new
  // seed, but a whole new example directory with seeds and no manifest entry
  // (or a manifest entry for a directory that ships none) would still be
  // silently skipped by the `Object.keys(manifest)` loop below. Assert the two
  // sets are the SAME set, named both ways, rather than letting either side
  // win by default.
  const withSeeds = discoverExamplesWithSeeds(examplesDir);
  const missingFromManifest = withSeeds.filter((name) => !names.includes(name));
  const missingSeeds = names.filter((name) => !withSeeds.includes(name));
  if (missingFromManifest.length > 0 || missingSeeds.length > 0) {
    throw new Error(
      `${manifestPath} and ${examplesDir}/*/tasks/*.seed.json disagree on which examples ship seeds — ` +
        `[${missingFromManifest.join(", ")}] ship seeds with no manifest entry; ` +
        `[${missingSeeds.join(", ")}] have a manifest entry but ship no seed`,
    );
  }

  // Seeds per example, discovered — never a hand-kept count. This is the
  // denominator the "20 of 20" claim below has to actually earn: it is
  // computed independently of the probe loop, so a loop that quietly skipped
  // a seed would be caught by the tally at the end, not just assumed correct
  // because it's the same variable.
  const seedsByExample = new Map(names.map((name) => [name, discoverSeeds(join(examplesDir, name))]));
  const totalSeeds = [...seedsByExample.values()].reduce((sum, seeds) => sum + seeds.length, 0);
  if (totalSeeds === 0) {
    throw new Error("discovered zero seeds across every bundled example — refusing to report a pass on nothing");
  }

  console.log(
    `Probing ${totalSeeds} seed(s) across ${names.length} example(s): ${names.join(", ")}`,
  );
  const findings = [];
  let probedSeeds = 0;
  for (const name of names) {
    const seeds = seedsByExample.get(name);
    for (const seed of seeds) {
      process.stdout.write(`\n=== examples/${name} (${seed}) === `);
      const found = await probeExample(name, { ...manifest[name], seed }, { repoRoot, examplesDir });
      console.log(found.length === 0 ? `OK (${manifest[name].probes.length} tools)` : `${found.length} finding(s)`);
      findings.push(...found);
      probedSeeds += 1;
    }
  }

  // A gate that ran fewer probes than the seeds it discovered would exit 0
  // having done less than it claimed — the F-1478 shape, guarded here rather
  // than trusted from the loop above.
  if (probedSeeds !== totalSeeds) {
    throw new Error(`probed ${probedSeeds} seed(s) but discovered ${totalSeeds} — the gate skipped some silently`);
  }

  if (findings.length > 0) {
    console.error(`\n${formatFindings(findings)}`);
    console.error(
      `Examples with twin-tool findings: ${[...new Set(findings.map((finding) => finding.example))].join(", ")}`,
    );
    return 1;
  }
  console.log(
    `\n${probedSeeds} of ${totalSeeds} seed(s) across ${names.length} example(s) were probed; ` +
      "every registered tool was answered by its twin on every seed.",
  );
  return 0;
}

// NOT `import.meta.main`: it landed in Node 24.2, root `engines` allows
// `>=24`, and on 24.0/24.1 it is `undefined` — this guard would be false and
// `npm run probe:examples` would exit 0 having probed nothing. Both sides
// realpath'd, matching contract/run.mjs: node resolves symlinks before
// deriving `import.meta.url`, so a bare argv[1] misses through a symlinked
// checkout in the same silent shape.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && basename(ENTRY) === basename(SELF)) {
  throw new Error(`probe-example-tools.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  process.exit(await withWireRuntime(() => runGate()));
}
