// SPDX-License-Identifier: Apache-2.0
//
// F-900 example-launch smoke. `tsc` cannot see a temporal-dead-zone crash:
// F-866's typecheck-examples gate was green while every real launch of
// `examples/triage-agent` died at startup with
//   ReferenceError: Cannot access 'TwinMcpClient' before initialization
// because the top-level `await main()` ran before the `class TwinMcpClient`
// below it was evaluated. The POME_PREFLIGHT path (a hoisted-function early
// return) never reached the class, so `pome doctor` / `POME_PREFLIGHT=1` passed
// against a code path that stopped short of the bug.
//
// This gate launches each runnable example for real — POME_PREFLIGHT unset, so
// `main()` runs past the point where a launch-above-class TDZ would fire — and
// fails if the module crashes on load with a TDZ ReferenceError.
//
// F-1478: for as long as this gate existed, an exit *inside* SETTLE_MS was
// unconditionally treated as OK, on the theory that a benign network/auth
// failure (no live twin, no real model key in CI) is expected and must not be
// a false red. That theory is right, but the implementation never checked it —
// ANY exit before the settle read as success, so an example that returns
// having done nothing at all (wrong parse, an early return, a swallowed
// error — `minimal-viktor-langgraph` did all three at once) passed exactly
// like a healthy launch. Measured in CI on pome-sh/digital-twins#382: 8 of 8
// examples reported OK, seven exited 1, one exited 0, and zero were "still
// running" at the settle — the one signal this gate computes that actually
// means "reached real work" was thrown away every time.
//
// The fix asserts the property instead of trusting the exit path:
//   - still alive at the settle → OK. The launch reached async work (a network
//     call, a model call) and is still in it — a TDZ throws synchronously
//     during module evaluation, well under this window, so surviving it is
//     real evidence, not silence.
//   - exits before the settle with the TDZ signature in its output → FAIL,
//     unconditionally. This is F-900's actual subject and must never become a
//     skip or a pass no matter what else changes here.
//   - exits before the settle WITHOUT the TDZ signature → only a network/auth
//     failure this gate's own SMOKE_ENV deliberately manufactures (dead twin
//     endpoints, invalid model keys) excuses this. That is asserted by
//     matching the output against BENIGN_FAILURE_SIGNATURES below — a property
//     of the failure ("connection refused", "invalid api key" …), not a list
//     of which examples are allowed to exit early. A match is a named, counted
//     REACHED-OUTBOUND, printed distinctly from OK. No match is a FAIL: the
//     example returned before it could have done anything, and nothing in its
//     own output says why.
//
// Measured on this PR in real CI (the only environment that gates anything):
// 7 of 8 examples are REACHED-OUTBOUND and ZERO are OK, because with no live
// twin and no valid model key nothing survives 5s. That is why the outbound
// failure is a PASS and not a skip — a "skip" that is the permanent steady
// state means a gate that verifies nothing and reports green, which is exactly
// the defect this ticket exists to remove. It is named for what it proves
// (module evaluated, startup guards cleared, an outbound call opened) and never
// for what it does not (that the work was correct — `probe:examples` and the
// scenario suites are the gates for that).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(repoRoot, "examples");

// How long to let each example run before we conclude it survived module
// evaluation and reached real (async) work. A launch-above-class TDZ throws
// synchronously while the module body evaluates — well under a second — so a
// few seconds is plenty even with tsx's cold-start transpile.
export const SETTLE_MS = 5000;

// The V8 message for accessing a `let`/`const`/`class` binding in its temporal
// dead zone. This is the exact crash F-900 fixed and F-866's tsc gate missed.
// A TDZ crash is a hard failure regardless of exit code or timing.
export const TDZ_SIGNATURE = /(?:Cannot access '[^']+' before initialization|before initialization)/;

// A benign, CI-expected reason an example can legitimately exit before the
// settle: SMOKE_ENV points every twin URL at a dead loopback port and hands
// out invalid model/API keys on purpose, so a healthy example that reaches
// real work is EXPECTED to fail fast on a network refusal or an auth
// rejection. Each entry names the class of failure it recognizes so a match
// carries a reason, not just a verdict — this is a property of the failure
// text, not a per-example allowlist, so it says nothing about which of the
// eight examples produced it.
//
// Every pattern must be ERROR-SHAPED — an errno, an HTTP status, a library's
// own error class — never ordinary prose an example could print on a healthy
// path. `/unauthorized/i` was the sharp edge here: this example's own Slack
// report for seed 04 reads "merge blocked: … not an authorized collaborator",
// so a bare prose match let an example excuse itself with its own output.
const BENIGN_FAILURE_SIGNATURES = [
  ["connection refused", /ECONNREFUSED/],
  ["connection reset", /ECONNRESET/],
  ["DNS resolution failed", /ENOTFOUND|EAI_AGAIN|getaddrinfo/],
  ["host unreachable", /EHOSTUNREACH|ENETUNREACH/],
  // undici's own message for a failed fetch. Error-shaped by construction —
  // no example prints this phrase on a healthy path.
  ["network request failed", /fetch failed/i],
  ["TLS/proxy terminated the connection", /ECONNABORTED|EPROTO|before secure TLS connection/],
  ["request timed out", /ETIMEDOUT|ERR_SOCKET_CONNECTION_TIMEOUT|\bAbortError\b/],
  [
    "AI Gateway rejected the invalid key",
    /Unauthenticated request to AI Gateway|unauthenticated-ai-gateway|wrapGatewayError|AI_LoadAPIKeyError/i,
  ],
  [
    "model provider rejected the invalid key",
    // Status codes are matched only in status-shaped context: a bare /\b401\b/
    // also matches a stack frame's line number (`at f (file.js:401:5)`), which
    // would hand a benign verdict to any crash with a 401-line stack.
    /invalid[ _-]?api[ _-]?key|invalid x-api-key|authentication_error|permission_error|status (?:401|403)\b|HTTP 40[13]\b|\b40[13] (?:Unauthorized|Forbidden)\b/i,
  ],
];

