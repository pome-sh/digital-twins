// SPDX-License-Identifier: Apache-2.0
// Acceptance — the dashboard flags on `pome twin start`, as a real child
// process. The page and its server are `test/unit/dashboard/server.test.ts`,
// and the installed tarball serving it is `scripts/clean-room-pack-test.mjs`.
// What only a child process shows is how the flags shape the command's own
// life: what it refuses, what it prints, and whether Ctrl-C still stops it
// cleanly.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

type Run = { child: ChildProcess; output: () => string; exited: Promise<number | null> };

function start(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Run {
  const proc = spawn(TSX_BIN, [MAIN_TS, "twin", "start", ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout?.on("data", (chunk) => { output += chunk; });
  proc.stderr?.on("data", (chunk) => { output += chunk; });
  const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
  return { child: proc, output: () => output, exited };
}

/** The first capture of `pattern` once the command has printed it. */
async function printed(run: Run, pattern: RegExp, withinMs = 60_000): Promise<string> {
  const deadline = Date.now() + withinMs;
  while (!pattern.test(run.output()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const match = run.output().match(pattern)?.[1];
  if (!match) throw new Error(`never printed ${pattern}\n--- output ---\n${run.output()}`);
  return match;
}

let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
});

describe("pome twin start — dashboard flags (e2e)", () => {
  it.skipIf(process.platform === "win32")(
    "--open hands the printed URL to the browser and does not wait for the browser to exit",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pome-twin-start-open-e2e-"));
      const bin = join(cwd, "bin");
      const seen = join(cwd, "browser-argv");
      await mkdir(bin);
      // Stands in for `open` and `xdg-open`: records what it was given, then
      // stays up for as long as the command that started it — the shape
      // `xdg-open` has when it runs the browser in the foreground.
      const browser = [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > '${seen}'`,
        'while kill -0 "$PPID" 2>/dev/null; do sleep 0.2; done',
        "",
      ].join("\n");
      for (const name of ["open", "xdg-open"]) {
        await writeFile(join(bin, name), browser);
        await chmod(join(bin, name), 0o755);
      }

      const dashboardPort = await freePort();
      const run = start(
        cwd,
        ["github", "--port", String(await freePort()), "--dashboard-port", String(dashboardPort), "--open"],
        { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
      );
      child = run.child;

      const url = await printed(run, /^Dashboard: (\S+)$/m);
      expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${dashboardPort}/\\?k=[0-9a-f]+$`));
      // The line after the browser launch. Awaiting the launcher held it back
      // for as long as the browser stayed up, with no Ctrl-C handler installed.
      await printed(run, /(Ctrl-C to stop\.)/, 10_000);

      const deadline = Date.now() + 10_000;
      while (!existsSync(seen) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect((await readFile(seen, "utf8")).trim()).toBe(url);
      expect((await fetch(url)).status).toBe(200);

      run.child.kill("SIGINT");
      await expect(run.exited).resolves.toBe(0);
      await expect(fetch(url)).rejects.toThrow();
    },
    90_000,
  );

  it(
    "refuses an invalid --dashboard-port before binding anything",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pome-twin-start-dashport-e2e-"));
      const port = await freePort();
      const run = start(cwd, ["github", "--port", String(port), "--dashboard-port", "0"]);
      child = run.child;

      expect(await run.exited).not.toBe(0);
      expect(run.output()).toContain('invalid --dashboard-port "0"');
      expect(run.output()).not.toContain("POME_AUTH_TOKEN=");
      expect(existsSync(join(cwd, ".pome", "twin-status.json"))).toBe(false);
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    },
    60_000,
  );

  it(
    "--no-dashboard serves the twin and no dashboard",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pome-twin-start-nodash-e2e-"));
      const run = start(cwd, ["github", "--port", String(await freePort()), "--no-dashboard"]);
      child = run.child;

      await printed(run, /(Ctrl-C to stop\.)/);
      expect(run.output()).toContain("POME_AUTH_TOKEN=");
      expect(run.output()).not.toContain("Dashboard:");

      run.child.kill("SIGINT");
      await expect(run.exited).resolves.toBe(0);
    },
    90_000,
  );
});
