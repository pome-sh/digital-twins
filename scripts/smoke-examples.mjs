// SPDX-License-Identifier: Apache-2.0
//
// Example-launch smoke. `tsc` cannot see a temporal-dead-zone crash: the
// examples typecheck gate was green while every real launch of
// `agent-examples/triage-agent` died at startup with
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
// For as long as this gate existed, an exit *inside* SETTLE_MS was
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
//     unconditionally. This is the crash this gate exists to catch, and must
//     never become a skip or a pass no matter what else changes here.
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
// The REACHED-OUTBOUND leg above is the only thing any environment
// ever proves, because CI has no credentials and 0 of 8 examples are ever
// "still running at the settle" here. `SMOKE_EXAMPLES_LIVE=1` switches this
// same gate — same classifier, same discovery, same output-tail printing —
// into the mode a credentialed caller runs: it stops overlaying SMOKE_ENV's
// dead loopback ports and invalid keys, so whatever real twin wiring and
// model key the caller already put in `process.env` (booting real local
// twins via `pome twin start`, a real `ANTHROPIC_API_KEY`) flows straight
// through to each example. In this mode a hard credential check runs BEFORE
// anything launches — an absent credential must never degrade into a second
// REACHED-OUTBOUND run that reports success, which would prove nothing while
// looking like a run that does — and a floor after the run asserts at
// least one example was alive at the settle for real, naming what it
// expected when it was not.
//
// REACHED-OUTBOUND above was decided by matching the FAILURE TEXT
// against BENIGN_FAILURE_SIGNATURES — an archaeology problem, not a proof.
// `@anthropic-ai/claude-agent-sdk@0.3.221`'s query() picks between two error
// shapes on a field (`lastErrorResultText`) set by a race between its own
// stream-parsing and the child process's 'exit' event: win the race and the
// thrown error reads "Claude Code returned an error result: … 401 invalid
// x-api-key" (matches the signature list → REACHED-OUTBOUND); lose it and the
// SAME underlying failure reads "Claude Code process exited with code 1.
// stderr: <tail>" (matches nothing → FAIL). Same tree, either verdict —
// measured on run 31711971267: attempt 1 was "7 of 8" reached + exit 1,
// the re-run was "8 of 8". No regex over the error text can be made
// deterministic against a race that lives inside a dependency's internals,
// and widening the signatures to catch "process exited with code" would
// convert every pre-wiring crash into a pass — the exact defect this gate
// already fixed once, reintroduced through the back door.
//
// The fix: classify on POSITIVE EVIDENCE THE EXAMPLE ITSELF EMITS, not on
// which shape of error text survived the race. `OUTBOUND_MARKER` below is a
// fixed literal every example prints, synchronously, at the earliest point it
// is about to make its first outbound (twin or model) call — before either of
// the SDK's two racing error shapes can even be constructed. Four examples
// (`pr-summary-agent`, `pr-summary-review`, `support-triage`, `triage-agent`)
// get this for free from `@pome-sh/adapter-claude-sdk`'s `query()`, the shared
// seam every one of them already routes through — it wraps the exact racy
// `sdkQuery()` call, so the marker point and the race are in the same
// function. The other four (`gmail-retry-notify`, `merge-agent`,
// `minimal-viktor`, `minimal-viktor-langgraph`) import nothing from
// `@pome-sh/*` at all — no shared seam covers them — so each prints the
// literal marker itself, gated on `POME_SMOKE_MARK_OUTBOUND=1` so real users
// never see it. `assertEveryExampleEmitsMarker()` asserts the PROPERTY (every
// discovered example has a route to the marker — either the shared seam or
// its own literal) rather than hand-listing which four need their own, so a
// ninth example that forgets it reds here by name instead of silently
// reporting FAIL forever with nothing pointing at why.
//
// What the marker does NOT prove: that a socket was written. It is printed at
// the outbound call SITE, so anything that throws between that line and the
// syscall prints it first. Two such classes were measured (the SDK failing to
// resolve the `claude` binary; a malformed twin URL) and both used to FAIL, so
// `PRE_OUTBOUND_VETOES` below reds them explicitly on their own error CODE —
// deterministic where the removed error-TEXT matching was not, since none of
// those codes can be produced by a failure after a call went out. Crashes
// AFTER a successful outbound call are out of scope by design and always were:
// this gate's claim is "reached an outbound call", never "the work was
// correct" (`probe:examples` and the scenario suites own that).
//
// Fail-closed: REACHED-OUTBOUND now requires the marker to be present in the
// captured output. `BENIGN_FAILURE_SIGNATURES` still fires — but only to
// supply a human-readable REASON alongside a marker-backed "reached" verdict,
// never to decide the verdict itself. An example that crashes before it ever
// reaches its marker line cannot be classified as reached no matter how
// benign-looking its crash text is (verified by launching a deliberately
// pre-wiring crash whose message contains "ECONNREFUSED"/"401 invalid
// x-api-key" — it still FAILs).
//
// SETTLE_MS is a second, independent nondeterminism this does NOT remove: it
// is a wall clock racing the `claude` CLI's cold-start time, so the OK
// (still-alive) vs REACHED (marker-then-exit) split is environment-shaped — a
// machine with an authenticated `claude` login can report several "still
// running at the settle" where CI reports zero. That split does not change
// the pass/fail verdict (both OK and REACHED are passing outcomes, and the
// marker fires within milliseconds of process start either way, long before
// SETTLE_MS), so it is stated here and in the printed summary rather than
// engineered away.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(repoRoot, "agent-examples");

