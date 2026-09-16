#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// The door, walked by a machine (F-1829): install `@pome-sh/cli` cold into a
// clean room, run `pome twin start github`, and connect to it EXACTLY the way
// Claude Code and Codex do — by taking the `claude mcp add … --header
// "Authorization: Bearer …"` line the banner printed, and driving
// `initialize` → `notifications/initialized` → `tools/list` → `tools/call`
// over streamable HTTP with that URL and that header. Then `pome twin tape
// --json` from the same install must show the call as a state change.
//
// It fails the day the printed snippet stops working, which is the whole
// point: the README, the docs and every post paste that line.
//
// Two sources, one script:
//   --source tarball   `npm pack` this checkout's CLI and install the tarball
//                      (pull requests: proves what is about to ship)
//   --source npm       install `@pome-sh/cli@<spec>` from the registry
//                      (schedule / dispatch: proves what a stranger gets today)
//
// No dependencies beyond Node ≥ 24 — the same floor the door promises.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const [key, inline] = process.argv[i].split("=");
  if (!key.startsWith("--")) continue;
  args.set(key.slice(2), inline ?? (process.argv[i + 1]?.startsWith("--") ? "true" : process.argv[++i] ?? "true"));
}
const SOURCE = args.get("source") ?? "tarball";
const SPEC = args.get("spec") ?? "latest";
const PORT = Number(args.get("port") ?? 3391);
const KEEP = args.has("keep");
const TWIN = "github";

const rooms = [];
let twin;
const timings = {};

function room(label) {
  const dir = mkdtempSync(join(tmpdir(), `pome-door-${label}-`));
  rooms.push(dir);
  return dir;
}

function cleanup() {
  if (twin && twin.exitCode === null) twin.kill("SIGKILL");
  if (KEEP) {
    console.log(`--keep: left rooms at\n  ${rooms.join("\n  ")}`);
    return;
  }
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true });
}

function fail(message) {
  console.error(`\n❌ door e2e: ${message}`);
  cleanup();
  process.exit(1);
}

