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
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SHARED_TYPES_SRC = join(REPO_ROOT, "packages", "shared-types", "src");
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
 * Run `fn` with `@pome-sh/shared-types` loadable by plain `node`, then undo it.
 *
 * That package exports `./src/index.ts` and ships no dist build, so the twin
 * packages' runtime import chain lands on TypeScript whose relative specifiers
 * (`./recorder-events.js`) node's type-stripping does not rewrite — nothing in
 * this repo can `import("@pome-sh/twin-github")` under bare `node` until
 * `build:runtime` emits the `.js` in place. contract/run.mjs hits the same wall
 * and solves it identically.
 *
 * The emitted files are untracked and MUST be removed afterwards: left behind
 * they shadow the `.ts` sources and break `lint:dead-code`. Hence the `finally`.
 */
export async function withSharedTypesRuntime(fn) {
  execFileSync("npm", ["run", "build:runtime", "-w", "@pome-sh/shared-types"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  try {
    return await fn();
  } finally {
    const removed = cleanRuntimeJs(SHARED_TYPES_SRC);
    if (process.env.POME_PROBE_VERBOSE === "1") {
      console.log(`[probe:examples] cleaned ${removed} generated runtime .js file(s)`);
    }
  }
}

// Only remove `X.js` when `X.ts` sits next to it — the exact inverse of
// tsconfig.runtime.json's in-place emit. Nothing else is touched.
function cleanRuntimeJs(dir) {
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += cleanRuntimeJs(full);
    } else if (entry.name.endsWith(".js") && existsSync(`${full.slice(0, -3)}.ts`)) {
      rmSync(full);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Hand each declared twin its slice of a task seed.
 *
 * Single-twin examples ship a FLAT seed (`{_meta, users, repositories, …}`);
 * multi-twin examples ship a per-twin ENVELOPE (`{github: {…}, slack: {…}}`).
 * A seed matching neither shape is a hard error rather than a fallback: reading
 * an envelope as a flat seed compiles the whole envelope into one twin's world
 * and nothing complains, which is the silent overwrite F-987 fixed in the seed
 * compiler.
 */
export function splitSeed(seed, twinIds) {
  const keys = Object.keys(seed ?? {});
  const envelopeKeys = keys.filter((key) => isTwinLike(key));

  if (envelopeKeys.length > 0) {
    const extra = envelopeKeys.filter((key) => !twinIds.includes(key));
    if (extra.length > 0) {
      throw new Error(
        `seed is a per-twin envelope carrying [${envelopeKeys.join(", ")}] but the example ` +
          `declares twins [${twinIds.join(", ")}] — unknown: [${extra.join(", ")}]`,
      );
    }
    const missing = twinIds.filter((id) => !envelopeKeys.includes(id));
    if (missing.length > 0) {
      throw new Error(
        `seed is a per-twin envelope but has no slice for declared twin(s): ${missing.join(", ")}`,
      );
    }
    return Object.fromEntries(twinIds.map((id) => [id, seed[id]]));
  }

  if (twinIds.length !== 1) {
    throw new Error(
      `example declares twins [${twinIds.join(", ")}] but the seed is a flat seed ` +
        `(top-level keys: ${keys.join(", ")}) — a multi-twin example needs a per-twin envelope`,
    );
  }
  return { [twinIds[0]]: seed };
}

// The first-party twin ids. Kept as a literal rather than read from
// config/first-party-twins.json so splitSeed stays a pure function over its
// arguments; check-first-party-twin-registration.mjs already guards that list.
const TWIN_IDS = ["github", "slack", "stripe", "gmail", "linear"];
function isTwinLike(key) {
  return TWIN_IDS.includes(key);
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
 * The five ways this gate goes red. Ordered most-actionable first so a wall of
 * unprobed-tool findings never buries a real refusal.
 *
 * `refused` reads the WIRE status, never the handler's return value: the
 * AI-SDK and LangGraph examples' `gh()` / `twinFetch()` deliberately swallow a
 * 4xx and hand the model `{ok:false,status}` so one bad call cannot abort the
 * run, so `threw` is silent on exactly the failure this gate exists to catch.
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
    const worst = observed.calls.reduce((acc, call) => (call.status > (acc?.status ?? -1) ? call : acc), null);
    const status = worst?.status ?? 0;

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
 * Callers must already be inside `withSharedTypesRuntime`.
 */
export async function probeExample(name, entry, opts) {
  const exampleDir = join(opts.examplesDir, name);
  const manifest = JSON.parse(readFileSync(join(exampleDir, "pome.json"), "utf8"));
  const twinIds = manifest.twins ?? ["github"];
  const slices = splitSeed(JSON.parse(readFileSync(join(exampleDir, entry.seed), "utf8")), twinIds);

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
      probes: entry.probes,
    });
    const tape = twinIds.flatMap((id) => stores[id].events().map((event) => ({ ...event, twin: id })));
    return annotateFromTape(
      evaluateProbeRun({ example: name, seed: entry.seed, probes: entry.probes, report }),
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
    const child = spawn(runner, [DRIVER], { cwd: exampleDir, env, stdio: ["ignore", "pipe", "pipe"] });
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

  console.log(`Probing twin tools for ${names.length} example(s): ${names.join(", ")}`);
  const findings = [];
  for (const name of names) {
    process.stdout.write(`\n=== examples/${name} === `);
    const found = await probeExample(name, manifest[name], { repoRoot, examplesDir });
    console.log(found.length === 0 ? `OK (${manifest[name].probes.length} tools)` : `${found.length} finding(s)`);
    findings.push(...found);
  }

  if (findings.length > 0) {
    console.error(`\n${formatFindings(findings)}`);
    console.error(
      `Examples with twin-tool findings: ${[...new Set(findings.map((finding) => finding.example))].join(", ")}`,
    );
    return 1;
  }
  const probeCount = names.reduce((sum, name) => sum + manifest[name].probes.length, 0);
  console.log(`\nAll ${probeCount} registered tools across ${names.length} example(s) were answered by their twins.`);
  return 0;
}

if (import.meta.main) {
  process.exit(await withSharedTypesRuntime(() => runGate()));
}
