#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Child process that invokes one example's tools against booted twins and reports
// back as JSON.

const emit = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);

const spec = JSON.parse(process.env.POME_PROBE_SPEC ?? "null");
if (!spec) {
  emit({ kind: "error", message: "POME_PROBE_SPEC is not set" });
  process.exit(1);
}

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

const table = new Map(Array.isArray(tools) ? tools.map((tool) => [tool.name, tool]) : Object.entries(tools));
emit({ kind: "tools", names: [...table.keys()] });

for (const probe of spec.probes) {
  const tool = table.get(probe.tool);
  if (!tool) continue; // the parent reports this as `unknown-tool`.
  current = { tool: probe.tool, calls: [], threw: null };
  const invoke = tool.handler ?? tool.execute ?? (typeof tool.invoke === "function" ? tool.invoke.bind(tool) : undefined);
  if (typeof invoke !== "function") {
    current.threw = `tool "${probe.tool}" exposes neither handler(), execute(), nor invoke()`;
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
