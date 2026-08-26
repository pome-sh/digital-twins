// SPDX-License-Identifier: Apache-2.0
// Acceptance — `pome twin start` as a real child process: boots the twin as a
// foreground server, reuses the secret persisted at the boot-secret contract,
// and boots a USER-AUTHORED seed from `--seed`, read back through the twin's
// own REST surface.
//
// The generated-starter round trip (`pome twin seed` → `--seed` → read back, all
// five twins) is `twinSeedRoundTrip.test.ts`.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "hono/jwt";
import { afterEach, describe, expect, it } from "vitest";
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
