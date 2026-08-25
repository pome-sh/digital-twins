#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Boots each example's twins in-process on its own seeds and invokes every tool it
// registers, so a tool whose endpoint 404s cannot stay green. Seeds are read from
// the directory, not hand-named, or a new one lands unprobed.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DRIVER = join(HERE, "example-tool-probe-driver.mjs");

export const PROBE_SID = "probe";
export const PROBE_SECRET = "pome-f1152-probe-gate-secret-32-chars";

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

export async function withWireRuntime(fn) {
  if (!existsSync(join(REPO_ROOT, "packages/wire/dist/index.js"))) {
    execFileSync("npm", ["run", "build", "-w", "@pome-sh/wire"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
  }
  return await fn();
}

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
  return Object.fromEntries(twinIds.map((id) => [id, stripSeedMeta(stripped?.[id])]));
}

function stripSeedMeta(seed) {
  if (seed && typeof seed === "object" && !Array.isArray(seed)) {
    const { _meta, ...rest } = seed;
    return rest;
  }
  return seed;
}

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

export function deriveSeedFacts(slice) {
  const repo = slice?.repositories?.[0];
  if (!repo) return {};
  const facts = { repo: { owner: repo.owner, name: repo.name } };
  const pr = repo.pull_requests?.[0];
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
  if (file) facts.file = { path: file.path, ref: file.branch ?? repo.default_branch };
  return facts;
}

function mergeWouldConflict(pr) {
  if ((pr.state ?? "open") !== "open") return true;
  const latest = new Map((pr.statuses ?? []).map((status) => [status.context, status.state]));
  return [...latest.values()].some((state) => state === "failure" || state === "error");
}

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

const SEED_INVARIANT = new Set(["unprobed-tool", "unknown-tool"]);

export function formatFindings(findings) {
  const lines = [];
  for (const [example, group] of groupBy(findings, (finding) => finding.example)) {
    lines.push(`FAILED  agent-examples/${example}`);
    const shown = new Set();
    for (const finding of group) {
      if (SEED_INVARIANT.has(finding.kind)) {
        const key = `${finding.kind}\0${finding.tool}`;
        if (shown.has(key)) continue;
        shown.add(key);
      }
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
        if (finding.seed && !SEED_INVARIANT.has(finding.kind)) lines.push(`    seed: ${finding.seed}`);
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

export const TWIN_MODULES = {
  github: { pkg: "@pome-sh/twin-github", definition: "githubTwinDefinition", open: "openGitHubCloneDatabase" },
  slack: { pkg: "@pome-sh/twin-slack", definition: "slackTwinDefinition", open: "openSlackTwinDatabase" },
  gmail: { pkg: "@pome-sh/twin-gmail", definition: "gmailTwinDefinition", open: "openGmailTwinDatabase" },
};

function factsForSeed(exampleDir, seed, twinIds) {
  return deriveSeedFacts(splitSeed(JSON.parse(readFileSync(join(exampleDir, seed), "utf8")), twinIds).github);
}

export function assertManifestEntry(name, entry, exampleDir, seeds, twinIds) {
  const duplicated = entry.probes
    .map((probe) => probe.tool)
    .filter((tool, index, all) => all.indexOf(tool) !== index);
  if (duplicated.length > 0) {
    throw new Error(
      `agent-examples/${name} declares more than one probe for tool(s) [${[...new Set(duplicated)].join(", ")}] — ` +
        "results are keyed by tool name, so only the last would be judged",
    );
  }

  const conditional = entry.probes.filter((probe) => probe.expect_status_if !== undefined);
  if (conditional.length === 0) return;
  const factsBySeed = seeds.map((seed) => [seed, factsForSeed(exampleDir, seed, twinIds)]);
  for (const probe of conditional) {
    const firesOn = factsBySeed.filter(([seed, facts]) => {
      try {
        return resolveFactToken(probe.expect_status_if, facts) === true;
      } catch (err) {
        throw new Error(`agent-examples/${name} (${seed}), tool ${probe.tool}: ${err.message}`);
      }
    });
    if (firesOn.length === 0) {
      throw new Error(
        `agent-examples/${name}, tool ${probe.tool}: declares expect_status ${probe.expect_status} when ` +
          `${probe.expect_status_if}, but no seed this example ships satisfies that condition ` +
          `(checked ${seeds.length}: ${seeds.join(", ")}) — the exemption can never fire, drop it`,
      );
    }
  }
}

export async function probeExample(name, entry, opts) {
  const exampleDir = join(opts.examplesDir, name);
  const manifest = JSON.parse(readFileSync(join(exampleDir, "pome.json"), "utf8"));
  const twinIds = manifest.twins ?? ["github"];
  const slices = splitSeed(JSON.parse(readFileSync(join(exampleDir, entry.seed), "utf8")), twinIds);
  const facts = deriveSeedFacts(slices.github);
  const probes = entry.probes.map((probe) => {
    try {
      const resolved = { ...probe, args: resolveArgs(probe.args, facts) };
      if (probe.expect_status_if !== undefined && resolveFactToken(probe.expect_status_if, facts) !== true) {
        delete resolved.expect_status;
      }
      return resolved;
    } catch (err) {
      throw new Error(`agent-examples/${name} (${entry.seed}), tool ${probe.tool}: ${err.message}`);
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
        `agent-examples/${name} declares twin "${id}", which this gate cannot boot ` +
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

async function runDriver(exampleDir, spec) {
  const tsx = join(exampleDir, "node_modules", ".bin", "tsx");
  const runner = existsSync(tsx) ? tsx : process.execPath;
  return new Promise((resolveReport) => {
    const env = { ...process.env, POME_PROBE_SPEC: JSON.stringify(spec) };
    delete env.POME_PREFLIGHT;
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
  const examplesDir = opts.examplesDir ?? join(repoRoot, "agent-examples");
  const manifestPath = opts.manifestPath ?? join(repoRoot, "config/example-tool-probes.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const names = Object.keys(manifest).sort();

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

  const seedsByExample = new Map(names.map((name) => [name, discoverSeeds(join(examplesDir, name))]));
  const totalSeeds = [...seedsByExample.values()].reduce((sum, seeds) => sum + seeds.length, 0);
  if (totalSeeds === 0) {
    throw new Error("discovered zero seeds across every bundled example — refusing to report a pass on nothing");
  }

  for (const name of names) {
    const exampleDir = join(examplesDir, name);
    const twinIds = JSON.parse(readFileSync(join(exampleDir, "pome.json"), "utf8")).twins ?? ["github"];
    assertManifestEntry(name, manifest[name], exampleDir, seedsByExample.get(name), twinIds);
  }

  console.log(
    `Probing ${totalSeeds} seed(s) across ${names.length} example(s): ${names.join(", ")}`,
  );
  const findings = [];
  let probedSeeds = 0;
  for (const name of names) {
    const seeds = seedsByExample.get(name);
    for (const seed of seeds) {
      process.stdout.write(`\n=== agent-examples/${name} (${seed}) === `);
      const found = await probeExample(name, { ...manifest[name], seed }, { repoRoot, examplesDir });
      console.log(found.length === 0 ? `OK (${manifest[name].probes.length} tools)` : `${found.length} finding(s)`);
      findings.push(...found);
      probedSeeds += 1;
    }
  }

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

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && basename(ENTRY) === basename(SELF)) {
  throw new Error(`probe-example-tools.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  process.exit(await withWireRuntime(() => runGate()));
}
