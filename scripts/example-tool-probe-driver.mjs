#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// F-1152 probe driver — the child half of scripts/probe-example-tools.mjs.
//
// Runs INSIDE one example's dependency tree (under that example's own `tsx`
// when it has one, so a `.ts` tool table and its zod / `file:`-linked adapter
// copies resolve the way they do for a real run), and knows nothing about twins
// or seeds. It takes a module path, an export name, a config object, and a probe
// list; it reports what the wire did.
//
// Plain JavaScript, not TypeScript, for two reasons: bare `node` can run it
// against the test suite's fixture examples (no `npm ci` in a throwaway tree),
// and `tsx` registers a process-wide loader, so a `.mjs` entry can still
// dynamically import a `.ts` module.
//
// The fetch hook is the whole point. `examples/merge-agent`,
// `examples/minimal-viktor`, `examples/gmail-retry-notify`, and
// `examples/minimal-viktor-langgraph` all deliberately SWALLOW a non-2xx and
// hand the model `{ok: false, status}` so one bad twin call cannot abort a run
// — so a probe that only watched for a thrown error would be silent on exactly
// the failure this gate exists to catch. Only the response status counts.

const emit = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);

const spec = JSON.parse(process.env.POME_PROBE_SPEC ?? "null");
if (!spec) {
  emit({ kind: "error", message: "POME_PROBE_SPEC is not set" });
  process.exit(1);
}

// Install the hook BEFORE importing the example: a module that captured
// `globalThis.fetch` at import time would otherwise keep the unhooked copy.
let current = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await realFetch(input, init);
  if (current) {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    current.calls.push({ method: init?.method ?? "GET", url, status: response.status });
  }
  return response;
};

let tools;
try {
  const imported = await import(spec.module);
  const build = imported[spec.export];
  if (typeof build !== "function") {
    emit({
      kind: "error",
      message:
        `${spec.module} does not export a function named "${spec.export}" ` +
        `(exports: ${Object.keys(imported).join(", ") || "none"})`,
    });
    process.exit(1);
  }
  tools = build(spec.config);
} catch (err) {
  emit({
    kind: "error",
    message: `failed to build the tool table: ${err instanceof Error ? err.stack : String(err)}`,
  });
  process.exit(1);
}

// Both tool shapes the bundled examples use: the Claude Agent SDK's `tool()`
// returns `{name, description, inputSchema, handler}` objects that callers
// collect into an ARRAY, while the Vercel AI SDK and LangGraph keep a RECORD of
// name -> `{execute}`.
const table = new Map(Array.isArray(tools) ? tools.map((tool) => [tool.name, tool]) : Object.entries(tools));
emit({ kind: "tools", names: [...table.keys()] });

// Sequential, in declared order: probes mutate twin state, and a later probe may
// depend on an earlier one's write.
for (const probe of spec.probes) {
  const tool = table.get(probe.tool);
  if (!tool) continue; // the parent reports this as `unknown-tool`.
  current = { tool: probe.tool, calls: [], threw: null };
  const invoke = tool.handler ?? tool.execute;
  if (typeof invoke !== "function") {
    current.threw = `tool "${probe.tool}" exposes neither handler() nor execute()`;
  } else {
    try {
      await invoke(probe.args, {});
    } catch (err) {
      current.threw = err instanceof Error ? err.message : String(err);
    }
  }
  emit({ kind: "probe", ...current });
  current = null;
}
