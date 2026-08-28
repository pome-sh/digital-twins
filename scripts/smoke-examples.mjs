// SPDX-License-Identifier: Apache-2.0
//
// Launches each example for real, because `tsc` cannot see a temporal-dead-zone
// crash. Classification: alive at the settle is OK, the TDZ signature is always
// FAIL, and an early exit passes only if the example printed OUTBOUND_MARKER.
// The marker exists because the SDK picks between two error shapes on a race, so
// the same 401 reads two ways — error text cannot be classified deterministically.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EXAMPLE_ROOTS, listExamples } from "./lib/example-roots.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Kept for `discoverExamples()`'s default and the marker check, both of which are
// exported and unit-tested against a FIXTURE directory — they stay per-root on
// purpose. `main()` walks every root via `listExamples`.
const examplesDir = join(repoRoot, EXAMPLE_ROOTS[0]);

export const SETTLE_MS = 5000;

export const TDZ_SIGNATURE = /(?:Cannot access '[^']+' before initialization|before initialization)/;

export const OUTBOUND_MARKER = "POME_SMOKE_REACHED_OUTBOUND";
export const MARK_OUTBOUND_ENV = "POME_SMOKE_MARK_OUTBOUND";

const BENIGN_FAILURE_SIGNATURES = [
  ["connection refused", /ECONNREFUSED/],
  ["connection reset", /ECONNRESET/],
  ["DNS resolution failed", /ENOTFOUND|EAI_AGAIN|getaddrinfo/],
  ["host unreachable", /EHOSTUNREACH|ENETUNREACH/],
  ["network request failed", /fetch failed/i],
  ["TLS/proxy terminated the connection", /ECONNABORTED|EPROTO|before secure TLS connection/],
  ["request timed out", /ETIMEDOUT|ERR_SOCKET_CONNECTION_TIMEOUT|\bAbortError\b/],
  [
    "AI Gateway rejected the invalid key",
    /Unauthenticated request to AI Gateway|unauthenticated-ai-gateway|wrapGatewayError|AI_LoadAPIKeyError/i,
  ],
  [
    "model provider rejected the invalid key",
    /invalid[ _-]?api[ _-]?key|invalid x-api-key|authentication_error|permission_error|status (?:401|403)\b|HTTP 40[13]\b|\b40[13] (?:Unauthorized|Forbidden)\b/i,
  ],
];

const PRE_OUTBOUND_VETOES = [
  ["the URL never parsed, so no request was made", /ERR_INVALID_URL/],
  [
    "the `claude` CLI could not be resolved, so no model call was made",
    /native binary not found|ensure Claude Code is installed/,
  ],
  ["a module failed to resolve, so nothing outbound ran", /ERR_MODULE_NOT_FOUND/],
];

function matchPreOutboundVeto(output) {
  for (const [reason, re] of PRE_OUTBOUND_VETOES) {
    if (re.test(output)) return reason;
  }
  return null;
}

function matchBenignFailure(output) {
  for (const [reason, re] of BENIGN_FAILURE_SIGNATURES) {
    if (re.test(output)) return reason;
  }
  return null;
}

const SMOKE_TASK = "Smoke run: triage/summarize the open items in acme/api.";

const SMOKE_LIVE_DEFAULTS = {
  POME_TASK: SMOKE_TASK,
  VIKTOR_MODEL: "anthropic/claude-opus-4-8",
};

