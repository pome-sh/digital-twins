#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for scripts/check-example-sdk-isolation.mjs (F-1295).
//
// The gate's own failure mode is the one it exists to prevent: a checker that
// silently classifies nothing prints the same "no findings" as a repo that is
// genuinely isolated. So the assertions below come in pairs — every shape that
// must RED, and every shape that must not — plus a live scan of the real
// examples, which is what stops the fix from being reverted quietly.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MIN_QUERY_CALL_SITES,
  REQUIRED_OPTIONS,
  discoverSdkExamples,
  parseErrorsIn,
  scanExamples,
  scanSource,
} from "./check-example-sdk-isolation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures += 1;
  console.error(`FAIL  ${msg}`);
}

const IMPORT_LINE = 'import { query } from "@pome-sh/adapter-claude-sdk";';
const missingOf = (result) => result.findings.flatMap((f) => f.missing).sort();

// ── the shapes that must RED ────────────────────────────────────────────────
// Each is a real `query()` call — so the gate must both COUNT it as a call site
// and report the door(s) left open. A shape that goes uncounted is worse than
// one reported wrong: it subtracts from the floor that makes a clean run mean
// anything.
const OPEN_DOORS = {
  "no options at all": {
    source: `${IMPORT_LINE}\nawait query({ prompt: "go" });`,
    missing: ["settingSources", "tools"],
  },
  "options present, both omitted": {
    source: `${IMPORT_LINE}\nawait query({ prompt: "go", options: { maxTurns: 5 } });`,
    missing: ["settingSources", "tools"],
  },
  "tools set, settingSources omitted — the F-1295 incident itself": {
    source: `${IMPORT_LINE}\nawait query({ prompt: "go", options: { tools: [] } });`,
    missing: ["settingSources"],
  },
  "settingSources set, tools omitted": {
    source: `${IMPORT_LINE}\nawait query({ prompt: "go", options: { settingSources: [] } });`,
    missing: ["tools"],
  },
  // `allowedTools` is the trap this ticket's blast radius is built on: it reads
  // like a restriction and is not one (it only auto-approves). A gate that
  // accepted it would bless three of the four bundled examples exactly as they
  // shipped.
  "allowedTools instead of tools": {
    source: `${IMPORT_LINE}\nawait query({ prompt: "go", options: { allowedTools: ["mcp__github__x"], settingSources: [] } });`,
    missing: ["tools"],
  },
  // A door shut only when an env var happens to be set is a door that is open —
  // and the conditional spread is the shape three bundled examples already use
  // for `model`, so it is the one a future author reaches for by habit.
  "conditional spread does not count": {
    source: `${IMPORT_LINE}\nconst ISO = process.env.ISO;\nawait query({ prompt: "go", options: { tools: [], ...(ISO ? { settingSources: [] } : {}) } });`,
    missing: ["settingSources"],
  },
  // The single most likely regression: the options are deleted and the comment
  // explaining them stays. A grep for the string would call this green.
  "the word in a comment is not the option": {
    source: `${IMPORT_LINE}\n// settingSources: [] closes the filesystem door\nawait query({ prompt: "go", options: { tools: [] } });`,
    missing: ["settingSources"],
  },
  "the word in a string literal is not the option": {
    source: `${IMPORT_LINE}\nconst doc = "pass settingSources: [] to isolate";\nawait query({ prompt: "go", options: { tools: [], banner: doc } });`,
    missing: ["settingSources"],
  },
};
for (const [label, { source, missing }] of Object.entries(OPEN_DOORS)) {
  const result = scanSource(source, "index.ts");
  assert(result.callSites === 1, `an open-door call is still COUNTED as a call site: ${label} (got ${result.callSites})`);
  assert(
    JSON.stringify(missingOf(result)) === JSON.stringify([...missing].sort()),
    `the right door(s) are reported open: ${label} (got ${JSON.stringify(missingOf(result))}, want ${JSON.stringify(missing)})`,
  );
}

// An options object the gate cannot resolve must be a FINDING, never a pass.
// "I could not tell" and "it is isolated" printing the same way is the whole
// class of bug this ticket family keeps hitting.
{
  const cases = {
    "options from an imported helper": `${IMPORT_LINE}\nimport { opts } from "./opts.js";\nawait query({ prompt: "go", options: opts });`,
    "options behind a ternary": `${IMPORT_LINE}\nawait query({ prompt: "go", options: flag ? a : b });`,
    "options from a two-return helper": `${IMPORT_LINE}\nfunction build(f) { if (f) { return { tools: [], settingSources: [] }; } return {}; }\nawait query({ prompt: "go", options: build(1) });`,
    "the whole argument is a variable of unknown shape": `${IMPORT_LINE}\nawait query(params);`,
  };
  for (const [label, source] of Object.entries(cases)) {
    const result = scanSource(source, "index.ts");
    assert(result.callSites === 1, `an unresolvable call is counted: ${label}`);
    assert(result.findings.length === 1, `an unresolvable call is a finding, not a pass: ${label}`);
  }
}

