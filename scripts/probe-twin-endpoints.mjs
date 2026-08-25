#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Every declared twin endpoint must answer. A stale `expect_status` exemption is a
// finding, not a pass.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

export const PROBE_SID = "probe";
export const PROBE_SECRET = "pome-f1305-twin-probe-gate-secret-32";

export const TWIN_BOOT = {
  github: {
    pkg: "@pome-sh/twin-github",
    app: "createGitHubCloneApp",
    seed: "defaultSeedState",
    claims: { team_id: "tm_probe", login: "pome-agent" },
  },
  stripe: {
    pkg: "@pome-sh/twin-stripe",
    app: "createTwinStripeApp",
    seed: "defaultSeed",
    claims: { account_id: `acct_${PROBE_SID}` },
  },
  slack: {
    pkg: "@pome-sh/twin-slack",
    app: "createSlackTwinApp",
    seed: "defaultSeedState",
    claims: { team_id: "tm_probe", login: "pome-agent" },
  },
  gmail: {
    pkg: "@pome-sh/twin-gmail",
    app: "createGmailTwinApp",
    seed: "defaultSeedState",
    claims: { team_id: "tm_probe", gmail_email: "pome-agent@pome-twin.test" },
  },
  linear: {
    pkg: "@pome-sh/twin-linear",
    app: "createLinearTwinApp",
    seed: "defaultSeedState",
    claims: { team_id: "tm_probe", linear_email: "pome-agent@pome-twin.test" },
  },
};

export function resolvePath(path, results) {
  return path
    .split("/")
    .map((segment) => (segment.startsWith("$") ? String(resolveArgs(segment, results)) : segment))
    .join("/");
}

export function resolveArgs(args, results) {
  if (Array.isArray(args)) return args.map((item) => resolveArgs(item, results));
  if (args && typeof args === "object") {
    return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, resolveArgs(value, results)]));
  }
  if (typeof args !== "string" || !args.startsWith("$")) return args;

  const [alias, ...path] = args.slice(1).split(".");
  if (!(alias in results)) {
    throw new Error(
      `unresolvable reference ${args}: no earlier probe is aliased "${alias}" ` +
        `(available: ${Object.keys(results).join(", ") || "none"})`,
    );
  }
  let cursor = results[alias];
  for (const segment of path) {
    if (cursor === null || cursor === undefined) {
      throw new Error(`unresolvable reference ${args}: "${alias}" result has no path ${path.join(".")}`);
    }
    cursor = cursor[segment];
  }
  if (cursor === undefined) {
    throw new Error(`unresolvable reference ${args}: "${alias}" result has no path ${path.join(".")}`);
  }
  return cursor;
}

export function evaluateTwinProbeRun({ twin, declared, probes, calls }) {
  const findings = [];
  const at = (kind, tool, detail) => findings.push({ kind, twin, tool, detail });

  const declaredNames = declared.map((tool) => tool.name);
  const probedNames = new Set(probes.filter((probe) => probe.tool).map((probe) => probe.tool));

  for (const [index, probe] of probes.entries()) {
    if (probe.setup) {
      const call = calls[index];
      const label = `setup ${probe.setup.method} ${probe.setup.path}`;
      if (!call) at("driver-error", label, "the driver reported no result for this setup step");
      else if (call.failed) at("driver-error", label, call.failed);
      else if (call.status >= 400) at("refused", label, JSON.stringify(call));
      continue;
    }
    if (!declaredNames.includes(probe.tool)) {
      at("unknown-endpoint", probe.tool, `probed but the twin declares no such tool`);
      continue;
    }
    const call = calls[index];
    if (!call) {
      at("driver-error", probe.tool, "the driver reported no result for this probe");
      continue;
    }
    if (call.failed) {
      at("driver-error", probe.tool, call.failed);
      continue;
    }
    if (probe.expect_status !== undefined) {
      if (call.status === probe.expect_status) continue;
      at(
        "stale-expect",
        probe.tool,
        `declares expect_status ${probe.expect_status} (${probe.why}) but the twin answered ${call.status} — ` +
          "drop the exemption",
      );
      continue;
    }
    if (call.status >= 400) {
      at("refused", probe.tool, JSON.stringify(call));
    }
  }

  for (const name of declaredNames) {
    if (!probedNames.has(name)) {
      at("unprobed-endpoint", name, "declared by the twin but no probe supplies arguments for it");
    }
  }

  return findings;
}

const HEADLINE = {
  refused: "the twin refused its own declared tool",
  "unprobed-endpoint": "the twin declares this tool and nothing calls it",
  "unknown-endpoint": "a probe names a tool the twin does not declare",
  "stale-expect": "expect_status exemption no longer applies",
  "driver-error": "the probe could not be run",
};