const SMOKE_DEAD_WIRING = {
  POME_TWIN_BASE_URL: "http://127.0.0.1:59321",
  // The HOSTED control plane, dead-wired for the same reason every twin base
  // above is. Until `integration-examples/braintrust` there was no example that called
  // api.pome.sh, so an unset base was harmless; now an example that reads
  // `POME_API_URL` would default to production and mint BILLABLE sandboxes —
  // once per dataset row, on every PR, and again on every developer's
  // `npm run smoke:examples`. The PR leg is uncredentialed by design and must
  // stay unable to reach a paid API even when the developer running it is
  // logged in.
  POME_API_URL: "http://127.0.0.1:59321",
  // The same argument, one vendor over. `langsmith-eval` calls
  // `api.smith.langchain.com`, and LangSmith's own free tier is metered on TRACES
  // — 5k a month on Developer, with a hard stop at 5,000 when no payment method
  // is on file — so a PR leg that reached it would spend a reader's quota rather
  // than money. It cannot today, because that example validates its seeds
  // against `POME_API_URL` above and dies there first; this line is what keeps
  // that true when somebody reorders the calls. `LANGSMITH_ENDPOINT` is the name
  // the SDK reads first (`LANGSMITH_* || LANGCHAIN_*`), so it wins over a
  // developer's own `LANGCHAIN_ENDPOINT`.
  LANGSMITH_ENDPOINT: "http://127.0.0.1:59321",
  POME_GITHUB_REST_URL: "http://127.0.0.1:59321",
  POME_GITHUB_MCP_URL: "http://127.0.0.1:59321/s/smoke/mcp",
  POME_SLACK_REST_URL: "http://127.0.0.1:59321",
  POME_SLACK_MCP_URL: "http://127.0.0.1:59321/s/smoke/mcp",
  POME_GMAIL_REST_URL: "http://127.0.0.1:59321",
  POME_AUTH_TOKEN: "smoke-token",
  ANTHROPIC_API_KEY: "sk-ant-smoke-invalid",
  AI_GATEWAY_API_KEY: "smoke-invalid",
};

export function launchEnv(baseEnv, live) {
  const env = live
    ? { ...baseEnv }
    : { ...baseEnv, ...SMOKE_DEAD_WIRING, POME_TASK: SMOKE_TASK };
  if (live) {
    for (const [name, value] of Object.entries(SMOKE_LIVE_DEFAULTS)) {
      if (!env[name]?.trim()) env[name] = value;
    }
  }
  delete env.POME_PREFLIGHT; // ensure the real launch path, not the early return
  env[MARK_OUTBOUND_ENV] = "1";
  return env;
}

export function resolveLiveFlag(value) {
  if (value === undefined || value === "") return { live: false, error: null };
  if (value === "1") return { live: true, error: null };
  return {
    live: false,
    error:
      `SMOKE_EXAMPLES_LIVE is set to ${JSON.stringify(value)}, which is not the recognised ` +
      `value "1" (unset or "" means the uncredentialed PR leg). Refusing to run: treating an ` +
      `unrecognised value as "not live" would silently run the PR leg — dead loopback ports, no ` +
      `credential check, no alive-at-settle floor — and report success, which is the exact ` +
      `"proves nothing but looks like it does" failure this leg exists to prevent.`,
  };
}

export const LIVE = resolveLiveFlag(process.env.SMOKE_EXAMPLES_LIVE).live;

export const LIVE_REQUIRED_ENV = ["ANTHROPIC_API_KEY", "POME_AUTH_TOKEN"];

export function missingLiveEnv(env = process.env) {
  return LIVE_REQUIRED_ENV.filter((name) => !env[name]?.trim());
}

export function assertAliveFloor({ live, okCount, total }) {
  if (!live) return { ok: true, message: null };
  if (okCount < 1) {
    return {
      ok: false,
      message:
        `credentialed smoke leg: 0 of ${total} example(s) were alive at the settle (expected ` +
        `>= 1 — this is the exact assertion no uncredentialed environment can make). Every ` +
        `example either crashed or exited before reaching real async work despite real twin ` +
        `and model credentials; check the per-example verdicts above for why.`,
    };
  }
  return {
    ok: true,
    message: `${okCount} of ${total} example(s) alive at the settle (floor: >= 1, met).`,
  };
}