// How long to let each example run before we conclude it survived module
// evaluation and reached real (async) work. A launch-above-class TDZ throws
// synchronously while the module body evaluates — well under a second — so a
// few seconds is plenty even with tsx's cold-start transpile.
export const SETTLE_MS = 5000;

// The V8 message for accessing a `let`/`const`/`class` binding in its temporal
// dead zone. This is the exact crash the tsc gate missed.
// A TDZ crash is a hard failure regardless of exit code or timing.
export const TDZ_SIGNATURE = /(?:Cannot access '[^']+' before initialization|before initialization)/;

// The positive-evidence marker. A fixed literal every example prints
// to stderr, synchronously, immediately before its first outbound (twin or
// model) call — see the file header for why this replaced error-text
// matching as the thing REACHED-OUTBOUND is decided on. Gated behind
// POME_SMOKE_MARK_OUTBOUND so it never appears in a real user's terminal.
export const OUTBOUND_MARKER = "POME_SMOKE_REACHED_OUTBOUND";
export const MARK_OUTBOUND_ENV = "POME_SMOKE_MARK_OUTBOUND";

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

// The marker proves the process REACHED its outbound call site; it
// cannot prove a socket was ever written. Two crash classes were MEASURED to
// print the marker and then die before any network syscall: the Agent SDK
// failing to resolve the `claude` binary (`native binary not found at …` —
// pure config, no request) and a malformed twin URL (`ERR_INVALID_URL`, thrown
// by fetch while parsing, after the marker line). Both FAILED under the old
// text classifier and would silently become passes on the marker alone —
// "a crash before real work reads as success" through the back door,
// with the `claude` binary going unresolvable in CI converting all four
// adapter-backed examples at once.
//
// So: a veto. Each pattern is an error CODE that cannot be produced by a
// failure AFTER an outbound call, which is what keeps this deterministic where
// the error-TEXT matching this ticket removed was not — none of these appear in
// the SDK's racing error shapes. The imprecision is fail-closed in the safe
// direction: a pre-outbound class this list misses keeps today's verdict, and
// no real outbound failure can be redded by it.
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

// The kickoff instruction. This is NOT a fake credential and NOT dead wiring:
// it is the only thing that gives a launched example anything to do, and four
// of the eight (`gmail-retry-notify`, `merge-agent`, `minimal-viktor`,
// `minimal-viktor-langgraph`) call `requiredEnv("POME_TASK")` and throw at
// startup without it. It therefore applies on BOTH legs, and keeping it out of
// SMOKE_DEAD_WIRING below is load-bearing: the first cut of the live leg overlaid nothing
// at all in LIVE mode, so those four died on `Error: POME_TASK is required`
// and the gate classified them FAIL with "returned without evidence it did any
// real work" — i.e. a credentialed run would have redded 4 of 8 on its
// very first run, for an unset env var that has nothing to do with the
// property this leg exists to prove, which is exactly the kind of
// non-diagnosable red that trains a reader to ignore the alarm.
const SMOKE_TASK = "Smoke run: triage/summarize the open items in acme/api.";

