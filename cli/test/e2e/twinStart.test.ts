// SPDX-License-Identifier: Apache-2.0
// Acceptance — `pome twin start` as a real child process: boots the twin as a
// foreground server, reuses the secret persisted at the boot-secret contract,
// and boots a USER-AUTHORED seed from `--seed`, read back through the twin's
// own REST surface.
//
// The generated-starter round trip (`pome twin new-seed` → `--seed` → read back, all
// five twins) is `twinSeedRoundTrip.test.ts`.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "hono/jwt";
import { afterEach, describe, expect, it } from "vitest";
import { TWIN_NAME_LIST } from "../../src/twin/registry.js";
import { resolveTsxBin } from "../../scripts/lib/resolve-tsx.js";

const CLI_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_BIN = resolveTsxBin(import.meta.url);
const MAIN_TS = join(CLI_ROOT, "src", "cli", "main.ts");
const PERSISTED_SECRET = "e2e-persisted-secret-0123456789abcdef";

async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address() as { port: number };
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** One-shot run for the cases that only read the command's output. */
async function runCli(args: string[]): Promise<{ code: number | null; output: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pome-twin-start-cli-e2e-"));
  return await new Promise((resolve, reject) => {
    const proc = spawn(TSX_BIN, [MAIN_TS, ...args], {
      cwd,
      env: process.env,
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

describe("pome twin start (e2e)", () => {
  it(
    "serves /healthz, honors the persisted secret, and stops on SIGINT",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pome-twin-start-e2e-"));
      const dataDir = join(cwd, "twin-data");
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "secret"), `${PERSISTED_SECRET}\n`);

      const port = await freePort();
      const env: NodeJS.ProcessEnv = { ...process.env, POME_TWIN_DATA_DIR: dataDir };
      delete env.TWIN_AUTH_SECRET; // the persisted-file branch under test
      child = spawn(TSX_BIN, [MAIN_TS, "twin", "start", "github", "--port", String(port)], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => { output += chunk; });
      child.stderr?.on("data", (chunk) => { output += chunk; });
      const exited = new Promise<number | null>((resolve) => child?.once("exit", (code) => resolve(code)));

      const base = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          const res = await fetch(`${base}/healthz`);
          if (res.status === 200) break;
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) {
          throw new Error(`twin start never answered /healthz 200\n--- output ---\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // The server can accept connections before the parent process receives
      // the child's buffered startup output. Wait for the observable message
      // instead of racing the stdout/stderr data events against /healthz.
      const secretMessage = `using the persisted secret from ${join(dataDir, "secret")}`;
      const outputDeadline = Date.now() + 5_000;
      while (!output.includes(secretMessage) && child.exitCode === null) {
        if (Date.now() > outputDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(output).toContain(secretMessage);

      // A JWT minted from the persisted secret authenticates (the CLI and
      // the running twin resolved the same secret).
      const minted = await sign(
        { sid: "standalone", team_id: "tm_local", exp: Math.floor(Date.now() / 1000) + 3600 },
        PERSISTED_SECRET,
      );
      const viaFileSecret = await fetch(`${base}/s/standalone/_pome/health`, {
        headers: { Authorization: `Bearer ${minted}` },
      });
      expect(viaFileSecret.status).toBe(200);

      // The ready-to-use token the command prints works as printed.
      const printed = output.match(/POME_AUTH_TOKEN=(\S+)/)?.[1];
      expect(printed).toBeTruthy();
      const viaPrintedToken = await fetch(`${base}/s/standalone/_pome/health`, {
        headers: { Authorization: `Bearer ${printed}` },
      });
      expect(viaPrintedToken.status).toBe(200);

      // The connect block names the same MCP URL and token the banner printed,
      // in the form `claude mcp add` takes as pasted (F-1827).
      expect(output).toContain(
        `claude mcp add --transport http pome-github ${base}/s/standalone/mcp --header "Authorization: Bearer ${printed}"`,
      );
      expect(output).toContain("[mcp_servers.pome-github]");

      // Foreground contract: Ctrl-C stops the server and exits 0.
      child.kill("SIGINT");
      await expect(exited).resolves.toBe(0);
    },
    90_000,
  );

  it(
    "boots a seed from --seed and serves a repository the default has never had",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pome-twin-start-seed-e2e-"));
      const seedPath = join(cwd, "seed.json");
      // `vakoi/billing` is not in the github twin's defaultSeedState(); the
      // default's `acme/api` is. Asserting BOTH is what separates "my seed
      // landed" from "the twin merged my seed into its default".
      await writeFile(
        seedPath,
        JSON.stringify({
          users: [{ login: "vakoi", type: "Organization", name: "Vakoi" }],
          repositories: [
            {
              owner: "vakoi",
              name: "billing",
              issues: [{ number: 1, title: "Invoice webhook drops retries" }],
            },
          ],
        }),
      );

      const port = await freePort();
      child = spawn(
        TSX_BIN,
        [MAIN_TS, "twin", "start", "github", "--port", String(port), "--seed", seedPath],
        { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
      );
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
        if (Date.now() > deadline) {
          throw new Error(`twin start --seed never answered /healthz 200\n--- output ---\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const tokenDeadline = Date.now() + 5_000;
      while (!/POME_AUTH_TOKEN=/.test(output) && Date.now() < tokenDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const token = output.match(/POME_AUTH_TOKEN=(\S+)/)?.[1];
      expect(token).toBeTruthy();
      const auth = { Authorization: `Bearer ${token}` };

      const seeded = await fetch(`${base}/s/standalone/repos/vakoi/billing`, { headers: auth });
      expect(seeded.status).toBe(200);
      expect(((await seeded.json()) as { full_name: string }).full_name).toBe("vakoi/billing");

      const issues = await fetch(`${base}/s/standalone/repos/vakoi/billing/issues`, {
        headers: auth,
      });
      expect(((await issues.json()) as { title: string }[])[0]?.title).toBe(
        "Invoice webhook drops retries",
      );

      // The default world is REPLACED, not merged into.
      const fromDefault = await fetch(`${base}/s/standalone/repos/acme/api`, { headers: auth });
      expect(fromDefault.status).toBe(404);

      // The boot line answers "did my seed land?" without reading state, and
      // says outright what seeding does to the default.
      expect(output).toContain(`Seed: ${seedPath} (replaces the github twin's default).`);
    },
    90_000,
  );

  it(
    "refuses a schema-invalid --seed before binding a port, and exits non-zero",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pome-twin-start-badseed-e2e-"));
      const seedPath = join(cwd, "seed.json");
      await writeFile(seedPath, JSON.stringify({ repositories: [{ owner: "acme" }] }));

      const port = await freePort();
      child = spawn(
        TSX_BIN,
        [MAIN_TS, "twin", "start", "github", "--port", String(port), "--seed", seedPath],
        { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout?.on("data", (chunk) => { output += chunk; });
      child.stderr?.on("data", (chunk) => { output += chunk; });
      const exitCode = await new Promise<number | null>((resolve) =>
        child?.once("exit", (code) => resolve(code)),
      );

      expect(exitCode).not.toBe(0);
      expect(output).toContain("is not a seed this twin can boot");
      // Nothing is listening: the world is resolved before the server binds.
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    },
    90_000,
  );
});

describe("pome twin start — port already in use (e2e)", () => {
  it("fails before writing the status file or printing a banner", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pome-twin-start-inuse-e2e-"));
    // Hold the port for the whole run: @hono/node-server binds without an
    // `error` listener, so the ordering under test is "did anything get
    // written before the bind was known to have failed?"
    const holder = createServer();
    holder.listen(0, "127.0.0.1");
    await once(holder, "listening");
    const port = (holder.address() as { port: number }).port;
    try {
      child = spawn(TSX_BIN, [MAIN_TS, "twin", "start", "github", "--port", String(port)], {
        cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => {
        child?.once("error", reject);
        child?.once("exit", (exitCode) => resolve(exitCode));
      });

      expect(code).not.toBe(0);
      expect(stderr).toContain(`port ${port} is already in use`);
      expect(stdout + stderr).not.toContain("listening at");
      expect(existsSync(join(cwd, ".pome", "twin-status.json"))).toBe(false);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  }, 90_000);
});

describe("pome twin start — unknown-twin error (e2e)", () => {
  it("lists all five supported names, not just a subset", async () => {
    const { code, output } = await runCli(["twin", "start", "nonexistent-twin-name"]);
    expect(code).not.toBe(0);
    for (const name of TWIN_NAME_LIST) {
      expect(output).toContain(name);
    }
  });

  it("--help documents every first-party twin in the <name> argument", async () => {
    const { output } = await runCli(["twin", "start", "--help"]);
    for (const name of TWIN_NAME_LIST) {
      expect(output).toContain(name);
    }
  });
});

// F-1836 — several twins from one command, and two commands sharing a folder.
describe("pome twin start — several twins (e2e)", () => {
  type Spawned = { child: ChildProcess; output: () => string; exited: Promise<number | null> };
  function start(cwd: string, args: string[]): Spawned {
    const proc = spawn(TSX_BIN, [MAIN_TS, "twin", "start", ...args], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    proc.stdout?.on("data", (chunk) => { output += chunk; });
    proc.stderr?.on("data", (chunk) => { output += chunk; });
    const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
    return { child: proc, output: () => output, exited };
  }
  async function healthy(port: number, twin: string, output: () => string): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.status === 200 && ((await res.json()) as { twin?: string }).twin === twin) return;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        throw new Error(`${twin} never answered /healthz on ${port}\n--- output ---\n${output()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async function printed(output: () => string, pattern: RegExp): Promise<string> {
    const deadline = Date.now() + 10_000;
    while (!pattern.test(output()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const match = output().match(pattern)?.[1];
    if (!match) throw new Error(`never printed ${pattern}\n--- output ---\n${output()}`);
    return match;
  }

  it(
    "boots github and slack together on distinct ports, records both, and stops both on SIGINT",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pome-twin-start-multi-e2e-"));
      const port = await freePort();
      const run = start(cwd, ["github", "slack", "--port", String(port)]);
      child = run.child;

      await healthy(port, "github", run.output);
      const slackRest = await printed(run.output, /POME_SLACK_REST_URL=(\S+)/);
      const slackPort = Number(new URL(slackRest).port);
      expect(slackPort).toBeGreaterThan(port);
      await healthy(slackPort, "slack", run.output);

      // One token for the process, valid on both twins.
      const token = await printed(run.output, /POME_AUTH_TOKEN=(\S+)/);
      for (const p of [port, slackPort]) {
        const res = await fetch(`http://127.0.0.1:${p}/s/standalone/_pome/health`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
      }

      // One status block per twin, one shared connect block.
      await printed(run.output, /(Ctrl-C to stop\.)/);
      const output = run.output();
      expect(output.match(/twin listening at/g)?.length).toBe(2);
      expect(output).toContain(`claude mcp add --transport http pome-github http://127.0.0.1:${port}/s/standalone/mcp`);
      expect(output).toContain(`claude mcp add --transport http pome-slack ${slackRest}/mcp`);
      expect(output.match(/^  export POME_/gm)?.length).toBe(1);

      // The status file holds both, keyed by name; the top-level mirrors the first.
      const status = JSON.parse(await readFile(join(cwd, ".pome", "twin-status.json"), "utf8")) as {
        name: string;
        twins: Record<string, { rest_url: string; auth_token: string }>;
      };
      expect(Object.keys(status.twins)).toEqual(["github", "slack"]);
      expect(status.name).toBe("github");
      expect(status.twins.slack?.rest_url).toBe(slackRest);
      expect(status.twins.github?.auth_token).toBe(token);

      run.child.kill("SIGINT");
      await expect(run.exited).resolves.toBe(0);
      for (const p of [port, slackPort]) {
        await expect(fetch(`http://127.0.0.1:${p}/healthz`)).rejects.toThrow();
      }
    },
    120_000,
  );

  it(
    "a second twin start in the same folder keeps the first's status entry",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pome-twin-start-join-e2e-"));
      const first = start(cwd, ["github", "--port", String(await freePort())]);
      child = first.child;
      const githubRest = await printed(first.output, /POME_GITHUB_REST_URL=(\S+)/);
      await healthy(Number(new URL(githubRest).port), "github", first.output);

      const second = start(cwd, ["slack", "--port", String(await freePort())]);
      try {
        const slackRest = await printed(second.output, /POME_SLACK_REST_URL=(\S+)/);
        await healthy(Number(new URL(slackRest).port), "slack", second.output);

        const status = JSON.parse(await readFile(join(cwd, ".pome", "twin-status.json"), "utf8")) as {
          name: string;
          rest_url: string;
          twins: Record<string, { rest_url: string }>;
        };
        expect(Object.keys(status.twins).sort()).toEqual(["github", "slack"]);
        expect(status.twins.github?.rest_url).toBe(githubRest);
        expect(status.twins.slack?.rest_url).toBe(slackRest);
        // The older single-twin readers see the twin that was just started.
        expect(status.name).toBe("slack");
        expect(status.rest_url).toBe(slackRest);
      } finally {
        second.child.kill("SIGINT");
        await second.exited;
      }
      first.child.kill("SIGINT");
      await expect(first.exited).resolves.toBe(0);
    },
    120_000,
  );
});