export function assertReportedCount(discoveredNames, reportedNames) {
  const reported = new Set(reportedNames);
  const missing = discoveredNames.filter((name) => !reported.has(name));
  if (missing.length === 0) return { ok: true, message: null };
  return {
    ok: false,
    message:
      `${missing.length} of ${discoveredNames.length} discovered example(s) never reported a verdict at ` +
      `all — neither OK, REACHED-OUTBOUND, nor FAILED: ${missing.join(", ")}. The count of examples ` +
      `reporting must equal the count discovered; a launcher bug that drops one silently (an early ` +
      `return/continue/break in main()'s loop, or smokeOne() rejecting instead of resolving) must red ` +
      `naming exactly which example vanished, never shrink the "N of M" total without saying so.`,
  };
}

export function discoverExamples(dir = examplesDir) {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const pkgPath = join(dir, name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.scripts?.start) found.push(name);
  }
  return found;
}

export function assertEveryExampleEmitsMarker(dir, examples) {
  const missing = [];
  for (const name of examples) {
    const pkgPath = join(dir, name, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (adapterResolvesToWorkspace(deps) || sourceContainsMarker(join(dir, name, "src"))) continue;
    missing.push(name);
  }
  if (missing.length === 0) return { ok: true, message: null };
  return {
    ok: false,
    message:
      `${missing.length} example(s) have no route to emitting ${OUTBOUND_MARKER}: ${missing.join(", ")}. ` +
      `Either depend on @pome-sh/adapter-claude-sdk (its query() emits the marker for you) or print the ` +
      `literal "${OUTBOUND_MARKER}" yourself, gated on process.env.${MARK_OUTBOUND_ENV} === "1", ` +
      `immediately before this example's first outbound (twin or model) call.`,
  };
}

function adapterResolvesToWorkspace(deps) {
  const pin = deps["@pome-sh/adapter-claude-sdk"];
  return typeof pin === "string" && /^(?:file:|link:|\.\.?\/)/.test(pin);
}

const MARKER_EMISSION = new RegExp(`console\\.error\\(\\s*["'\`]${OUTBOUND_MARKER}["'\`]`);

function sourceContainsMarker(srcDir) {
  if (!existsSync(srcDir)) return false;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (MARKER_EMISSION.test(readFileSync(join(srcDir, entry.name), "utf8"))) return true;
  }
  return false;
}

export function classifyLaunch({ output, stillRunningAtSettle, exitCode, signal, live = LIVE }) {
  if (TDZ_SIGNATURE.test(output)) {
    return { status: "fail", reason: "TDZ crash on launch" };
  }
  if (stillRunningAtSettle) {
    return { status: "ok", reason: `still running after ${SETTLE_MS}ms` };
  }
  const how = signal ? `killed by ${signal}` : `exited code ${exitCode}`;
  const vetoed = matchPreOutboundVeto(output);
  const reachedOutbound = output.includes(OUTBOUND_MARKER) && !vetoed;
  const benignReason = matchBenignFailure(output);

  if (exitCode !== 0 || signal) {
    if (reachedOutbound) {
      return {
        status: "reached",
        reason: benignReason
          ? `${how} after emitting ${OUTBOUND_MARKER} — an outbound call failed (${benignReason})`
          : `${how} after emitting ${OUTBOUND_MARKER} — an outbound call failed`,
      };
    }
    if (vetoed) {
      return {
        status: "fail",
        reason:
          `${how} after emitting ${OUTBOUND_MARKER}, but ${vetoed} — the marker proves the process ` +
          `reached its outbound call SITE, not that a call left it, and this crash's own error code ` +
          `says none did. Fix the wiring/config it names; a pre-outbound crash must not read as ` +
          `REACHED-OUTBOUND.`,
      };
    }
    return {
      status: "fail",
      reason:
        `${how} with no TDZ and no ${OUTBOUND_MARKER} in its output — it crashed before reaching an ` +
        `outbound twin/model call, so there is no positive evidence it did any real work (the likely ` +
        `case: broken env/auth resolution, a wrong parse, or a crash during wiring). An error string ` +
        `that merely LOOKS like a benign network/auth failure does not count — see this file's ` +
        `header for why.`,
    };
  }

  if (reachedOutbound && !live) {
    return {
      status: "fail",
      reason:
        `exited code 0 after emitting ${OUTBOUND_MARKER} while running against SMOKE_ENV's dead wiring ` +
        `(invalid keys, unreachable twin) — success here is impossible, so exit 0 means the failure ` +
        `was swallowed instead of propagated. Propagate it so the process exits non-zero.`,
    };
  }
  const liveFastExit = live
    ? ` NOTE (credentialed leg): a third possibility applies here and NOWHERE ELSE — with real ` +
      `twins and a real model key, an example that is CORRECT but FAST can exit 0 inside the ` +
      `${SETTLE_MS}ms settle (e.g. the twin's seed genuinely contains nothing matching the task, ` +
      `so the model answers "nothing found" and returns), and OK is defined as "still alive at ` +
      `the settle", so a correct fast run is indistinguishable from a do-nothing one by timing ` +
      `alone. Read the tail above BEFORE assuming breakage: if it shows a real answer, the fix ` +
      `is a seed that matches the task or a work-output signal, not this example.`
    : "";
  return {
    status: "fail",
    reason:
      (reachedOutbound
        ? `exited code 0 after emitting ${OUTBOUND_MARKER} but before settling (${SETTLE_MS}ms)`
        : `exited code 0 before settling (${SETTLE_MS}ms) with no ${OUTBOUND_MARKER} in its output`) +
      ` — it returned without evidence it did any real work. Either the example is broken (the ` +
      `likely case: a wrong parse, an early return, or a swallowed error read as an empty result), ` +
      `or it needs its ${OUTBOUND_MARKER} emission point moved earlier.` +
      liveFastExit,
  };
}

