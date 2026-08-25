#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Case table for example-isolation. Every case asserts the RED direction: a rule that has
// quietly stopped failing prints the same line as one with nothing to report.

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
  "allowedTools instead of tools": {
    source: `${IMPORT_LINE}\nawait query({ prompt: "go", options: { allowedTools: ["mcp__github__x"], settingSources: [] } });`,
    missing: ["tools"],
  },
  "conditional spread does not count": {
    source: `${IMPORT_LINE}\nconst ISO = process.env.ISO;\nawait query({ prompt: "go", options: { tools: [], ...(ISO ? { settingSources: [] } : {}) } });`,
    missing: ["settingSources"],
  },
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

const SEALED = {
  "both inline": `${IMPORT_LINE}\nawait query({ prompt: "go", options: { tools: [], settingSources: [] } });`,
  "options from a same-file function": `${IMPORT_LINE}\nfunction examineeOptions(mcpServers) {\n  return { tools: BUILT_IN, settingSources: [], mcpServers };\n}\nawait query({ prompt: "go", options: examineeOptions({}) });`,
  "options from a same-file const": `${IMPORT_LINE}\nconst OPTIONS = { tools: [], settingSources: [] };\nawait query({ prompt: "go", options: OPTIONS });`,
  "options from an arrow with a concise body": `${IMPORT_LINE}\nconst build = () => ({ tools: [], settingSources: [] });\nawait query({ prompt: "go", options: build() });`,
  "named constants": `${IMPORT_LINE}\nawait query({ prompt: "go", options: { tools: BUILT_IN_TOOLS, settingSources: NO_FS } });`,
  "an unconditional spread carries the keys": `${IMPORT_LINE}\nconst ISOLATION = { tools: [], settingSources: [] };\nawait query({ prompt: "go", options: { ...ISOLATION, maxTurns: 5 } });`,
  "quoted keys": `${IMPORT_LINE}\nawait query({ prompt: "go", options: { "tools": [], "settingSources": [] } });`,
  "a quoted `options` key": `${IMPORT_LINE}\nawait query({ prompt: "go", "options": { tools: [], settingSources: [] } });`,
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

{
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

    const empty = discoverSdkExamples(join(tmp, "nope"));
    assert(empty.length === 0, "a missing agent-examples/ directory discovers nothing rather than throwing");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const broken = "const x = {{{;";
  assert(parseErrorsIn(broken, "x.ts").length > 0, "a syntax error is reported rather than scanned as clean");
  assert(parseErrorsIn(`${IMPORT_LINE}\nconst a: string[] = [];`, "x.ts").length === 0, "real TS parses cleanly");
}

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
    expect: "red",
    contains: "below the floor",
  },
  {
    name: "no SDK example at all reds the rule, rather than passing over nothing",
    files: { "agent-examples/plain/package.json": JSON.stringify({ dependencies: {} }) },
    expect: "red",
    contains: "so this rule scanned nothing",
  },
  {
    name: "a `query` imported from somewhere else is not this rule's business",
    files: {
      "agent-examples/db/package.json": JSON.stringify({
        dependencies: { "@anthropic-ai/claude-agent-sdk": "^0.3.221" },
      }),
      "agent-examples/db/src/index.ts":
        `import { query } from "./sqlite.js";\nawait query({ prompt: "go" });\n`,
    },
    expect: "red",
    contains: "found no `query()` call",
  },
]);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("example-isolation: all assertions passed.");
