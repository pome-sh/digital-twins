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
// We deliberately do NOT assert a clean exit: with no live twin and an invalid
// model key the agent is *expected* to fail once it starts doing real work
// (network / auth). That benign runtime failure is not a smoke failure. The one
// thing that must never happen is the module failing to evaluate — which is
// exactly the class-before-initialization TDZ this gate guards against.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(repoRoot, "examples");

// How long to let each example run before we conclude it survived module
// evaluation. A launch-above-class TDZ throws synchronously while the module
// body evaluates — well under a second — so a few seconds is plenty even with
// tsx's cold-start transpile. A healthy example is still alive (doing real
// work) or has already failed on network/auth by the time this elapses.
const SETTLE_MS = 5000;

// The V8 message for accessing a `let`/`const`/`class` binding in its temporal
// dead zone. This is the exact crash F-900 fixed and F-866's tsc gate missed.
const TDZ_SIGNATURE = /(?:Cannot access '[^']+' before initialization|before initialization)/;

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

function discoverExamples() {
  const found = [];
  for (const name of readdirSync(examplesDir).sort()) {
    const pkgPath = join(examplesDir, name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    // Every runnable example starts with `tsx src/index.ts`; only those can
    // carry a launch-above-class TDZ.
    if (pkg.scripts?.start) found.push(name);
  }
  return found;
}

function smokeOne(name) {
  return new Promise((resolvePromise) => {
    const cwd = join(examplesDir, name);
    const tsx = join(cwd, "node_modules", ".bin", "tsx");
    if (!existsSync(tsx)) {
      resolvePromise({ name, ok: false, reason: `tsx not installed (run \`npm ci\` in examples/${name})`, output: "" });
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
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGKILL");
      resolvePromise(result);
    };

    // Survived long enough without a TDZ crash → the module evaluated fine.
    const timer = setTimeout(() => {
      finish({ name, ok: !TDZ_SIGNATURE.test(output), reason: "still running", output });
    }, SETTLE_MS);

    child.on("exit", (code, signal) => {
      // A TDZ crash prints the ReferenceError and exits non-zero on launch.
      const tdz = TDZ_SIGNATURE.test(output);
      finish({
        name,
        ok: !tdz,
        reason: tdz ? "TDZ crash on launch" : `exited ${signal ? `on ${signal}` : `code ${code}`} (no TDZ)`,
        output,
      });
    });

    child.on("error", (err) => {
      finish({ name, ok: false, reason: `failed to spawn: ${err.message}`, output });
    });
  });
}

const examples = discoverExamples();
if (examples.length === 0) {
  console.error("No runnable examples (with a `start` script) found.");
  process.exit(1);
}

console.log(`Launch-smoking ${examples.length} example(s): ${examples.join(", ")}`);

const failures = [];
for (const name of examples) {
  process.stdout.write(`\n=== examples/${name} === `);
  const result = await smokeOne(name);
  if (result.ok) {
    console.log(`OK (${result.reason})`);
  } else {
    console.log(`FAILED (${result.reason})`);
    // Show the tail so the TDZ ReferenceError is visible in CI logs.
    const tail = result.output.trim().split("\n").slice(-12).join("\n");
    if (tail) console.error(tail);
    failures.push(name);
  }
}

if (failures.length > 0) {
  console.error(`\nExamples that crash on launch: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${examples.length} examples launched without a TDZ crash.`);