function smokeOne(example) {
  const { rel, dir: cwd } = example;
  return new Promise((resolvePromise) => {
    const tsx = join(cwd, "node_modules", ".bin", "tsx");
    if (!existsSync(tsx)) {
      resolvePromise({
        name: rel,
        status: "fail",
        reason: `tsx not installed (run \`npm ci\` in ${rel})`,
        output: "",
      });
      return;
    }

    const env = launchEnv(process.env, LIVE);

    const child = spawn(tsx, ["src/index.ts"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const capture = (buf) => {
      output += buf.toString();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise({ name: rel, output, ...verdict });
    };

    let exited = null;
    const timer = setTimeout(() => {
      finish(
        exited
          ? classifyLaunch({ output, stillRunningAtSettle: false, ...exited })
          : classifyLaunch({ output, stillRunningAtSettle: true }),
      );
    }, SETTLE_MS);

    child.on("exit", (code, signal) => {
      exited = { exitCode: code, signal };
    });

    child.on("close", (code, signal) => {
      finish(classifyLaunch({ output, stillRunningAtSettle: false, exitCode: code, signal }));
    });

    child.on("error", (err) => {
      finish({ status: "fail", reason: `failed to spawn: ${err.message}` });
    });
  });
}

const SELF = realpathSync(fileURLToPath(import.meta.url));
const ENTRY = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
const invokedDirectly = ENTRY === SELF;

if (!invokedDirectly && ENTRY.endsWith("smoke-examples.mjs")) {
  throw new Error(`smoke-examples.mjs entry guard did not fire for ${ENTRY} (expected ${SELF})`);
}

if (invokedDirectly) {
  await main();
}

async function main() {
  const flag = resolveLiveFlag(process.env.SMOKE_EXAMPLES_LIVE);
  if (flag.error) {
    console.error(flag.error);
    process.exit(1);
  }

  if (LIVE) {
    const missing = missingLiveEnv();
    if (missing.length > 0) {
      console.error(
        `SMOKE_EXAMPLES_LIVE=1 but missing required credential(s): ${missing.join(", ")}. ` +
          `This is the credentialed leg — it must not fall back to SMOKE_ENV's dead ` +
          `loopback ports and invalid keys, which would report REACHED-OUTBOUND and pass while ` +
          `proving nothing. Provision the missing secret(s)/twin wiring before retrying.`,
      );
      process.exit(1);
    }
  }

  // Every root, not just the first. An example that lands in a root nothing
  // walks is not a failure here — it is silently unsmoked, which is the shape
  // this file exists to make impossible.
  const examples = listExamples(repoRoot).filter((example) => {
    const pkg = JSON.parse(readFileSync(join(example.dir, "package.json"), "utf8"));
    return Boolean(pkg.scripts?.start);
  });
  if (examples.length === 0) {
    console.error("No runnable examples (with a `start` script) found.");
    process.exit(1);
  }

  for (const root of EXAMPLE_ROOTS) {
    const inRoot = examples.filter((e) => e.root === root).map((e) => e.name);
    if (inRoot.length === 0) continue;
    const markerCoverage = assertEveryExampleEmitsMarker(join(repoRoot, root), inRoot);
    if (!markerCoverage.ok) {
      console.error(markerCoverage.message);
      process.exit(1);
    }
  }

  console.log(
    `Launch-smoking ${examples.length} example(s)${LIVE ? " (LIVE — real twin + model credentials)" : ""}: ` +
      examples.map((e) => e.rel).join(", "),
  );

  const failures = [];
  const reached = [];
  const oks = [];
  for (const example of examples) {
    const name = example.rel;
    process.stdout.write(`\n=== ${name} === `);
    let result;
    try {
      result = await smokeOne(example);
    } catch (err) {
      console.log(`did not report a verdict (runner threw: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const tail = result.output?.trim().split("\n").slice(-12).join("\n") ?? "";
    if (result.status === "ok") {
      console.log(`OK (${result.reason})`);
      if (tail) console.log(tail);
      oks.push({ name, reason: result.reason });
    } else if (result.status === "reached") {
      console.log(`REACHED-OUTBOUND (${result.reason})`);
      if (tail) console.log(tail);
      reached.push({ name, reason: result.reason });
    } else {
      console.log(`FAILED (${result.reason})`);
      if (tail) console.error(tail);
      failures.push({ name, reason: result.reason });
    }
  }

  const reportedCount = assertReportedCount(
    examples.map((e) => e.rel),
    [...oks, ...reached, ...failures].map((r) => r.name),
  );

  if (reached.length > 0) {
    console.log(
      `\n${reached.length} of ${examples.length} example(s) got as far as an outbound twin/model ` +
        `call and failed THERE, which is the furthest this environment can take them` +
        `${LIVE ? "" : " (SMOKE_ENV has no live twin and no valid model key)"}. Verified: module evaluated, ` +
        `startup guards passed, async work reached. NOT verified: that the work is correct. ` +
        reached.map((r) => `${r.name} (${r.reason})`).join("; "),
    );
  }

  const floor = assertAliveFloor({ live: LIVE, okCount: oks.length, total: examples.length });

  if (failures.length > 0 || !reportedCount.ok || !floor.ok) {
    if (failures.length > 0) {
      console.error(
        `\nExamples that crash on launch or return with no evidence of real work: ` +
          failures.map((f) => `${f.name} (${f.reason})`).join("; "),
      );
    }
    if (!reportedCount.ok) console.error(`\n${reportedCount.message}`);
    if (!floor.ok) console.error(`\n${floor.message}`);
    process.exit(1);
  }

  if (LIVE) console.log(`\n${floor.message}`);
  console.log(
    `\nAll ${examples.length} examples reached real work: ` +
      `${oks.length} still running at the settle, ` +
      `${reached.length} failed at an outbound call. ` +
      `(The OK/REACHED split is environment-shaped: SETTLE_MS=${SETTLE_MS}ms races the \`claude\` CLI's ` +
      `cold-start time, so a faster or slower machine shifts examples between the two buckets. Neither ` +
      `bucket's pass/fail verdict depends on that race — OUTBOUND_MARKER is emitted within milliseconds ` +
      `of process start, long before the settle — only which of the two passing buckets an example lands ` +
      `in.)`,
  );
}