function matchBenignFailure(output) {
  for (const [reason, re] of BENIGN_FAILURE_SIGNATURES) {
    if (re.test(output)) return reason;
  }
  return null;
}

// Env that gets every example past its startup guards and into async work so
// the launch-above-class code path is actually exercised. Values are
// intentionally non-functional (no live twin, invalid keys): we want the module
// to LOAD, not to complete a real run.
const SMOKE_ENV = {
  POME_TASK: "Smoke run: triage/summarize the open items in acme/api.",
  // Nothing is listening here; fetches fail fast, but only AFTER module load.
  POME_TWIN_BASE_URL: "http://127.0.0.1:59321",
  POME_GITHUB_REST_URL: "http://127.0.0.1:59321",
  POME_GITHUB_MCP_URL: "http://127.0.0.1:59321/s/smoke/mcp",
  POME_SLACK_REST_URL: "http://127.0.0.1:59321",
  // support-triage resolves BOTH twins' MCP URLs in resolveTwinWiring() before it
  // touches anything else, and throws naming every missing var. Without this the
  // example this gate was extended to cover (F-1290) died in env resolution and
  // the gate still printed OK — it proved the module evaluates and nothing more,
  // never reaching examineeOptions() or query(), which is where a launch-above-
  // declaration TDZ of the F-900 shape would actually fire.
  POME_SLACK_MCP_URL: "http://127.0.0.1:59321/s/smoke/mcp",
  POME_GMAIL_REST_URL: "http://127.0.0.1:59321",
  // triage-agent / pr-summary-* accept a pre-minted bearer token verbatim, so
  // resolveAuthToken() returns immediately and reaches `new TwinMcpClient(...)`
  // (the TDZ site) instead of throwing on missing auth.
  POME_AUTH_TOKEN: "smoke-token",
  // pr-summary-* call resolveAnthropicKey() before the twin client; a present
  // (if invalid) key lets them reach the TDZ site too.
  ANTHROPIC_API_KEY: "sk-ant-smoke-invalid",
  // merge-agent / minimal-viktor* route every provider through the AI Gateway
  // when this is set, so resolveModel() returns without a per-provider key.
  AI_GATEWAY_API_KEY: "smoke-invalid",
};

export function discoverExamples(dir = examplesDir) {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const pkgPath = join(dir, name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    // Every runnable example starts with `tsx src/index.ts`; only those can
    // carry a launch-above-class TDZ.
    if (pkg.scripts?.start) found.push(name);
  }
  return found;
}

