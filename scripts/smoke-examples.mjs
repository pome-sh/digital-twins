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
//
// F-1486: the REACHED-OUTBOUND leg above is the only thing any environment
// ever proves, because CI has no credentials and 0 of 8 examples are ever
// "still running at the settle" here. `SMOKE_EXAMPLES_LIVE=1` switches this
// same gate — same classifier, same discovery, same output-tail printing —
// into the mode a credentialed nightly runs: it stops overlaying SMOKE_ENV's
// dead loopback ports and invalid keys, so whatever real twin wiring and
// model key the caller already put in `process.env` (booting real local
// twins via `pome twin start`, a real `ANTHROPIC_API_KEY`) flows straight
// through to each example. In this mode a hard credential check runs BEFORE
// anything launches — an absent credential must never degrade into a second
// REACHED-OUTBOUND run that reports success, which would prove nothing while
// looking like a nightly that does — and a floor after the run asserts at
// least one example was alive at the settle for real, naming what it
// expected when it was not.
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

// The kickoff instruction. This is NOT a fake credential and NOT dead wiring:
// it is the only thing that gives a launched example anything to do, and four
// of the eight (`gmail-retry-notify`, `merge-agent`, `minimal-viktor`,
// `minimal-viktor-langgraph`) call `requiredEnv("POME_TASK")` and throw at
// startup without it. It therefore applies on BOTH legs, and keeping it out of
// SMOKE_DEAD_WIRING below is load-bearing: F-1486's first cut overlaid nothing
// at all in LIVE mode, so those four died on `Error: POME_TASK is required`
// and the gate classified them FAIL with "returned without evidence it did any
// real work" — i.e. the credentialed nightly would have redded 4 of 8 on its
// very first run, for an unset env var that has nothing to do with the
// property this leg exists to prove, which is exactly the kind of
// non-diagnosable red that trains a reader to ignore the alarm.
const SMOKE_TASK = "Smoke run: triage/summarize the open items in acme/api.";

// F-1486 — settings the credentialed leg supplies only when the caller has NOT.
// Neither is a credential and neither is dead wiring: together they are what
// decides whether a launched example has anything to do and whether it can
// reach a model with the ONE secret this leg asks a human to provision. Both
// gaps were found by running the leg's exact env shape; each one alone reds the
// nightly on its first run, for a reason unrelated to the property it proves.
const SMOKE_LIVE_DEFAULTS = {
  POME_TASK: SMOKE_TASK,
  // `minimal-viktor` defaults to `VIKTOR_MODEL=alibaba/qwen-3-32b`, which its
  // `resolveModel()` can reach ONLY through the AI Gateway: with no
  // AI_GATEWAY_API_KEY it throws `VIKTOR_MODEL=alibaba/qwen-3-32b needs
  // AI_GATEWAY_API_KEY` before any outbound call — a non-benign exit 1, so FAIL,
  // so a red leg. The PR leg papers over this with a fake AI_GATEWAY_API_KEY in
  // SMOKE_DEAD_WIRING; the credentialed leg must not, because a fake gateway key
  // would route all eight examples into a gateway that rejects them and the real
  // ANTHROPIC_API_KEY would never be exercised at all — a "credentialed" leg
  // whose credential is unreachable. Pinning the anthropic/* slug that
  // merge-agent and gmail-retry-notify ALREADY default to keeps the whole leg on
  // one provisioned secret. `VIKTOR_MODEL` is also minimal-viktor-langgraph's
  // documented fallback (LANGGRAPH_MODEL ?? VIKTOR_MODEL ?? claude-sonnet-5) and
  // its resolveModel() takes `anthropic/*` too, so both land on
  // ANTHROPIC_API_KEY rather than one silently needing a second key.
  VIKTOR_MODEL: "anthropic/claude-opus-4-8",
};

