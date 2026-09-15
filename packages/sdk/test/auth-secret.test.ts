// SPDX-License-Identifier: Apache-2.0
// Moved from packages/twin-slack/test: the secret-resolution mechanism is the
// engine's, so its unit coverage lives with the engine.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEV_ONLY_INSECURE_SECRET, resolveAuthSecret } from "../src/auth.js";
import { TwinBootError, ensureTwinAuthSecret } from "../src/server.js";

describe("resolveAuthSecret", () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSecret = process.env.TWIN_AUTH_SECRET;
  const prevOptIn = process.env.POME_ALLOW_DEV_SECRETS;

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
    else process.env.TWIN_AUTH_SECRET = prevSecret;
    if (prevOptIn === undefined) delete process.env.POME_ALLOW_DEV_SECRETS;
    else process.env.POME_ALLOW_DEV_SECRETS = prevOptIn;
  });

  it("throws when the secret is missing, whatever NODE_ENV says (F-1801)", () => {
    delete process.env.TWIN_AUTH_SECRET;
    delete process.env.POME_ALLOW_DEV_SECRETS;
    for (const nodeEnv of [undefined, "production", "staging", "test"]) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      expect(() => resolveAuthSecret()).toThrow(/TWIN_AUTH_SECRET is not set/);
    }
  });

  it("serves the public dev secret only under the exact POME_ALLOW_DEV_SECRETS=1 opt-in", () => {
    delete process.env.TWIN_AUTH_SECRET;
    delete process.env.NODE_ENV;
    process.env.POME_ALLOW_DEV_SECRETS = "1";
    expect(resolveAuthSecret()).toBe(DEV_ONLY_INSECURE_SECRET);
    process.env.POME_ALLOW_DEV_SECRETS = "true";
    expect(() => resolveAuthSecret()).toThrow(/TWIN_AUTH_SECRET is not set/);
  });

  it("an env-injected secret wins over the opt-in", () => {
    process.env.TWIN_AUTH_SECRET = "cloud-injected-per-tenant-secret-123456";
    process.env.POME_ALLOW_DEV_SECRETS = "1";
    expect(resolveAuthSecret()).toBe("cloud-injected-per-tenant-secret-123456");
  });
});