// Settings the credentialed leg supplies only when the caller has NOT.
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
  // example this gate was extended to cover died in env resolution and
  // the gate still printed OK — it proved the module evaluates and nothing more,
  // never reaching examineeOptions() or query(), which is where a launch-above-
  // declaration TDZ this gate exists to catch would actually fire.
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
  // PR leg: unchanged from before the live leg existed — the overlay wins unconditionally,
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
  // Tells every example (directly, or via @pome-sh/adapter-claude-sdk's
  // query()) to print OUTBOUND_MARKER before its first outbound call. Neither a
  // credential nor wiring, so it applies unconditionally on both legs.
  env[MARK_OUTBOUND_ENV] = "1";
  return env;
}

// The credentialed leg switch. Read once at module load (same as
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
      `"proves nothing but looks like it does" failure this leg exists to prevent.`,
  };
}

export const LIVE = resolveLiveFlag(process.env.SMOKE_EXAMPLES_LIVE).live;

// The credentials a credentialed run cannot proceed without. `ANTHROPIC_API_KEY`
// is required unconditionally rather than accepting `AI_GATEWAY_API_KEY` as an
// alternative: `minimal-viktor-langgraph` constructs its `ChatAnthropic` model
// from `ANTHROPIC_API_KEY` directly and never consults the gateway key (see
// agent-examples/minimal-viktor-langgraph/src/index.ts), so a leg that accepted the
// gateway key alone would still strand that example at "no evidence of real
// work" while reporting the OTHER seven's gateway-routed calls as proof the
// leg is credentialed. `POME_AUTH_TOKEN` is the one twin-side signal every
// wired example reads (see this file's header); its presence is
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
// pasted into the secret box, the shape we have found blank in Infisical —
// is TRUTHY and would sail through, leaving the leg to launch every example with
// a whitespace API key and report the resulting per-example crashes as "the
// example is broken" instead of "the credential is blank". Trim, so present-but-
// blank is named as absent.
export function missingLiveEnv(env = process.env) {
  return LIVE_REQUIRED_ENV.filter((name) => !env[name]?.trim());
}

// The floor the credentialed leg asks for: at least one example
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

// The counted-numerator property. `classifyLaunch()` already gives
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

// Asserts the PROPERTY, not the instance list: every discovered
// example must have SOME route to printing OUTBOUND_MARKER before its first
// outbound call, or classifyLaunch()'s fail-closed rule means it can never
// report "reached" again — silently, with nothing pointing at why. A
// dependency on `@pome-sh/adapter-claude-sdk` covers it for free (its
// `query()` wrapper emits the marker itself, wrapping the exact SDK call that
// races); anything else must contain the literal marker in its own source. A
// ninth example that is neither reds here BY NAME, at design time, instead of
// silently degrading to permanent-FAIL at run time.
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

// The DEPENDENCY only covers an example if it resolves to the WORKSPACE copy of
// the adapter. `agent-examples/support-triage` pins the PUBLISHED tarball on purpose
// (it is `npx degit`-fetchable as a standalone subtree — see
// scripts/gate-examples.mjs's header), and a published tarball cut before
// the marker existed prints nothing: measured on this branch, its installed
// `dist/index.js` contains ZERO occurrences of OUTBOUND_MARKER while the three
// `file:`-linked siblings contain one each, so support-triage FAILED every run
// while a dependency-NAME check called it covered — the guard waving through
// the one instance it was written to catch. A registry-pinned example must
// therefore print the literal itself, and does.
function adapterResolvesToWorkspace(deps) {
  const pin = deps["@pome-sh/adapter-claude-sdk"];
  return typeof pin === "string" && /^(?:file:|link:|\.\.?\/)/.test(pin);
}

