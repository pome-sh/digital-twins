#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for the `example-isolation` lint rule.
//
// The gate's own failure mode is the one it exists to prevent: a checker that
// silently classifies nothing prints the same "no findings" as a repo that is
// genuinely isolated. So the assertions below come in pairs — every shape that
// must RED, and every shape that must not — plus a live scan of the real
// examples, which is what stops the fix from being reverted quietly.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineCases } from "../harness.mjs";
import {
  MIN_QUERY_CALL_SITES,
  REQUIRED_OPTIONS,
  discoverSdkExamples,
  parseErrorsIn,
  scanExamples,
  scanSource,
} from "./example-isolation.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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
  "tools set, settingSources omitted — the incident itself": {
    source: `${IMPORT_LINE}\nawait query({ prompt: "go", options: { tools: [] } });`,
    missing: ["settingSources"],
  },
  "settingSources set, tools omitted": {
    source: `${IMPORT_LINE}\nawait query({ prompt: "go", options: { settingSources: [] } });`,
    missing: ["tools"],
  },
  // `allowedTools` is the trap the blast radius is built on: it reads
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
// class of bug this rule exists to catch.
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
  // agent-examples/support-triage's real shape: the options are composed in a named
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
  "a quoted `options` key": `${IMPORT_LINE}\nawait query({ prompt: "go", "options": { tools: [], settingSources: [] } });`,
  // `query({ prompt, options })` is the same call as `options: options`; reading
  // it as unresolvable would be a false RED on correct work.
  "shorthand options": `${IMPORT_LINE}\nconst options = { tools: [], settingSources: [] };\nawait query({ prompt, options });`,
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
      mkdirSync(join(tmp, "agent-examples", name, "src"), { recursive: true });
      writeFileSync(join(tmp, "agent-examples", name, "package.json"), JSON.stringify(manifest));
    };
    write("uses-sdk", { dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.221" } });
    write("dev-dep-only", { devDependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.221" } });
    write("other-framework", { dependencies: { ai: "^6.0.241" } });
    mkdirSync(join(tmp, "agent-examples", "no-manifest"), { recursive: true });

    const found = discoverSdkExamples(tmp).map((e) => e.name);
    assert(
      JSON.stringify(found) === JSON.stringify(["dev-dep-only", "uses-sdk"]),
      `discovery finds SDK examples by manifest, in either dependency section (got ${JSON.stringify(found)})`,
    );

    // An SDK example with no `query()` call is reported, not skipped: "this
    // example launches no agent" and "the call is in a shape I cannot see" read
    // identically otherwise, and only the first is a pass.
    writeFileSync(join(tmp, "agent-examples", "uses-sdk", "src", "index.ts"), 'export const x = 1;\n');
    writeFileSync(
      join(tmp, "agent-examples", "dev-dep-only", "src", "index.ts"),
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
    assert(empty.length === 0, "a missing agent-examples/ directory discovers nothing rather than throwing");
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
    "the gate requires exactly the two doors this gate is about",
  );
}

// ── the runner exits non-zero, not just prints ──────────────────────────────
// A rule that reports findings and exits 0 is wired into CI as a no-op. The
// green direction is covered by the live scan above; these assert the red one
// through the real process boundary, against a throwaway tree. `--root` is what
// makes that possible without copying the runner into the fixture.
defineCases("example-isolation", [
  {
    name: "an example missing a door reds the rule, naming the door and the example",
    files: {
      "agent-examples/leaky/package.json": JSON.stringify({
        dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.221" },
      }),
      "agent-examples/leaky/src/index.ts": `${IMPORT_LINE}\nawait query({ prompt: "go", options: { tools: [] } });\n`,
    },
    expect: "red",
    contains: ["settingSources", "leaky"],
  },
  {
    name: "an example setting both doors is reported on the floor, not on a door",
    files: {
      "agent-examples/tight/package.json": JSON.stringify({
        dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.221" },
      }),
      "agent-examples/tight/src/index.ts":
        `${IMPORT_LINE}\nawait query({ prompt: "go", options: { tools: [], settingSources: [] } });\n`,
    },
    // Below the call-site floor of 4, so it reds — on the floor, not on a door.
    expect: "red",
    contains: "below the floor",
  },
  {
    // A tree where the examples moved must red rather than report a pass having
    // scanned nothing.
    name: "no SDK example at all reds the rule, rather than passing over nothing",
    files: { "agent-examples/plain/package.json": JSON.stringify({ dependencies: {} }) },
    expect: "red",
    contains: "so this rule scanned nothing",
  },
  {
    // The `query()` binding has to come from the SDK or the adapter; a `query`
    // from a database helper is not this rule's business.
    name: "a `query` imported from somewhere else is not this rule's business",
    files: {
      "agent-examples/db/package.json": JSON.stringify({
        dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.221" },
      }),
      "agent-examples/db/src/index.ts":
        `import { query } from "./sqlite.js";\nawait query({ prompt: "go" });\n`,
    },
    // No call site classified, so the floor reds it — the point is that the call
    // is not reported as an unshut door.
    expect: "red",
    contains: "found no `query()` call",
  },
]);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("example-isolation: all assertions passed.");
