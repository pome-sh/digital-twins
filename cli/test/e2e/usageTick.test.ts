// SPDX-License-Identifier: Apache-2.0
// Acceptance — the daily usage tick through the real CLI (F-1832): a command
// sends one event to the configured host with the command's name and nothing
// from the invocation, prints the notice once, sends nothing the second time
// that day, and sends nothing at all with POME_TELEMETRY=0 or in CI.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTsxBin } from "../../scripts/lib/resolve-tsx.js";

const CLI_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_BIN = resolveTsxBin(import.meta.url);
const MAIN_TS = join(CLI_ROOT, "src", "cli", "main.ts");

let server: Server;
let host = "";
const received: { path: string; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: JSON.parse(raw || "{}") as Record<string, unknown> });
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":1}');
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  host = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(home: string, env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return await new Promise((resolve, reject) => {
    // A clean environment: no CI, no opt-out inherited from the developer's shell.
    const { CI: _ci, DO_NOT_TRACK: _dnt, POME_TELEMETRY: _pt, ...inherited } = process.env;
    const proc = spawn(TSX_BIN, [MAIN_TS, ...args], {
      cwd: home,
      env: { ...inherited, HOME: home, USERPROFILE: home, POME_TELEMETRY_KEY: "phc_e2e", POME_TELEMETRY_HOST: host, POME_CLI_DISABLE_KEYCHAIN: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => { stdout += chunk; });
    proc.stderr?.on("data", (chunk) => { stderr += chunk; });
    proc.once("error", reject);
    proc.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("daily usage tick (e2e)", () => {
  it("sends one event with the command's name, prints the notice once, and not twice a day", async () => {
    const home = await mkdtemp(join(tmpdir(), "pome-usage-e2e-"));
    const before = received.length;

    const first = await run(home, {}, ["twin", "status"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("No standalone twin status found");
    expect(first.stderr).toContain("pome sends one anonymous usage event per day");
    expect(received.length).toBe(before + 1);
    const event = received[before]!;
    expect(event.path).toBe("/capture/");
    expect(event.body.event).toBe("cli_usage");
    expect(event.body.api_key).toBe("phc_e2e");
    const properties = event.body.properties as Record<string, unknown>;
    expect(properties.command).toBe("twin status");
    expect(properties.os).toBe(process.platform);
    expect(typeof properties.cli_version).toBe("string");
    expect(JSON.stringify(event.body)).not.toContain(home);

    const second = await run(home, {}, ["twin", "status"]);
    expect(second.code).toBe(0);
    expect(second.stderr).not.toContain("anonymous usage event");
    expect(received.length).toBe(before + 1);
  }, 60_000);

  it("sends nothing with POME_TELEMETRY=0, with DO_NOT_TRACK, or in CI", async () => {
    const before = received.length;
    for (const env of [{ POME_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }, { CI: "true" }]) {
      const home = await mkdtemp(join(tmpdir(), "pome-usage-off-e2e-"));
      const result = await run(home, env, ["twin", "status"]);
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("anonymous usage event");
    }
    expect(received.length).toBe(before);
  }, 60_000);

  it("--help and --version send nothing", async () => {
    const before = received.length;
    const home = await mkdtemp(join(tmpdir(), "pome-usage-help-e2e-"));
    expect((await run(home, {}, ["--help"])).code).toBe(0);
    expect((await run(home, {}, ["--version"])).code).toBe(0);
    expect(received.length).toBe(before);
  }, 60_000);
});