// A twin bound to a non-loopback host with no env-injected secret self-generates one,
// persists it at the compose-era contract location (.pome-data/<twin>/secret.
describe("ensureTwinAuthSecret", () => {
  const HEX_64 = /^[0-9a-f]{64}$/;
  const prevSecret = process.env.TWIN_AUTH_SECRET;
  const prevDataDir = process.env.POME_TWIN_DATA_DIR;
  let dataDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const secretFile = () => join(dataDir, "secret");
  const logged = () => logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
  const readSecretFile = () => readFileSync(secretFile(), "utf8");
  const fileExists = () => {
    try {
      statSync(secretFile());
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "pome-sdk-secret-"));
    process.env.POME_TWIN_DATA_DIR = dataDir;
    delete process.env.TWIN_AUTH_SECRET;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
    if (prevSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
    else process.env.TWIN_AUTH_SECRET = prevSecret;
    if (prevDataDir === undefined) delete process.env.POME_TWIN_DATA_DIR;
    else process.env.POME_TWIN_DATA_DIR = prevDataDir;
  });

  it("env-injected secret always wins: no file is read or written", () => {
    process.env.TWIN_AUTH_SECRET = "cloud-injected-per-tenant-secret-123456";
    ensureTwinAuthSecret("github", "0.0.0.0");
    expect(process.env.TWIN_AUTH_SECRET).toBe("cloud-injected-per-tenant-secret-123456");
    expect(fileExists()).toBe(false);
  });

  it("loopback bind with no env: a per-process secret, printed once, never persisted (F-1801)", () => {
    delete process.env.POME_ALLOW_DEV_SECRETS;
    ensureTwinAuthSecret("github", "127.0.0.1");
    const secret = process.env.TWIN_AUTH_SECRET ?? "";
    expect(secret).toMatch(HEX_64);
    expect(fileExists()).toBe(false);
    expect(logged()).toContain(secret);
  });

  it("loopback bind under POME_ALLOW_DEV_SECRETS=1: nothing generated, the engine serves the dev secret", () => {
    process.env.POME_ALLOW_DEV_SECRETS = "1";
    try {
      ensureTwinAuthSecret("github", "127.0.0.1");
      expect(process.env.TWIN_AUTH_SECRET).toBeUndefined();
      expect(fileExists()).toBe(false);
    } finally {
      delete process.env.POME_ALLOW_DEV_SECRETS;
    }
  });

  it("non-loopback bind with no env: generates 32-byte hex, persists, sets env, prints once", () => {
    ensureTwinAuthSecret("github", "0.0.0.0");
    const secret = process.env.TWIN_AUTH_SECRET ?? "";
    expect(secret).toMatch(HEX_64);
    // Compose-era file format: the secret plus a trailing newline.
    expect(readSecretFile()).toBe(`${secret}\n`);
    // Owner-only: the CLI reads it as the same user; nobody else needs to.
    expect(statSync(secretFile()).mode & 0o777).toBe(0o600);
    expect(logged()).toContain(secret);
    expect(logged()).toContain("TWIN_AUTH_SECRET");
  });

  it("empty env string counts as unset (compose entrypoint parity)", () => {
    process.env.TWIN_AUTH_SECRET = "";
    ensureTwinAuthSecret("slack", "0.0.0.0");
    expect(process.env.TWIN_AUTH_SECRET).toMatch(HEX_64);
  });

  it("second boot reuses the persisted secret without regenerating or reprinting it", () => {
    ensureTwinAuthSecret("github", "0.0.0.0");
    const first = process.env.TWIN_AUTH_SECRET ?? "";
    delete process.env.TWIN_AUTH_SECRET;
    logSpy.mockClear();

    ensureTwinAuthSecret("github", "0.0.0.0");
    expect(process.env.TWIN_AUTH_SECRET).toBe(first);
    expect(readSecretFile()).toBe(`${first}\n`);
    expect(logged()).not.toContain(first);
  });

  it("reads a compose-era secret file (trailing newline) verbatim after trimming", () => {
    const composeSecret = "a".repeat(64);
    writeFileSync(secretFile(), `${composeSecret}\n`);
    ensureTwinAuthSecret("stripe", "0.0.0.0");
    expect(process.env.TWIN_AUTH_SECRET).toBe(composeSecret);
    expect(readSecretFile()).toBe(`${composeSecret}\n`);
  });

  it("refuses to boot on a persisted secret shorter than 32 chars instead of serving a weak key", () => {
    writeFileSync(secretFile(), "x\n");
    expect(() => ensureTwinAuthSecret("github", "0.0.0.0")).toThrow(TwinBootError);
    expect(() => ensureTwinAuthSecret("github", "0.0.0.0")).toThrow(/TWIN_AUTH_SECRET/);
    expect(process.env.TWIN_AUTH_SECRET).toBeUndefined();
    // The operator's file is not silently regenerated either.
    expect(readSecretFile()).toBe("x\n");
  });

  it("accepts a hand-placed persisted secret of at least 32 chars", () => {
    const custom = "hand-placed-secret-32-chars-minimum!";
    writeFileSync(secretFile(), `${custom}\n`);
    ensureTwinAuthSecret("github", "0.0.0.0");
    expect(process.env.TWIN_AUTH_SECRET).toBe(custom);
  });

  it("treats a whitespace-only persisted file as absent and regenerates", () => {
    writeFileSync(secretFile(), " \n");
    ensureTwinAuthSecret("github", "0.0.0.0");
    expect(process.env.TWIN_AUTH_SECRET).toMatch(HEX_64);
  });

  it("defaults to .pome-data/<twin>/secret relative to cwd when POME_TWIN_DATA_DIR is unset", () => {
    delete process.env.POME_TWIN_DATA_DIR;
    const cwd = process.cwd();
    try {
      process.chdir(dataDir);
      ensureTwinAuthSecret("github", "0.0.0.0");
      const secret = process.env.TWIN_AUTH_SECRET ?? "";
      expect(secret).toMatch(HEX_64);
      expect(readFileSync(join(dataDir, ".pome-data", "github", "secret"), "utf8")).toBe(`${secret}\n`);
    } finally {
      process.chdir(cwd);
    }
  });

  it("fails boot with TwinBootError naming TWIN_AUTH_SECRET when the data dir is unwritable", () => {
    const blocker = join(dataDir, "blocker");
    writeFileSync(blocker, "not a directory");
    process.env.POME_TWIN_DATA_DIR = join(blocker, "nested");
    expect(() => ensureTwinAuthSecret("github", "0.0.0.0")).toThrow(TwinBootError);
    expect(() => ensureTwinAuthSecret("github", "0.0.0.0")).toThrow(/TWIN_AUTH_SECRET/);
  });
});
