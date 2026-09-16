// SPDX-License-Identifier: Apache-2.0
// Acceptance — `pome twin tape` against a twin `pome twin start` booted, as
// real child processes (F-1837): an agent-shaped MCP call lands on the tape,
// the tape says it changed state, `--diff` names what it left behind, and
// `--json` carries the same as one envelope.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTsxBin } from "../../scripts/lib/resolve-tsx.js";

const CLI_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_BIN = resolveTsxBin(import.meta.url);
const MAIN_TS = join(CLI_ROOT, "src", "cli", "main.ts");

async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address() as { port: number };
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function runCli(cwd: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(TSX_BIN, [MAIN_TS, ...args], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    proc.stdout?.on("data", (chunk) => { output += chunk; });
    proc.stderr?.on("data", (chunk) => { output += chunk; });
    proc.once("error", reject);
    proc.once("exit", (code) => resolve({ code, output }));
  });
}

let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
});

describe("pome twin tape (e2e)", () => {
  it(
    "shows an MCP write as a state change, diffs what it left, and says the same in --json",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pome-twin-tape-e2e-"));
      const port = await freePort();
      child = spawn(TSX_BIN, [MAIN_TS, "twin", "start", "github", "--port", String(port)], {
        cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => { output += chunk; });
      child.stderr?.on("data", (chunk) => { output += chunk; });

      const base = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          if ((await fetch(`${base}/healthz`)).status === 200) break;
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) throw new Error(`twin start never answered\n--- output ---\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const tokenDeadline = Date.now() + 5_000;
      while (!/POME_AUTH_TOKEN=/.test(output) && Date.now() < tokenDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const token = output.match(/POME_AUTH_TOKEN=(\S+)/)?.[1];
      expect(token).toBeTruthy();

      // Before anything happens, the tape is empty and the diff is clean.
      const empty = await runCli(cwd, ["twin", "tape", "--diff"]);
      expect(empty.code).toBe(0);
      expect(empty.output).toContain("github twin at");
      expect(empty.output).toContain("0 requests");
      expect(empty.output).toContain("State: unchanged since boot.");

      // What an agent does: one MCP tool call that creates an issue, then a
      // route the twin does not model.
      const mcp = await fetch(`${base}/s/standalone/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "create_issue",
            arguments: { owner: "acme", repo: "api", title: "Login page returns 500 after the deploy" },
          },
        }),
      });
      expect(mcp.status).toBe(200);
      await fetch(`${base}/s/standalone/nope/unmodelled`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const tape = await runCli(cwd, ["twin", "tape", "github", "--diff"]);
      expect(tape.code).toBe(0);
      expect(tape.output).toContain("2 requests");
      expect(tape.output).toMatch(/create_issue +200 +semantic +changed/);
      expect(tape.output).toMatch(/GET \/nope\/unmodelled +501 +unsupported +read +← not modelled by this twin/);
      expect(tape.output).toContain("1 changed state · 1 unsupported · 0 reads");
      expect(tape.output).toMatch(/repositories\[acme\/api\]\.issues +\+1 added: #\d+/);

      const asJson = await runCli(cwd, ["twin", "tape", "--json", "--diff"]);
      expect(asJson.code).toBe(0);
      const envelope = JSON.parse(asJson.output) as {
        twin: string;
        url: string;
        requests: { tool: string | null; state_mutation: boolean; note: string | null }[];
        summary: { requests: number; changed_state: number; unsupported: number };
        diff: { path: string; added: string[] }[];
      };
      expect(envelope.twin).toBe("github");
      expect(envelope.url).toBe(`${base}/s/standalone`);
      expect(envelope.requests.map((row) => row.tool)).toEqual(["create_issue", null]);
      expect(envelope.summary).toMatchObject({ requests: 2, changed_state: 1, unsupported: 1 });
      expect(envelope.diff.some((entry) => entry.path === "repositories[acme/api].issues" && entry.added.length === 1)).toBe(true);

      child.kill("SIGINT");
    },
    120_000,
  );

  it("says how to start a twin when none is recorded here", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pome-twin-tape-none-e2e-"));
    const { code, output } = await runCli(cwd, ["twin", "tape"]);
    expect(code).not.toBe(0);
    expect(output).toContain("No standalone twin status found");
    expect(output).toContain("pome twin start <github|slack|stripe|gmail|linear>");
  });
});