// ── the shapes that must stay GREEN ─────────────────────────────────────────
const SEALED = {
  "both inline": `${IMPORT_LINE}\nawait query({ prompt: "go", options: { tools: [], settingSources: [] } });`,
  // examples/support-triage's real shape: the options are composed in a named
  // function so its own test can assert the policy is WIRED IN, and the call
  // site passes the call. A resolver that only read inline literals would have
  // to red the one example that already got this right.
  "options from a same-file function": `${IMPORT_LINE}\nfunction examineeOptions(mcpServers) {\n  return { tools: BUILT_IN, settingSources: [], mcpServers };\n}\nawait query({ prompt: "go", options: examineeOptions({}) });`,
  "options from a same-file const": `${IMPORT_LINE}\nconst OPTIONS = { tools: [], settingSources: [] };\nawait query({ prompt: "go", options: OPTIONS });`,
  "options from an arrow with a concise body": `${IMPORT_LINE}\nconst build = () => ({ tools: [], settingSources: [] });\nawait query({ prompt: "go", options: build() });`,
  // Named constants rather than literals: the gate asserts the door is NAMED,
  // not that it is spelled `[]` — support-triage's `tools: BUILT_IN_TOOLS` is
  // the sanctioned form, pinned by that example's own unit test.
  "named constants": `${IMPORT_LINE}\nawait query({ prompt: "go", options: { tools: BUILT_IN_TOOLS, settingSources: NO_FS } });`,
  "an unconditional spread carries the keys": `${IMPORT_LINE}\nconst ISOLATION = { tools: [], settingSources: [] };\nawait query({ prompt: "go", options: { ...ISOLATION, maxTurns: 5 } });`,
  "quoted keys": `${IMPORT_LINE}\nawait query({ prompt: "go", options: { "tools": [], "settingSources": [] } });`,
  "aliased import": `import { query as ask } from "@pome-sh/adapter-claude-sdk";\nawait ask({ prompt: "go", options: { tools: [], settingSources: [] } });`,
  "namespace import": `import * as sdk from "@anthropic-ai/claude-agent-sdk";\nawait sdk.query({ prompt: "go", options: { tools: [], settingSources: [] } });`,
  "raw SDK import": `import { query } from "@anthropic-ai/claude-agent-sdk";\nawait query({ prompt: "go", options: { tools: [], settingSources: [] } });`,
  "TypeScript syntax the parser must read": `${IMPORT_LINE}\ninterface W { readonly url: string }\nconst cfg = { url: process.env.U as string } satisfies W;\nawait query({ prompt: cfg.url, options: { tools: [] as string[], settingSources: [] } });`,
};
for (const [label, source] of Object.entries(SEALED)) {
  const result = scanSource(source, "index.ts");
  assert(result.callSites === 1, `a sealed call is seen at all: ${label} (got ${result.callSites} call sites)`);
  assert(result.findings.length === 0, `a sealed call is clean: ${label} (got ${JSON.stringify(result.findings)})`);
}

// ── what is NOT this gate's subject ─────────────────────────────────────────
// A false red on unrelated code is how a gate gets deleted. `query` is an
// ordinary name — a database client, a twin REST helper — and only the one
// bound to the SDK (directly or through the adapter) opens these two doors.
const NOT_SUBJECTS = {
  "query from an unrelated module": 'import { query } from "pg";\nawait query({ prompt: "go", options: {} });',
  "a locally defined query": "function query(x) { return x; }\nquery({ prompt: 'go', options: {} });",
  "a type-only import cannot be called": 'import type { query } from "@anthropic-ai/claude-agent-sdk";\ndeclare const q: typeof query;',
  "a method named query on some object": "await db.query({ prompt: 'go', options: {} });",
};
for (const [label, source] of Object.entries(NOT_SUBJECTS)) {
  const result = scanSource(source, "index.ts");
  assert(result.callSites === 0, `not a subject, so not counted: ${label} (got ${result.callSites})`);
  assert(result.findings.length === 0, `not a subject, so not a finding: ${label}`);
}

