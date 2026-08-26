// SPDX-License-Identifier: Apache-2.0
// Acceptance for the generated starter, all five twins, as real child
// processes: generate → `--seed` it → the twin SERVES what the file declares.
//
//     pome twin seed <twin> --out seed.json
//     pome twin start --seed seed.json          <- name omitted on purpose
//     GET /s/standalone/_pome/state             <- read back
//
// The `<name>` argument is left off deliberately: a generated file is a one-twin
// envelope, so it already says which twin it is for, and that is the path a
// reader who copied the two commands out of the docs actually takes.
//
// WHAT THE ASSERTION IS PULLED FROM. Every expected value is read out of the
// GENERATED FILE, never typed here. A hard-coded `acme/api` would turn any
// change to a twin's declared starting state into a red test in the CLI suite,
// which is the wrong place to notice it — and it would let the generator and the
// expectation drift apart in exactly the way the docs examples drifted.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTsxBin } from "../../scripts/lib/resolve-tsx.js";
import { TWIN_NAME_LIST, type TwinName } from "../../src/twin/registry.js";

const CLI_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_BIN = resolveTsxBin(import.meta.url);
const MAIN_TS = join(CLI_ROOT, "src", "cli", "main.ts");

/** Distinctive strings the generated seed DECLARES, which the twin's own
 *  `/_pome/state` must therefore report. Read from the file, per twin, because
 *  each twin exports a different vocabulary.
 *
 *  stripe is the one twin whose default seed declares nothing `/_pome/state`
 *  exports — it declares an API key, and the state export is deliberately
 *  credential-free. Its arm returns no strings and the test falls through to the
 *  credential probe below, which is the only observable form "the seed landed"
 *  takes for that twin. */
const DECLARED: Record<TwinName, (seed: never) => string[]> = {
  github: (seed: { repositories: { owner: string; name: string }[] }) =>
    seed.repositories.map((repo) => `${repo.owner}/${repo.name}`),
  slack: (seed: { channels: { name: string }[] }) => seed.channels.map((c) => c.name),
  stripe: () => [],
  gmail: (seed: { primaryMailbox: { email: string } }) => [seed.primaryMailbox.email],
  linear: (seed: { organization: { urlKey: string }; teams: { key: string }[] }) => [
    seed.organization.urlKey,
    ...seed.teams.map((team) => team.key),
  ],
};

async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address() as { port: number };
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function runCli(args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  const proc = spawn(TSX_BIN, [MAIN_TS, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout?.on("data", (chunk) => { output += chunk; });
  proc.stderr?.on("data", (chunk) => { output += chunk; });
  return new Promise((resolve) =>
    proc.once("exit", (code) => resolve({ code, output })),
  );
}

let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
});

describe("pome twin seed → pome twin start --seed (e2e)", () => {
  it.each(TWIN_NAME_LIST)(
    "%s: the generated seed boots, and the twin serves what it declares",
    async (twin) => {
      const cwd = await mkdtemp(join(tmpdir(), `pome-seed-roundtrip-${twin}-`));
      const seedPath = join(cwd, "seed.json");

      const generated = await runCli(["twin", "seed", twin, "--out", seedPath], cwd);
      expect(generated.code, generated.output).toBe(0);

      const file = JSON.parse(await readFile(seedPath, "utf8")) as Record<string, unknown>;
      // One twin, one envelope key: the shape the reader is told to write.
      expect(Object.keys(file)).toEqual([twin]);
      const declared = DECLARED[twin](file[twin] as never);

      const port = await freePort();
      // No `<name>`: the envelope names exactly one twin, so the file supplies it.
      child = spawn(
        TSX_BIN,
        [MAIN_TS, "twin", "start", "--port", String(port), "--seed", seedPath],
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
          throw new Error(`twin start never answered /healthz 200\n--- output ---\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const tokenDeadline = Date.now() + 5_000;
      while (!/POME_AUTH_TOKEN=/.test(output) && Date.now() < tokenDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const token = output.match(/POME_AUTH_TOKEN=(\S+)/)?.[1];
      expect(token, output).toBeTruthy();

      // The boot line names the file and says what seeding does to the default.
      expect(output).toContain(`Seed: ${seedPath} (replaces the ${twin} twin's default).`);

      const state = await fetch(`${base}/s/standalone/_pome/state`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(state.status).toBe(200);
      const served = JSON.stringify(await state.json());
      for (const value of declared) expect(served).toContain(value);

      if (twin === "stripe") {
        // The credential the seed declares is recognised; one it does not
        // declare is not. 401 is "no such credential" — the seeded key gets past
        // that, an invented one does not, and that difference is the only place
        // stripe's seeded `api_keys` is observable from outside the twin.
        const declaredKey = (file.stripe as { api_keys: { key: string }[] }).api_keys[0]!.key;
        const withSeeded = await fetch(`${base}/s/standalone/v1/customers`, {
          headers: { Authorization: `Bearer ${declaredKey}` },
        });
        const withInvented = await fetch(`${base}/s/standalone/v1/customers`, {
          headers: { Authorization: "Bearer sk_test_not_in_the_seed" },
        });
        expect(withInvented.status).toBe(401);
        expect(withSeeded.status).not.toBe(401);
      }
    },
    120_000,
  );

  it(
    "refuses to overwrite a seed file that already exists",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "pome-seed-overwrite-"));
      const seedPath = join(cwd, "seed.json");
      const first = await runCli(["twin", "seed", "stripe", "--out", seedPath], cwd);
      expect(first.code).toBe(0);
      const second = await runCli(["twin", "seed", "github", "--out", seedPath], cwd);
      expect(second.code).not.toBe(0);
      expect(second.output).toContain("already exists");
      // The stripe seed is still there, unedited.
      const kept = JSON.parse(await readFile(seedPath, "utf8")) as Record<string, unknown>;
      expect(Object.keys(kept)).toEqual(["stripe"]);
    },
    120_000,
  );
});
