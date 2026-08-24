// SPDX-License-Identifier: Apache-2.0
//
// Registry-completeness suite. `TWIN_REGISTRY: Record<TwinName, TwinEntry>`
// makes a MISSING entry a compile error, so these tests cover what the type
// system cannot: that each entry's values agree with the frozen surfaces
// outside the CLI — CONTRACT.md's env/port table, the canonical first-party
// twin list in config/, and the twin packages' own manifests.
//
// This replaces the CLI half of the former repo-wide
// `scripts/lint/rules/first-party-twins.mjs` regex lint.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  defaultPortFor,
  isTwinName,
  TWIN_NAME_LIST,
  TWIN_NAMES,
  TWIN_REGISTRY,
  twinVersions,
  type TwinName,
} from "../../../src/twin/registry.js";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

/** CONTRACT.md's documented `pome twin start` port defaults + env overrides. */
const CONTRACT_PORTS: Record<TwinName, { port: number; portEnv?: string }> = {
  github: { port: 3333 },
  slack: { port: 3333 },
  stripe: { port: 3333 },
  gmail: { port: 3336, portEnv: "GMAIL_TWIN_PORT" },
  linear: { port: 3337, portEnv: "LINEAR_TWIN_PORT" },
};

describe("TWIN_REGISTRY completeness", () => {
  it("has an entry for every TwinName, and no extras", () => {
    expect(Object.keys(TWIN_REGISTRY).sort()).toEqual([...TWIN_NAME_LIST].sort());
  });

  it("matches the canonical first-party twin list in config/", () => {
    const canonical = (
      JSON.parse(read("config", "first-party-twins.json")) as { twins: string[] }
    ).twins;
    expect([...TWIN_NAME_LIST].sort()).toEqual([...canonical].sort());
  });

  it("declares a complete entry for each twin", () => {
    for (const name of TWIN_NAME_LIST) {
      const entry = TWIN_REGISTRY[name];
      expect(entry.envName, name).toBe(name.toUpperCase());
      expect(Number.isInteger(entry.defaultPort), name).toBe(true);
      expect(entry.defaultPort, name).toBeGreaterThan(0);
      expect(entry.defaultPort, name).toBeLessThanOrEqual(65535);
      expect(typeof entry.defaultSeed, name).toBe("function");
      expect(typeof entry.boot, name).toBe("function");
    }
  });

  it("derives TWIN_NAMES and isTwinName from the same list", () => {
    expect([...TWIN_NAMES]).toEqual([...TWIN_NAME_LIST]);
    for (const name of TWIN_NAME_LIST) expect(isTwinName(name)).toBe(true);
    expect(isTwinName("bogus")).toBe(false);
    expect(isTwinName("")).toBe(false);
    // Case-sensitive: POME_<ENV>_ prefixes are uppercase, twin IDS are not.
    expect(isTwinName("GitHub")).toBe(false);
  });
});

describe("TWIN_REGISTRY vs the frozen CONTRACT.md env surface", () => {
  it("envName is the uppercase twin id — the POME_<NAME>_{REST,MCP}_URL prefix", () => {
    // The agent-facing env quadruple is frozen product surface; a renamed
    // envName silently unwires every agent.
    const contract = read("CONTRACT.md");
    for (const name of TWIN_NAME_LIST) {
      expect(TWIN_REGISTRY[name].envName).toBe(name.toUpperCase());
    }
    expect(contract).toContain("POME_");
  });

  it("ports and port-override env vars match CONTRACT.md", () => {
    for (const name of TWIN_NAME_LIST) {
      const entry = TWIN_REGISTRY[name];
      expect(entry.defaultPort, name).toBe(CONTRACT_PORTS[name].port);
      expect(entry.portEnvName, name).toBe(CONTRACT_PORTS[name].portEnv);
    }
    // Ports are deliberately NOT unique: CONTRACT.md gives github, slack and
    // stripe the same 3333 default (one twin per container / per `twin start`).
    // Only gmail and linear carry their own documented defaults.
    expect(new Set(TWIN_NAME_LIST.map((n) => TWIN_REGISTRY[n].defaultPort))).toEqual(
      new Set([3333, 3336, 3337]),
    );
  });

  it("declares a token alias only for the twins whose provider SDK needs one", () => {
    const withToken = TWIN_NAME_LIST.filter((n) => TWIN_REGISTRY[n].tokenEnvName);
    expect([...withToken].sort()).toEqual(["gmail", "linear"]);
    expect(TWIN_REGISTRY.gmail.tokenEnvName).toBe("POME_GMAIL_TOKEN");
    expect(TWIN_REGISTRY.linear.tokenEnvName).toBe("POME_LINEAR_TOKEN");
  });
});

describe("defaultPortFor", () => {
  it("PORT wins for every twin", () => {
    for (const name of TWIN_NAME_LIST) {
      expect(defaultPortFor(name, { PORT: "4000", GMAIL_TWIN_PORT: "3336" })).toBe("4000");
    }
  });

  it("honors the twin's own override env var", () => {
    expect(defaultPortFor("gmail", { GMAIL_TWIN_PORT: "3340" })).toBe("3340");
    expect(defaultPortFor("linear", { LINEAR_TWIN_PORT: "3341" })).toBe("3341");
    // A twin without a documented override ignores another twin's.
    expect(defaultPortFor("github", { GMAIL_TWIN_PORT: "3340" })).toBe("3333");
  });

  it("falls back to the CONTRACT.md default", () => {
    expect(defaultPortFor("github", {})).toBe("3333");
    expect(defaultPortFor("slack", {})).toBe("3333");
    expect(defaultPortFor("stripe", {})).toBe("3333");
    expect(defaultPortFor("gmail", {})).toBe("3336");
    expect(defaultPortFor("linear", {})).toBe("3337");
  });
});

describe("twinVersions", () => {
  it("reports every twin's own manifest version", () => {
    const versions = twinVersions();
    expect(Object.keys(versions).sort()).toEqual([...TWIN_NAME_LIST].sort());
    for (const name of TWIN_NAME_LIST) {
      const manifest = JSON.parse(read("packages", `twin-${name}`, "package.json")) as {
        version: string;
      };
      expect(versions[name], name).toBe(manifest.version);
    }
  });
});