// Env that gets every example past its startup guards and into async work so
// the launch-above-class code path is actually exercised. Values are
// intentionally non-functional (no live twin, invalid keys): we want the module
// to LOAD, not to complete a real run. Overlaid on the PR (uncredentialed) leg
// ONLY — see launchEnv().
const SMOKE_DEAD_WIRING = {
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

// The env one example is launched with. Exported and pure so the regression
// suite can assert the LIVE leg still hands every example a task (the defect
// above) without booting anything.
export function launchEnv(baseEnv, live) {
  // LIVE: the caller (the credentialed workflow) has already put real twin
  // wiring and a real model key in the env; overlaying SMOKE_DEAD_WIRING here
  // would put every example straight back on the loopback port this whole leg
  // exists to get off of. SMOKE_LIVE_DEFAULTS fill only what the caller left
  // unset — a caller-supplied value always wins, and a BLANK one counts as
  // unset so `requiredEnv`'s own trim-check never receives "".
  // PR leg: unchanged from before F-1486 — the overlay wins unconditionally,
  // including the fake AI_GATEWAY_API_KEY that makes alibaba/* resolve there.
  const env = live
    ? { ...baseEnv }
    : { ...baseEnv, ...SMOKE_DEAD_WIRING, POME_TASK: SMOKE_TASK };
  if (live) {
    for (const [name, value] of Object.entries(SMOKE_LIVE_DEFAULTS)) {
      if (!env[name]?.trim()) env[name] = value;
    }
  }
  delete env.POME_PREFLIGHT; // ensure the real launch path, not the early return
  return env;
}

// F-1486 — the credentialed leg switch. Read once at module load (same as
// SETTLE_MS/TDZ_SIGNATURE above) so both smokeOne() and main() agree on it
// for the life of one process; the regression suite drives the exported pure
// functions below directly rather than re-triggering this env read.
//
// Strict, and a non-"1" value is an ERROR rather than "not live": a flag typo'd
// to `true`/`yes`/`TRUE`/`1 ` would otherwise make LIVE false and silently run
// the PR leg instead — SMOKE_DEAD_WIRING overlaid, no credential check, no
// floor, REACHED-OUTBOUND x 8, exit 0. A green nightly that proves nothing is
// this ticket's own subject, and it must not be one character away.
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
      `"proves nothing but looks like it does" failure this leg exists to prevent (F-1486).`,
  };
}

export const LIVE = resolveLiveFlag(process.env.SMOKE_EXAMPLES_LIVE).live;

// The credentials a credentialed run cannot proceed without. `ANTHROPIC_API_KEY`
// is required unconditionally rather than accepting `AI_GATEWAY_API_KEY` as an
// alternative: `minimal-viktor-langgraph` constructs its `ChatAnthropic` model
// from `ANTHROPIC_API_KEY` directly and never consults the gateway key (see
// examples/minimal-viktor-langgraph/src/index.ts), so a leg that accepted the
// gateway key alone would still strand that example at "no evidence of real
// work" while reporting the OTHER seven's gateway-routed calls as proof the
// leg is credentialed. `POME_AUTH_TOKEN` is the one twin-side signal every
// wired example reads (see AGENTS.md's smoke:examples row); its presence is
// what distinguishes "real local twins were booted for this run" from
// SMOKE_ENV's dead loopback ports, without hand-enumerating which of the
// three twin REST/MCP URL pairs a given example needs.
export const LIVE_REQUIRED_ENV = ["ANTHROPIC_API_KEY", "POME_AUTH_TOKEN"];

// Named, not silent: a credentialed leg missing a secret must fail loudly
// before anything launches, never fall through into a second uncredentialed
// REACHED-OUTBOUND run that reports success — that would be a nightly
// proving nothing while looking like it proves something, this ticket's own
// subject.
// `!env[name]` alone is not enough. GitHub Actions substitutes an unset secret
// as the EMPTY STRING rather than leaving the var absent (falsy, so caught), but
// a secret whose stored value is blank-but-not-empty — a stray space or newline
// pasted into the secret box, the shape F-1187/F-1184 found blank in Infisical —
// is TRUTHY and would sail through, leaving the leg to launch every example with
// a whitespace API key and report the resulting per-example crashes as "the
// example is broken" instead of "the credential is blank". Trim, so present-but-
// blank is named as absent.
export function missingLiveEnv(env = process.env) {
  return LIVE_REQUIRED_ENV.filter((name) => !env[name]?.trim());
}

// The floor F-1486 asks for: on the credentialed leg, at least one example
// must be alive at the settle — zero-alive is the exact fact no environment
// currently asserts. Deliberately >= 1, not a hardcoded count of examples or
// a fraction of `total`: a literal tied to `total` is the milestone's own
// "two floors that compared quantities which moved together" shape — either
// number drifts in lockstep as examples are added or removed, so the
// cross-check never disagrees with itself. The floor here is independent of
// `total` on purpose.
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

