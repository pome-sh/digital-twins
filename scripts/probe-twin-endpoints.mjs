#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Declared-endpoint probe gate.
//
// `scripts/probe-example-tools.mjs` asks: does every tool a bundled
// EXAMPLE registers get answered by its twin? That gate's subject is the
// example. Its reach over the twins is whatever seven examples happen to
// expose — measured on `51b5efe`, its 43 probes reach 9 of the 137 tools the
// five twins declare, all of them github's, and stripe's 26 not at all.
//
// This gate's subject is the TWIN. It enumerates what each twin declares, over
// the twin's own `tools/list`, and calls every one of them. A twin that gains a
// tool gains a probe with no hand edit to any list; a declared tool that no
// probe supplies arguments for is a named red rather than a silent absence.
//
// Two design points are load-bearing:
//
// 1. THE LIST IS GENERATED, THE ARGUMENTS ARE DECLARED. Nothing can invent
//    `{owner, repo, pull_number}` for `merge_pull_request` out of a JSON
//    Schema — the arguments are a fact about the seeded world, not about the
//    tool. So `config/twin-endpoint-probes.json` declares arguments and this
//    gate declares the SET, from `tools/list`. The rot we
//    produced twice — a hand-kept list that stops covering its subject while
//    the gate reading the list stays green — cannot recur here, because the
//    gate never reads the manifest to learn what exists.
//
// 2. THE STATUS COMES FROM THE TAPE, NOT FROM THE HTTP RESPONSE. MCP JSON-RPC
//    answers HTTP 200 for a tool that failed and reports the failure inside
//    `result.isError` (`packages/sdk/src/mcp-jsonrpc.ts`), so the transport
//    status is 200 on exactly the failure this gate exists to catch — the same
//    shape of blindness as the examples swallowing a 4xx into
//    `{ok: false, status}`, which is what the probe's fetch hook was built to see
//    past. The recorder row the twin writes for its own call carries the real
//    status, the twin's error text, and the METHOD + PATH, which is what lets a
//    red name the route instead of naming the gate.
//
// 3. A STEP MAY BE A SETUP CALL RATHER THAN A PROBE. Some declared
//    tools only answer once something exists, and the write that creates it is
//    not always a tool. twin-github's three release readers are the case: GitHub
//    declares no `create_release` MCP tool, so the twin does not serve one, but
//    it still serves `POST /repos/:owner/:repo/releases`. A manifest entry
//    carrying `setup` instead of `tool` performs that REST call, can be aliased
//    with `as` like any probe, and is deliberately NOT counted as coverage:
//    `probedNames` is built from `tool` alone, so a setup step can never quietly
//    stand in for the probe of a tool nothing calls.
//
// No model, no API key, no network: every twin boots in-process against
// `:memory:` SQLite on its own default seed and is driven through `app.request`.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/**
 * The session id every probe runs under, and the secret its bearer is signed
 * with. A twin's auth middleware rejects a JWT whose `sid` disagrees with the
 * URL, so both halves are pinned here.
 */
export const PROBE_SID = "probe";
export const PROBE_SECRET = "pome-f1305-twin-probe-gate-secret-32";

/**
 * How to boot each twin, and what its bearer has to claim.
 *
 * Spelled out per twin rather than derived, because neither is uniform: the
 * factory is `create<Name>TwinApp` for four twins and `createGitHubCloneApp`
 * for the fifth, the database opener is `open<Name>TwinDatabase` except
 * github's `openGitHubCloneDatabase` and stripe's `openTwinStripeDatabase`,
 * and each twin's session middleware reads a different identity claim
 * (`login`, `account_id`, `gmail_email`, `linear_email`). A guessed name here
 * would fail as an unauthenticated 401 on every probe — a red that names the
 * gate's own bug and buries whatever the twin actually did.
 *
 * Every twin is seeded with ITS OWN exported default world — the world `pome
 * twin start <id>` hands a user — rather than a seed this gate invents, so a
 * probe cannot pass against a world only the gate has. The seed export is named
 * per twin for the same reason as the rest: it is `defaultSeedState` on four
 * twins and `defaultSeed` on stripe. Passing it explicitly is not redundant
 * with the factories that already default it — `createSlackTwinApp` and
 * `createGmailTwinApp` boot an EMPTY world when `seed` is undefined, so an
 * omitted seed would make every slack and gmail probe fail for want of a
 * channel rather than for anything the twin got wrong.
 */
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

// ─── Argument references ─────────────────────────────────────────────────────

/**
 * Resolve `"$alias.a.b"` against the results of earlier probes in the same run.
 *
 * Probes run in declared order and a later one routinely needs an id an earlier
 * one minted (`merge_pull_request` needs the number `create_pull_request`
 * returned). An alias defaults to the tool's own name and `as` overrides it,
 * so a tool probed twice can be referred to unambiguously.
 *
 * An unresolvable reference is thrown, never left undefined: a silently absent
 * `pull_number` makes the twin answer 422 and the gate would report a twin
 * defect that is really a manifest typo.
 */
/**
 * Resolve `$alias.a.b` inside a path SEGMENT, leaving every other segment alone.
 * Segment-wise rather than a free string replace so a literal `$` in a path
 * cannot be mistaken for a reference.
 */
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

// ─── Findings ────────────────────────────────────────────────────────────────

/**
 * The five ways this gate goes red, ordered most-actionable first so a wall of
 * unprobed-endpoint findings never buries a live refusal.
 *
 * `refused` reads the recorded status (see the header): an MCP tool that threw
 * is HTTP 200 on the wire, so a gate watching the response code would be silent
 * on the whole class.
 */