// The verdict for one launch, given what we observed. Pure and exported so the
// regression suite can drive it directly with synthetic evidence instead of
// spawning real processes. `status` is one of "ok" | "reached" | "fail" —
// never anything a caller could mistake for a fourth state.
//
// "reached" is a PASS, and deliberately not called a skip: measured on this PR
// in real CI, 7 of 8 examples land here and ZERO land on "ok", because with no
// live twin and no valid model key nothing can still be running at the settle.
// A skip that is the permanent steady state is a gate that verifies nothing and
// goes green — this milestone's own subject. So it is named for what it
// positively proves (the process evaluated its module, cleared its startup
// guards, and got far enough to open an outbound twin/model call) and printed
// distinctly from "ok", which is the strictly stronger evidence.
export function classifyLaunch({ output, stillRunningAtSettle, exitCode, signal }) {
  if (TDZ_SIGNATURE.test(output)) {
    return { status: "fail", reason: "TDZ crash on launch" };
  }
  if (stillRunningAtSettle) {
    return { status: "ok", reason: `still running after ${SETTLE_MS}ms` };
  }
  const how = signal ? `killed by ${signal}` : `exited code ${exitCode}`;
  // A benign outbound failure only excuses an early exit that FAILED. An
  // example that hits the dead twin, logs it, and exits 0 anyway has done
  // nothing and reported success — F-1478's defect verbatim, just with a
  // recognizable string in the output. `minimal-viktor-langgraph` reds today
  // only because index.ts sets `exitCode = 1` on a graph failure; had it merely
  // warned, matching the signature alone would have handed it a pass.
  const benign = exitCode !== 0 || signal ? matchBenignFailure(output) : null;
  if (benign) {
    return { status: "reached", reason: `${how} at an outbound call — ${benign}` };
  }
  if (exitCode === 0 && matchBenignFailure(output)) {
    return {
      status: "fail",
      reason:
        `exited code 0 before settling (${SETTLE_MS}ms) while its own output reports an outbound ` +
        `failure (${matchBenignFailure(output)}) — it swallowed the error and exited clean, which ` +
        `is the do-nothing-looks-healthy defect this gate exists to catch. Propagate the failure ` +
        `so the process exits non-zero`,
    };
  }
  return {
    status: "fail",
    reason:
      `${how} before settling (${SETTLE_MS}ms) with no TDZ and no outbound-call failure in its ` +
      `output — it returned without evidence it did any real work. Either the example is broken ` +
      `(the likely case: a wrong parse, an early return, or a swallowed error read as an empty ` +
      `result), or it failed on a genuinely benign outbound error this gate does not recognize ` +
      `yet — if the tail above shows one, add it to BENIGN_FAILURE_SIGNATURES in ` +
      `scripts/smoke-examples.mjs naming the class, and add a case to smoke-examples.test.mjs`,
  };
}

function smokeOne(name) {
  return new Promise((resolvePromise) => {
    const cwd = join(examplesDir, name);
    const tsx = join(cwd, "node_modules", ".bin", "tsx");
    if (!existsSync(tsx)) {
      resolvePromise({
        name,
        status: "fail",
        reason: `tsx not installed (run \`npm ci\` in examples/${name})`,
        output: "",
      });
      return;
    }

    const env = { ...process.env, ...SMOKE_ENV };
    delete env.POME_PREFLIGHT; // ensure the real launch path, not the early return

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
      resolvePromise({ name, output, ...verdict });
    };

    const timer = setTimeout(() => {
      finish(classifyLaunch({ output, stillRunningAtSettle: true }));
    }, SETTLE_MS);

    child.on("exit", (code, signal) => {
      finish(classifyLaunch({ output, stillRunningAtSettle: false, exitCode: code, signal }));
    });

    child.on("error", (err) => {
      finish({ status: "fail", reason: `failed to spawn: ${err.message}` });
    });
  });
}

// Guarded so the regression suite can `import { classifyLaunch, discoverExamples }`
// without re-triggering a real launch of all eight examples. Realpath'd on
// both sides (not `import.meta.main`: that landed in Node 24.2, root
// `engines` allows `>=24`, and `undefined` there makes the guard false and
// this file exit 0 having smoked nothing — same shape F-1353 fixed in
// contract/run.mjs), and a guard miss while invoked as this file throws
// rather than exits 0.
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
  const examples = discoverExamples();
  // Vacuous green: a runner examining zero examples must fail loudly, not
  // print "All 0 examples launched clean."
  if (examples.length === 0) {
    console.error("No runnable examples (with a `start` script) found.");
    process.exit(1);
  }

  console.log(`Launch-smoking ${examples.length} example(s): ${examples.join(", ")}`);

  const failures = [];
  const reached = [];
  for (const name of examples) {
    process.stdout.write(`\n=== examples/${name} === `);
    const result = await smokeOne(name);
    const tail = result.output?.trim().split("\n").slice(-12).join("\n") ?? "";
    if (result.status === "ok") {
      console.log(`OK (${result.reason})`);
      if (tail) console.log(tail);
    } else if (result.status === "reached") {
      console.log(`REACHED-OUTBOUND (${result.reason})`);
      if (tail) console.log(tail);
      reached.push({ name, reason: result.reason });
    } else {
      console.log(`FAILED (${result.reason})`);
      // Show the tail so the crash (or the silent nothing) is visible in CI logs.
      if (tail) console.error(tail);
      failures.push({ name, reason: result.reason });
    }
  }

  if (reached.length > 0) {
    console.log(
      `\n${reached.length} of ${examples.length} example(s) got as far as an outbound twin/model ` +
        `call and failed THERE, which is the furthest this environment can take them ` +
        `(SMOKE_ENV has no live twin and no valid model key). Verified: module evaluated, ` +
        `startup guards passed, async work reached. NOT verified: that the work is correct. ` +
        reached.map((r) => `${r.name} (${r.reason})`).join("; "),
    );
  }

  if (failures.length > 0) {
    console.error(
      `\nExamples that crash on launch or return with no evidence of real work: ` +
        failures.map((f) => `${f.name} (${f.reason})`).join("; "),
    );
    process.exit(1);
  }
  console.log(
    `\nAll ${examples.length} examples reached real work: ` +
      `${examples.length - reached.length} still running at the settle, ` +
      `${reached.length} failed at an outbound call.`,
  );
}
