// SPDX-License-Identifier: Apache-2.0
//
// F-1325 — the fixture is the tool table, not a document about it.
//
// The derivation is structural (`deriveMcpToolTable` throws on any 1:1
// mismatch), but "structurally impossible" is a claim worth one round trip:
// this suite drives the real `tools/list` surface and compares the answer to
// the fixture field by field. It also re-derives the canonical bytes and
// re-hashes the raw file from disk, which is the half of the load-time assert
// a bundled twin cannot make for itself.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deriveCanonicalMcpToolListing,
  diffServedToolsAgainstFixture,
} from "@pome-sh/sdk";
import { createGmailTwinApp, defaultSeedState, gmailToolFixture } from "../src/index.js";

const secret = "gmail-fixture-test-secret-32-characters";
const sid = "gmail-fixture-session";
const previousSecret = process.env.TWIN_AUTH_SECRET;
const fixtures = join(import.meta.dirname, "..", "fixtures");
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = secret;
  token = await sign(
    {
      sid,
      team_id: "tm_gmail",
      gmail_email: "pome-agent@pome-twin.test",
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret
  );
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

function read(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function servedTools(): Promise<unknown> {
  const app = createGmailTwinApp({ seed: defaultSeedState() });
  const response = await app.request(`/s/${sid}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result?: { tools?: unknown } };
  return body.result?.tools;
}

describe("gmail MCP tool fixture", () => {
  const meta = gmailToolFixture.meta;

  it("hashes the raw listing on disk to the sha its provenance declares", () => {
    expect(sha256(read(meta.files.raw))).toBe(meta.rawFileSha256);
  });

  it("re-derives the canonical listing byte for byte", () => {
    const derived = deriveCanonicalMcpToolListing({
      raw: JSON.parse(read(meta.files.raw)),
      meta: JSON.parse(read("mcp-tools-list.meta.json")),
    });
    expect(read(meta.files.canonical)).toBe(derived);
    expect(sha256(read(meta.files.canonical))).toBe(meta.canonicalFileSha256);
  });

  it("declares a substrate that says where the listing came from", () => {
    expect(meta.substrate).toBe("live-wire-unauth");
    expect(meta.configuration).toBeDefined();
    expect(meta.endpoint).toBe("https://gmailmcp.googleapis.com/mcp/v1");
  });

  it("serves exactly the fixture's listing over tools/list", async () => {
    expect(diffServedToolsAgainstFixture(await servedTools(), gmailToolFixture)).toEqual([]);
  });

  it("binds fidelity.inventory.json's tools 1:1 to the fixture", () => {
    const inventory = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "fidelity.inventory.json"), "utf8")
    ) as { tools: Array<{ name: string }> };
    expect(inventory.tools.map((tool) => tool.name).sort()).toEqual(
      [...gmailToolFixture.toolNames].sort()
    );
  });
});