export function formatFindings(findings) {
  const lines = [];
  for (const [twin, group] of groupBy(findings, (finding) => finding.twin)) {
    lines.push(`FAILED  twin ${twin}`);
    for (const finding of group) {
      lines.push(`  ${finding.tool} — ${HEADLINE[finding.kind]}`);
      if (finding.kind === "refused") {
        const call = JSON.parse(finding.detail);
        lines.push(`    ${twin} twin answered ${call.status}   ${call.method} ${call.path}`);
        if (call.error) lines.push(`    "${call.error}"`);
        lines.push(`    args: ${JSON.stringify(call.args)}`);
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

async function callTool(app, token, tool, args, requestId) {
  const response = await app.request(`/s/${PROBE_SID}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const body = await response.json();
  return { transport: response.status, body };
}

export async function probeTwin(id, entry, deps = {}) {
  const boot = TWIN_BOOT[id];
  if (!boot) {
    return [{ kind: "driver-error", twin: id, tool: null, detail: `no boot recipe for twin "${id}" (knows: ${Object.keys(TWIN_BOOT).join(", ")})` }];
  }

  process.env.TWIN_AUTH_SECRET = PROBE_SECRET;
  const importTwin = deps.importTwin ?? ((pkg) => import(pkg));
  const { createRecorderStore } = await import("@pome-sh/sdk/server");
  const { sign } = await import("hono/jwt");

  let mod;
  try {
    mod = await importTwin(boot.pkg);
  } catch (err) {
    return [{
      kind: "driver-error",
      twin: id,
      tool: null,
      detail: `could not import ${boot.pkg} — run \`npm run build\` first (${err.message})`,
    }];
  }
  const factory = mod[boot.app];
  if (typeof factory !== "function") {
    return [{ kind: "driver-error", twin: id, tool: null, detail: `${boot.pkg} exports no function named "${boot.app}"` }];
  }

  const defaultSeed = mod[boot.seed];
  if (typeof defaultSeed !== "function") {
    return [{ kind: "driver-error", twin: id, tool: null, detail: `${boot.pkg} exports no function named "${boot.seed}"` }];
  }

  const store = createRecorderStore();
  const app = factory({ recorder: store, runId: "probe", seed: defaultSeed() });
  const token = await sign(
    { sid: PROBE_SID, ...boot.claims, exp: Math.floor(Date.now() / 1000) + 3600 },
    PROBE_SECRET,
  );

  const listed = await app.request(`/s/${PROBE_SID}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
  });
  const listing = await listed.json();
  const declared = listing?.result?.tools;
  if (!Array.isArray(declared)) {
    return [{
      kind: "driver-error",
      twin: id,
      tool: null,
      detail: `tools/list answered ${listed.status} with no tool array: ${JSON.stringify(listing).slice(0, 300)}`,
    }];
  }

  const probes = entry?.probes ?? [];
  const results = {};
  const calls = [];
  for (const [index, probe] of probes.entries()) {
    if (!probe.setup && !declared.some((tool) => tool.name === probe.tool)) {
      calls.push(null);
      continue;
    }
    let args;
    try {
      args = resolveArgs(probe.args ?? probe.setup?.body ?? {}, results);
    } catch (err) {
      calls.push({ failed: err.message });
      continue;
    }
    const before = store.count?.() ?? store.events().length;
    if (probe.setup) {
      await app.request(`/s/${PROBE_SID}${resolvePath(probe.setup.path, results)}`, {
        method: probe.setup.method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        ...(probe.setup.method === "GET" ? {} : { body: JSON.stringify(args) }),
      });
    } else {
      await callTool(app, token, probe.tool, args, index + 1);
    }
    const row = store.events()[before];
    if (!row) {
      calls.push({ failed: "the twin recorded no event for this call" });
      continue;
    }
    calls.push({ status: row.status, method: row.method, path: row.path, error: row.error ?? null, args });
    const alias = probe.as ?? probe.tool;
    if (row.status < 400 && alias) results[alias] = row.response_body;
  }

  return evaluateTwinProbeRun({ twin: id, declared, probes, calls });
}

export async function runGate(opts = {}) {
  const manifestPath = opts.manifestPath ?? join(opts.repoRoot ?? REPO_ROOT, "config/twin-endpoint-probes.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const ids = Object.keys(manifest).sort();

  if (ids.length === 0) {
    throw new Error(`${manifestPath} declares zero twins — refusing to report a pass having probed nothing`);
  }

  console.log(`Probing declared endpoints for ${ids.length} twin(s): ${ids.join(", ")}`);
  const findings = [];
  for (const id of ids) {
    process.stdout.write(`\n=== twin ${id} === `);
    const found = await probeTwin(id, manifest[id], opts);
    console.log(found.length === 0 ? `OK (${manifest[id]?.probes?.length ?? 0} probes)` : `${found.length} finding(s)`);
    findings.push(...found);
  }

  if (findings.length > 0) {
    console.error(`\n${formatFindings(findings)}`);
    console.error(`Twins with declared-endpoint findings: ${[...new Set(findings.map((f) => f.twin))].join(", ")}`);
    return 1;
  }

  const probeCount = ids.reduce((sum, id) => sum + (manifest[id]?.probes?.length ?? 0), 0);
  if (probeCount === 0) {
    throw new Error(
      `${manifestPath} declares ${ids.length} twin(s) but zero probes in total — refusing to report a pass having probed nothing`
    );
  }

  console.log(`\nEvery endpoint all ${ids.length} twins declare was called and answered (${probeCount} probes).`);
  return 0;
}

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("probe-twin-endpoints.mjs")) {
  throw new Error(`probe-twin-endpoints.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  process.exit(await runGate());
}
