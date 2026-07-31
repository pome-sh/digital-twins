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

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SHARED_TYPES_SRC = join(REPO_ROOT, "packages", "shared-types", "src");

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