function sh(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function since(start) {
  return Math.round(performance.now() - start);
}

// Every step below runs inside main() so that an error thrown anywhere — a
// banner that does not parse, a refused request, a failing `twin tape` — still
// kills the twin and removes the rooms. `fail()` is the only exit for a red.
async function main() {
  // ── 1. A clean room with a cold npm cache ──────────────────────────────────
  const install = room("install");
  const cache = room("npm-cache");
  const env = { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_fund: "false" };

  let spec = `@pome-sh/cli@${SPEC}`;
  if (SOURCE === "tarball") {
    const dest = room("pack");
    sh("npm", ["pack", "-w", "@pome-sh/cli", "--ignore-scripts", "--pack-destination", dest], { cwd: ROOT, env });
    const files = readdirSync(dest).filter((f) => f.endsWith(".tgz"));
    if (files.length !== 1) fail(`npm pack produced ${files.length} tarballs in ${dest}`);
    spec = join(dest, files[0]);
  } else if (SOURCE !== "npm") {
    fail(`--source must be tarball or npm, got ${SOURCE}`);
  }

  console.log(`door e2e: installing ${spec} into ${install} (cache ${cache})`);
  const installStart = performance.now();
  try {
    sh("npm", ["install", "--prefix", install, "--no-audit", "--no-fund", "--loglevel=error", spec], { env, cwd: install });
  } catch (err) {
    fail(`npm install failed:\n${err.stderr ?? err.message}`);
  }
  timings.install_ms = since(installStart);
  const pomeBin = join(install, "node_modules", ".bin", "pome");
  const version = sh(pomeBin, ["--version"], { env }).trim();
  console.log(`door e2e: installed pome ${version} in ${timings.install_ms} ms`);

  // ── 2. `pome twin start github`, as the README's first command ─────────────
  const cwd = room("project");
  const bootStart = performance.now();
  twin = spawn(pomeBin, ["twin", "start", TWIN, "--port", String(PORT)], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let banner = "";
  twin.stdout.on("data", (chunk) => { banner += chunk; });
  twin.stderr.on("data", (chunk) => { banner += chunk; });
  const exited = new Promise((resolveExit) => twin.once("exit", (code) => resolveExit(code)));

  const base = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok && (await res.json()).twin === TWIN) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) fail(`twin never answered /healthz on ${PORT}\n--- banner ---\n${banner}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  timings.boot_to_healthy_ms = since(bootStart);
  console.log(`door e2e: ${TWIN} twin healthy in ${timings.boot_to_healthy_ms} ms`);

  // The banner arrives buffered; wait for the connect block to be complete.
  const bannerDeadline = Date.now() + 10_000;
  while (!banner.includes("Ctrl-C to stop.") && Date.now() < bannerDeadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!banner.includes("Ctrl-C to stop.")) fail(`banner never finished\n--- banner ---\n${banner}`);

  // ── 3. Take the printed snippets, exactly as printed ───────────────────────
  const claudeLine = banner.match(/^\s*(claude mcp add --transport http (\S+) (\S+) --header "Authorization: Bearer (\S+)")\s*$/m);
  if (!claudeLine) fail(`no claude mcp add line in the banner\n--- banner ---\n${banner}`);
  const [, pasted, serverName, mcpUrl, token] = claudeLine;
  if (serverName !== `pome-${TWIN}`) fail(`server name is ${serverName}, expected pome-${TWIN}`);
  if (mcpUrl !== `${base}/s/standalone/mcp`) fail(`printed MCP URL is ${mcpUrl}`);
  console.log(`door e2e: pasted line → ${pasted.replace(token, "<token>")}`);

  const codexTable = banner.match(/^\s*\[mcp_servers\.(\S+)\]\s*\n\s*url = "([^"]+)"\s*\n\s*bearer_token_env_var = "POME_AUTH_TOKEN"\s*$/m);
  if (!codexTable) fail(`no Codex table in the banner\n--- banner ---\n${banner}`);
  if (codexTable[1] !== serverName || codexTable[2] !== mcpUrl) fail("Codex table disagrees with the claude line");

  const exportLine = banner.match(/^\s*export .*\bPOME_AUTH_TOKEN=(\S+)/m);
  if (!exportLine || exportLine[1] !== token) fail("export line missing, or carries a different token");

  const stanzaStart = banner.indexOf('"mcpServers"');
  if (stanzaStart < 0) fail("no .mcp.json stanza in the banner");
  const braceStart = banner.lastIndexOf("{", stanzaStart);
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < banner.length; i += 1) {
    if (banner[i] === "{") depth += 1;
    if (banner[i] === "}") depth -= 1;
    if (depth === 0) {
      braceEnd = i;
      break;
    }
  }
  const stanza = JSON.parse(banner.slice(braceStart, braceEnd + 1));
  const server = stanza.mcpServers?.[serverName];
  if (!server || server.url !== mcpUrl || server.headers?.Authorization !== "Bearer ${POME_AUTH_TOKEN}") {
    fail(`.mcp.json stanza is not the one expected: ${JSON.stringify(stanza)}`);
  }

  // ── 4. The handshake, the way Claude Code and Codex do it ──────────────────
  // Streamable HTTP: JSON-RPC over POST, `Accept` for both JSON and SSE, the
  // bearer from the pasted line, and the session id echoed back when the server
  // hands one out.
  let sessionId;
  async function rpc(body, { expectResult = true } = {}) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-06-18",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(mcpUrl, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (!expectResult) {
      if (res.status >= 300) fail(`${body.method} answered ${res.status}`);
      return undefined;
    }
    if (!res.ok) fail(`${body.method} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    let message;
    if (contentType.includes("text/event-stream")) {
      const data = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
      message = JSON.parse(data.at(-1) ?? "null");
    } else {
      message = JSON.parse(text);
    }
    if (!message || message.error) fail(`${body.method} returned an error: ${JSON.stringify(message?.error ?? message)}`);
    return message.result;
  }

  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pome-door-e2e", version: "1.0.0" },
    },
  });
  if (!init?.serverInfo?.name) fail(`initialize returned no serverInfo: ${JSON.stringify(init)}`);
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { expectResult: false });

  const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (tools?.tools ?? []).map((t) => t.name);
  if (!names.includes("create_issue")) fail(`tools/list has no create_issue (got ${names.length} tools)`);

  const call = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "create_issue",
      arguments: { owner: "acme", repo: "api", title: "Login page returns 500 after the deploy" },
    },
  });
  const text = call?.content?.find((c) => c.type === "text")?.text;
  let issue;
  try {
    issue = JSON.parse(text);
  } catch {
    fail(`tools/call create_issue returned no JSON issue: ${JSON.stringify(call).slice(0, 300)}`);
  }
  if (typeof issue?.number !== "number") fail(`create_issue returned no number: ${text?.slice(0, 200)}`);
  console.log(`door e2e: initialize → ${init.serverInfo.name}; tools/list → ${names.length} tools; create_issue → #${issue.number}`);

  // ── 5. The same install's `pome twin tape` sees the call as a state change ──
  const tapeJson = sh(pomeBin, ["twin", "tape", "--json", "--diff"], { cwd, env });
  const tape = JSON.parse(tapeJson);
  const row = tape.requests?.find((r) => r.tool === "create_issue");
  if (!row || row.state_mutation !== true) fail(`twin tape does not show create_issue as a state change: ${tapeJson.slice(0, 400)}`);
  const added = tape.diff?.find((d) => d.path === "repositories[acme/api].issues");
  if (!added || added.added.length !== 1) fail(`twin tape --diff does not show the new issue: ${JSON.stringify(tape.diff)}`);
  console.log(`door e2e: pome twin tape → ${tape.summary.requests} request(s), ${tape.summary.changed_state} changed state; diff ${added.path} +${added.added.length}`);

  // ── 6. Ctrl-C stops it ─────────────────────────────────────────────────────
  twin.kill("SIGINT");
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15_000))]);
  if (code !== 0) fail(`twin start exited ${code} on SIGINT`);

  console.log(`door e2e: OK — pome ${version} from ${SOURCE}; install ${timings.install_ms} ms, boot→healthy ${timings.boot_to_healthy_ms} ms, node ${process.version}, ${process.platform}`);
  console.log(`::notice::door e2e OK — pome ${version} (${SOURCE}); install ${timings.install_ms} ms; boot→healthy ${timings.boot_to_healthy_ms} ms; ${process.platform}`);
  cleanup();
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
}