// F-1518 — the counted-numerator property. `classifyLaunch()` already gives
// every launch one of three named, counted outcomes (ok / reached / fail); the
// gap this closes is a DIFFERENT failure mode, one level up: an example that
// never reaches `classifyLaunch()` at all and so never lands in any of the
// three buckets — the printed "N of M" total quietly shrinks to N-1 with
// nothing saying the Mth example went MISSING rather than FAILED. Measured on
// PR #417: the summary read "7 of 8" and named seven, and nothing said the
// eighth (`pr-summary-agent`) had vanished rather than failed. Pure and
// exported so the regression suite can assert it without spawning all eight
// examples: feed it a discovered list and the names main()'s loop actually
// produced a verdict for.
//
// Deliberately compares NAMES, not just lengths — a bug that drops one name
// and double-reports another would net to the same length and hide behind a
// count-only check, defeating the "naming the missing example" requirement.
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
export function classifyLaunch({ output, stillRunningAtSettle, exitCode, signal, live = LIVE }) {
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
  // F-1486 — the third possibility exists ONLY on the credentialed leg, and the
  // reader has to be told about it or the first real nightly red is a mystery.
  // OK is "still alive at the settle", so with real twins and a real key a
  // GENUINELY CORRECT example that answers fast — the twin's default seed does
  // not contain what SMOKE_TASK asks about, the model correctly says "nothing
  // found", the process exits 0 in under 5s — lands HERE, on a FAIL whose text
  // otherwise insists the example is broken. Distinguishing "exited 0 having
  // produced work output" from "exited 0 having done nothing" needs a work
  // marker no example emits in a common form across three frameworks, so it is
  // not a cheap fix; naming the possibility in the message is, and it makes the
  // first red diagnosable instead of training the reader to ignore the alarm.
  const liveFastExit =
    live && exitCode === 0
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
      `${how} before settling (${SETTLE_MS}ms) with no TDZ and no outbound-call failure in its ` +
      `output — it returned without evidence it did any real work. Either the example is broken ` +
      `(the likely case: a wrong parse, an early return, or a swallowed error read as an empty ` +
      `result), or it failed on a genuinely benign outbound error this gate does not recognize ` +
      `yet — if the tail above shows one, add it to BENIGN_FAILURE_SIGNATURES in ` +
      `scripts/smoke-examples.mjs naming the class, and add a case to smoke-examples.test.mjs.` +
      liveFastExit,
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
  // F-1486 — fail closed, before anything launches. A credentialed leg
  // missing a secret must never silently become a second uncredentialed
  // REACHED-OUTBOUND run that reports success; it must red, naming exactly
  // what is absent.
  // A flag set to an unrecognised value must not quietly mean "PR leg".
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
          `This is the credentialed leg (F-1486) — it must not fall back to SMOKE_ENV's dead ` +
          `loopback ports and invalid keys, which would report REACHED-OUTBOUND and pass while ` +
          `proving nothing. Provision the missing secret(s)/twin wiring before retrying.`,
      );
      process.exit(1);
    }
  }

  const examples = discoverExamples();
  // Vacuous green: a runner examining zero examples must fail loudly, not
  // print "All 0 examples launched clean."
  if (examples.length === 0) {
    console.error("No runnable examples (with a `start` script) found.");
    process.exit(1);
  }

  console.log(
    `Launch-smoking ${examples.length} example(s)${LIVE ? " (LIVE — real twin + model credentials)" : ""}: ` +
      examples.join(", "),
  );

  const failures = [];
  const reached = [];
  const oks = [];
  // F-1518 — every name pushed here got an actual verdict below. Compared
  // against `examples` after the loop so a name that never makes it into any
  // bucket (this array, or oks/reached/failures) is named, not silently
  // dropped from the "N of M" total.
  const reportedNames = [];
  for (const name of examples) {
    process.stdout.write(`\n=== examples/${name} === `);
    let result;
    try {
      result = await smokeOne(name);
    } catch (err) {
      // smokeOne() is designed to always resolve — the SETTLE_MS timer, the
      // child 'exit' handler, and the child 'error' handler each
      // independently produce a verdict — but this loop must not itself
      // become the next silent-drop bug. A rejection here is left OUT of
      // reportedNames on purpose: assertReportedCount() below names it as
      // missing rather than this catch inventing a verdict for work that
      // never actually ran.
      console.log(`did not report a verdict (runner threw: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    reportedNames.push(name);
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
      // Show the tail so the crash (or the silent nothing) is visible in CI logs.
      if (tail) console.error(tail);
      failures.push({ name, reason: result.reason });
    }
  }

  const reportedCount = assertReportedCount(examples, reportedNames);

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
    // F-1518 — a missing verdict is reported and reds independently of
    // `failures`: it is a defect in THIS SCRIPT's own bookkeeping, not in the
    // example, and folding it into "Examples that crash on launch" above
    // would misname the fault.
    if (!reportedCount.ok) console.error(`\n${reportedCount.message}`);
    if (!floor.ok) console.error(`\n${floor.message}`);
    process.exit(1);
  }

  if (LIVE) console.log(`\n${floor.message}`);
  console.log(
    `\nAll ${examples.length} examples reached real work: ` +
      `${oks.length} still running at the settle, ` +
      `${reached.length} failed at an outbound call.`,
  );
}
