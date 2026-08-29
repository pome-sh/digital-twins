#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// A stand-in for the `claude` executable that the Claude Agent SDK spawns.
// Writes the argv it was launched with to `POME_FAKE_CLI_ARGV_PATH`, then
// speaks the two stream-json messages the SDK needs to finish a query cleanly.
//
// It exists so `test/isolation-argv.test.ts` can assert on the FLAG that
// reaches the CLI rather than on a property of an options object. The SDK turns
// `settingSources` into argv with `if (v !== undefined) push(\`--setting-sources=${v.join(",")}\`)`
// — omitted means the flag is absent and the CLI loads user + project + local
// settings — so the argv is where "sealed" is either true or not.
//
// Spawned directly (`spawn(executable, args)`, no shell), so this file needs
// its executable bit committed. `test/isolation-argv.test.ts` asserts that.

import { writeFileSync } from "node:fs";

const argvPath = process.env.POME_FAKE_CLI_ARGV_PATH;
if (!argvPath) {
  console.error("fake-claude-cli: POME_FAKE_CLI_ARGV_PATH is unset");
  process.exit(2);
}
writeFileSync(argvPath, JSON.stringify(process.argv.slice(2)));

// Enough of the stream for the SDK to resolve the query rather than throw, so a
// test that fails does so on its assertion instead of on a transport error.
const sessionId = "00000000-0000-4000-8000-000000000000";
const line = (msg) => process.stdout.write(`${JSON.stringify({ ...msg, session_id: sessionId, uuid: sessionId })}\n`);

line({
  type: "system",
  subtype: "init",
  tools: [],
  mcp_servers: [],
  model: "fake-claude-cli",
  cwd: process.cwd(),
  apiKeySource: "none",
  permissionMode: "default",
  slash_commands: [],
  output_style: "default",
});
line({
  type: "result",
  subtype: "success",
  result: "ok",
  is_error: false,
  duration_ms: 0,
  duration_api_ms: 0,
  num_turns: 1,
  total_cost_usd: 0,
  usage: {},
});
process.stdout.end();