// ── discovery is by manifest, never a hand-kept list ────────────────────────
{
  // realpathSync because macOS's /tmp is a symlink to /private/tmp, and the
  // discovery walk statSync's absolute paths.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "f1295-")));
  try {
    const write = (name, manifest) => {
      mkdirSync(join(tmp, "examples", name, "src"), { recursive: true });
      writeFileSync(join(tmp, "examples", name, "package.json"), JSON.stringify(manifest));
    };
    write("uses-sdk", { dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.221" } });
    write("dev-dep-only", { devDependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.221" } });
    write("other-framework", { dependencies: { ai: "^6.0.241" } });
    mkdirSync(join(tmp, "examples", "no-manifest"), { recursive: true });

    const found = discoverSdkExamples(tmp).map((e) => e.name);
    assert(
      JSON.stringify(found) === JSON.stringify(["dev-dep-only", "uses-sdk"]),
      `discovery finds SDK examples by manifest, in either dependency section (got ${JSON.stringify(found)})`,
    );

    // An SDK example with no `query()` call is reported, not skipped: "this
    // example launches no agent" and "the call is in a shape I cannot see" read
    // identically otherwise, and only the first is a pass.
    writeFileSync(join(tmp, "examples", "uses-sdk", "src", "index.ts"), 'export const x = 1;\n');
    writeFileSync(
      join(tmp, "examples", "dev-dep-only", "src", "index.ts"),
      `${IMPORT_LINE}\nawait query({ prompt: "go", options: { tools: [], settingSources: [] } });\n`,
    );
    const scan = scanExamples(tmp);
    assert(
      JSON.stringify(scan.silentExamples) === JSON.stringify(["uses-sdk"]),
      `an SDK example with no query() call is reported as silent (got ${JSON.stringify(scan.silentExamples)})`,
    );
    assert(scan.callSites === 1, `call sites are summed across examples (got ${scan.callSites})`);

    // A repo with no SDK example at all must not print a pass — the runner
    // exits 1 on it, and this is the unit-level half of that.
    const empty = discoverSdkExamples(join(tmp, "nope"));
    assert(empty.length === 0, "a missing examples/ directory discovers nothing rather than throwing");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── an unreadable file is not a clean file ──────────────────────────────────
{
  const broken = "const x = {{{;";
  assert(parseErrorsIn(broken, "x.ts").length > 0, "a syntax error is reported rather than scanned as clean");
  assert(parseErrorsIn(`${IMPORT_LINE}\nconst a: string[] = [];`, "x.ts").length === 0, "real TS parses cleanly");
}

// ── the live repo, which is what actually holds the fix in place ────────────
{
  const scan = scanExamples(ROOT);
  assert(scan.examples.length >= 4, `the four bundled SDK examples are discovered (got ${JSON.stringify(scan.examples)})`);
  assert(
    scan.callSites >= MIN_QUERY_CALL_SITES,
    `the live scan classifies at least the floor of ${MIN_QUERY_CALL_SITES} call sites (got ${scan.callSites})`,
  );
  assert(scan.findings.length === 0, `every bundled SDK example is isolated (got ${JSON.stringify(scan.findings)})`);
  assert(scan.unparseable.length === 0, `every bundled example source parses (got ${JSON.stringify(scan.unparseable)})`);
  assert(scan.silentExamples.length === 0, `every bundled SDK example calls query() (got ${JSON.stringify(scan.silentExamples)})`);
  assert(
    JSON.stringify(REQUIRED_OPTIONS) === JSON.stringify(["tools", "settingSources"]),
    "the gate requires exactly the two doors F-1295 is about",
  );
}

// ── the runner exits non-zero, not just prints ──────────────────────────────
// A gate that reports findings and exits 0 is wired into CI as a no-op. The
// green direction is covered by the live scan above; this asserts the red one
// through the real process boundary.
{
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "f1295-exit-")));
  try {
    mkdirSync(join(tmp, "examples", "leaky", "src"), { recursive: true });
    writeFileSync(
      join(tmp, "examples", "leaky", "package.json"),
      JSON.stringify({ dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.221" } }),
    );
    writeFileSync(
      join(tmp, "examples", "leaky", "src", "index.ts"),
      `${IMPORT_LINE}\nawait query({ prompt: "go", options: { tools: [] } });\n`,
    );
    // The runner derives its repo root from its own location, so run a COPY of
    // it inside the fixture tree — that is what makes the fixture, not this
    // repo, the thing it scans. node_modules is symlinked in because the gate
    // imports the `typescript` parser.
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    copyFileSync(
      join(ROOT, "scripts", "check-example-sdk-isolation.mjs"),
      join(tmp, "scripts", "check-example-sdk-isolation.mjs"),
    );
    symlinkSync(join(ROOT, "node_modules"), join(tmp, "node_modules"), "dir");

    const runIn = (cwd) => {
      try {
        const stdout = execFileSync(process.execPath, [join(cwd, "scripts", "check-example-sdk-isolation.mjs")], {
          stdio: "pipe",
          encoding: "utf8",
        });
        return { exitCode: 0, output: stdout };
      } catch (err) {
        return { exitCode: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
      }
    };

    const red = runIn(tmp);
    assert(red.exitCode === 1, `the runner EXITS 1 on an example missing a door (got ${red.exitCode})`);
    assert(
      red.output.includes("settingSources") && red.output.includes("leaky"),
      `the failure names the door and the example (got: ${red.output.slice(0, 300)})`,
    );

    const green = runIn(ROOT);
    assert(green.exitCode === 0, `the runner exits 0 on the real, isolated repo (got ${green.exitCode})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("check-example-sdk-isolation.mjs: all assertions passed.");