// Emission, not mention: the literal inside a `console.error(...)` call, so a
// marker named in a COMMENT (or in prose about the marker) does not buy
// coverage. A static check still cannot prove the line is reachable or
// correctly placed — `classifyLaunch()` is fail-closed for that, and an
// example whose marker never actually prints FAILS loudly with the marker
// named in its reason.
const MARKER_EMISSION = new RegExp(`console\\.error\\(\\s*["'\`]${OUTBOUND_MARKER}["'\`]`);

function sourceContainsMarker(srcDir) {
  if (!existsSync(srcDir)) return false;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (MARKER_EMISSION.test(readFileSync(join(srcDir, entry.name), "utf8"))) return true;
  }
  return false;
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
//
// "reached" now hinges on OUTBOUND_MARKER being present in the
// captured output, never on matching the failure TEXT. BENIGN_FAILURE_SIGNATURES
// still runs, but only to decorate a marker-backed verdict with a human-readable
// reason; a match there with no marker present classifies as FAIL, exactly like
// a match on any other prose the process happened to print. This is what makes
// the verdict independent of which of the two error shapes the SDK's internal
// race produces (see the file header) — the marker is printed before the race
// can even begin.
export function classifyLaunch({ output, stillRunningAtSettle, exitCode, signal, live = LIVE }) {
  if (TDZ_SIGNATURE.test(output)) {
    return { status: "fail", reason: "TDZ crash on launch" };
  }
  if (stillRunningAtSettle) {
    return { status: "ok", reason: `still running after ${SETTLE_MS}ms` };
  }
  const how = signal ? `killed by ${signal}` : `exited code ${exitCode}`;
  // The marker plus proof-of-absence: a crash whose own error code says no
  // request could have left the process is not "reached", however early the
  // marker printed.
  const vetoed = matchPreOutboundVeto(output);
  const reachedOutbound = output.includes(OUTBOUND_MARKER) && !vetoed;
  // Descriptive only from here down — matchBenignFailure() never gates a
  // verdict, it only names the failure class for a reader once the marker has
  // already proven the process got there.
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

  // exitCode === 0
  if (reachedOutbound && !live) {
    // SMOKE_ENV's twin/model wiring cannot succeed on the PR leg — dead
    // loopback ports, invalid keys — so reaching the marker and still exiting
    // 0 means the failure was swallowed, not that the run actually worked.
    // The defect this gate exists to prevent, verbatim — just proven by the
    // marker instead of guessed from failure text.
    return {
      status: "fail",
      reason:
        `exited code 0 after emitting ${OUTBOUND_MARKER} while running against SMOKE_ENV's dead wiring ` +
        `(invalid keys, unreachable twin) — success here is impossible, so exit 0 means the failure ` +
        `was swallowed instead of propagated. Propagate it so the process exits non-zero.`,
    };
  }
  // The third possibility exists ONLY on the credentialed leg, and the
  // reader has to be told about it or the first real nightly red is a mystery.
  // OK is "still alive at the settle", so with real twins and a real key a
  // GENUINELY CORRECT example that answers fast — the twin's default seed does
  // not contain what SMOKE_TASK asks about, the model correctly says "nothing
  // found", the process exits 0 in under 5s — lands HERE, on a FAIL whose text
  // otherwise insists the example is broken. Distinguishing "exited 0 having
  // produced work output" from "exited 0 having done nothing" needs a work
  // marker no example emits in a common form across three frameworks (a
  // DIFFERENT marker than OUTBOUND_MARKER, which proves only that the attempt
  // started, not that it succeeded), so it is not a cheap fix; naming the
  // possibility in the message is, and it makes the first red diagnosable
  // instead of training the reader to ignore the alarm.
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

function smokeOne(name) {
  return new Promise((resolvePromise) => {
    const cwd = join(examplesDir, name);
    const tsx = join(cwd, "node_modules", ".bin", "tsx");
    if (!existsSync(tsx)) {
      resolvePromise({
        name,
        status: "fail",
        reason: `tsx not installed (run \`npm ci\` in agent-examples/${name})`,
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
      // SIGKILL reaches the direct `tsx` child only; the `claude` CLI
      // GRANDCHILD the Agent SDK spawned survives holding the write end of
      // these pipes, so the parent's read handles stay active and node cannot
      // exit. Measured on this branch: a complete summary printed, then 194s
      // of nothing before the process ended — in CI (no `timeout-minutes` on
      // `typecheck-test`, so GitHub's 360-minute default) a hang after a
      // finished summary is a new flake replacing the one this ticket fixed.
      // The verdict is already computed from `output`, so releasing the pipes
      // here loses nothing.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise({ name, output, ...verdict });
    };

    // Classify on 'close', not 'exit'. Node only guarantees the piped stdio
    // streams are drained on 'close'; 'exit' can fire with the child's final
    // write still unread, and the whole verdict is a regex over `output` — so
    // an example whose only BENIGN_FAILURE_SIGNATURES match sits in its last
    // stderr line (`agent errored: … ECONNREFUSED`, written immediately before
    // `process.exit(1)`) can be read as "no outbound-call failure in its
    // output" and FAIL on one run and REACHED-OUTBOUND on the next, from the
    // same commit. 'exit' still records HOW it exited, because 'close' carries
    // the same code/signal but a lingering grandchild holding the pipe open can
    // delay it past SETTLE_MS — and a child that has already exited must be
    // classified on its exit code, never as "still running at the settle",
    // which would turn a fast exit into a false OK.
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

// Guarded so the regression suite can `import { classifyLaunch, discoverExamples }`
// without re-triggering a real launch of all eight examples. Realpath'd on
// both sides (not `import.meta.main`: that landed in Node 24.2, root
// `engines` allows `>=24`, and `undefined` there makes the guard false and
// this file exit 0 having smoked nothing — the same shape fixed in
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
  // Fail closed, before anything launches. A credentialed leg
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
          `This is the credentialed leg — it must not fall back to SMOKE_ENV's dead ` +
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

  // Before anything launches: every discovered example must have a
  // route to the positive-evidence marker, or a run that never sees it is
  // indistinguishable from an example that was simply never wired for it.
  const markerCoverage = assertEveryExampleEmitsMarker(examplesDir, examples);
  if (!markerCoverage.ok) {
    console.error(markerCoverage.message);
    process.exit(1);
  }

  console.log(
    `Launch-smoking ${examples.length} example(s)${LIVE ? " (LIVE — real twin + model credentials)" : ""}: ` +
      examples.join(", "),
  );

  const failures = [];
  const reached = [];
  const oks = [];
  for (const name of examples) {
    process.stdout.write(`\n=== agent-examples/${name} === `);
    let result;
    try {
      result = await smokeOne(name);
    } catch (err) {
      // smokeOne() is designed to always resolve — the SETTLE_MS timer, the
      // child 'close' handler, and the child 'error' handler each
      // independently produce a verdict — but this loop must not itself
      // become the next silent-drop bug. This catch deliberately does NOT
      // invent a verdict for work that never ran: the name lands in no bucket,
      // so assertReportedCount() below names it as missing.
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
      // Show the tail so the crash (or the silent nothing) is visible in CI logs.
      if (tail) console.error(tail);
      failures.push({ name, reason: result.reason });
    }
  }

  // The reported set is DERIVED from the three verdict buckets, never
  // tracked alongside them. A separate `reportedNames.push(name)` next to the
  // `await` would mark a name reported before the ok/reached/fail dispatch had
  // put it anywhere, so the next silent-drop bug — a `continue` added inside
  // the dispatch, or a fourth `status` no branch matches — would still net
  // `ok: true` and still shrink the "N of M" total unannounced. Reading the
  // buckets makes the assertion check the thing the summary actually counts.
  const reportedCount = assertReportedCount(
    examples,
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
    // A missing verdict is reported and reds independently of
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
      `${reached.length} failed at an outbound call. ` +
      `(The OK/REACHED split is environment-shaped: SETTLE_MS=${SETTLE_MS}ms races the \`claude\` CLI's ` +
      `cold-start time, so a faster or slower machine shifts examples between the two buckets. Neither ` +
      `bucket's pass/fail verdict depends on that race — OUTBOUND_MARKER is emitted within milliseconds ` +
      `of process start, long before the settle — only which of the two passing buckets an example lands ` +
      `in.)`,
  );
}