export function evaluateTwinProbeRun({ twin, declared, probes, calls }) {
  const findings = [];
  const at = (kind, tool, detail) => findings.push({ kind, twin, tool, detail });

  const declaredNames = declared.map((tool) => tool.name);
  // `tool` only: a `setup` step is state-building, never coverage.
  const probedNames = new Set(probes.filter((probe) => probe.tool).map((probe) => probe.tool));

  for (const [index, probe] of probes.entries()) {
    // A setup step has no declared-tool identity to check, but it must still
    // WORK — a silent 4xx here would surface as an unexplained refusal on the
    // probe that depends on it.
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

// ─── Driver ──────────────────────────────────────────────────────────────────

/** JSON-RPC `tools/call` against a booted twin, returning the recorded row. */
async function callTool(app, token, tool, args, requestId) {
  const response = await app.request(`/s/${PROBE_SID}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const body = await response.json();
  return { transport: response.status, body };
}

/**
 * Boot one twin, call every declared tool the manifest supplies arguments for,
 * and return findings.
 *
 * The twin runs IN THIS PROCESS against `:memory:` SQLite driven through Hono's
 * `app.request` — no port is bound and no socket is opened, so the gate cannot
 * fail for a reason (a busy port, a slow bind) that has nothing to do with a
 * twin's answer.
 */
export async function probeTwin(id, entry, deps = {}) {
  const boot = TWIN_BOOT[id];
  if (!boot) {
    return [{ kind: "driver-error", twin: id, tool: null, detail: `no boot recipe for twin "${id}" (knows: ${Object.keys(TWIN_BOOT).join(", ")})` }];
  }

  process.env.TWIN_AUTH_SECRET = PROBE_SECRET;
  const importTwin = deps.importTwin ?? ((pkg) => import(pkg));
  const { createRecorderStore } = await import("@pome-sh/sdk/server");
  const { sign } = await import("hono/jwt");

  // Every twin resolves through its `dist/`, so an unbuilt workspace dies here
  // with a raw ERR_MODULE_NOT_FOUND naming a path nobody edited. ci.yml runs
  // `npm run build` before this gate; the catch is for the bare
  // `npm run probe:twins` a developer types. It does NOT rebuild: a twin's
  // build opens with `rm -rf dist`, so a rebuild from inside the gate would
  // briefly delete the artifact every other workspace resolves through.
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
  // Sequential, in declared order: probes mutate twin state and a later probe
  // routinely depends on an id an earlier one minted.
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
      // `$alias.path` resolves in a path SEGMENT as well as in the arguments —
      // twin-github's review-comment setup hangs off a pull request an earlier
      // probe minted, so a literal-only path would have made the step unable to
      // address the thing it is setting up.
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
    // The tape row, not the JSON-RPC envelope: `content[0].text` is whatever a
    // twin's `contentText` chose to render, while `response_body` is the tool's
    // return value. It has been through `redactEvent` — a reference to a key
    // named `token` / `secret` / `api_key` resolves to "[REDACTED]" rather than
    // failing, which is why nothing in the manifest chains through one.
    const alias = probe.as ?? probe.tool;
    if (row.status < 400 && alias) results[alias] = row.response_body;
  }

  return evaluateTwinProbeRun({ twin: id, declared, probes, calls });
}

export async function runGate(opts = {}) {
  const manifestPath = opts.manifestPath ?? join(opts.repoRoot ?? REPO_ROOT, "config/twin-endpoint-probes.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const ids = Object.keys(manifest).sort();

  // A manifest declaring zero twins would otherwise fall straight through the
  // loop below to "0 findings, exit 0" — the exact "probed nothing but exited
  // 0" shape this gate exists to prevent, just moved one file over.
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

  // Reported BEFORE the zero-probe floor below: a manifest whose twins declare
  // no probes produces an `unprobed-endpoint` finding per declared tool, and
  // those name the endpoints. Throwing first would replace that whole list with
  // a bare stack trace — the louder failure would be the less informative one.
  if (findings.length > 0) {
    console.error(`\n${formatFindings(findings)}`);
    console.error(`Twins with declared-endpoint findings: ${[...new Set(findings.map((f) => f.twin))].join(", ")}`);
    return 1;
  }

  // Only reachable on the pass path, which is the point: it is the floor under
  // "exit 0", not a second way to red. A manifest with twins but no probes at
  // all reds through the findings above; this catches the case where nothing
  // red AND nothing was probed.
  const probeCount = ids.reduce((sum, id) => sum + (manifest[id]?.probes?.length ?? 0), 0);
  if (probeCount === 0) {
    throw new Error(
      `${manifestPath} declares ${ids.length} twin(s) but zero probes in total — refusing to report a pass having probed nothing`
    );
  }

  console.log(`\nEvery endpoint all ${ids.length} twins declare was called and answered (${probeCount} probes).`);
  return 0;
}

// Realpath'd on both sides, never bare `import.meta.main`: that property
// landed in Node 24.2, root `engines` allows `>=24`, and on 24.0.0/24.0.1/
// 24.0.2/24.1.0 it is `undefined` — the guard is false, `runGate()` never
// runs, and the script exits 0 having probed nothing. Node resolves
// symlinks before deriving `import.meta.url`, so realpathing only one side
// misses through a symlinked checkout (a worktree, or macOS's symlinked
// `/tmp`) in the same silent shape — the mistake an earlier fix made and the
// entry-guard lint revisits. A guard miss while invoked AS this file throws rather than
// exits 0.
const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("probe-twin-endpoints.mjs")) {
  throw new Error(`probe-twin-endpoints.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  process.exit(await runGate());
}
