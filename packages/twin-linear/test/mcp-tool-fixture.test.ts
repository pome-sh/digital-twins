// SPDX-License-Identifier: Apache-2.0
// The fixture is the tool table, not a document about it.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveCanonicalMcpToolListing, diffServedToolsAgainstFixture } from "@pome-sh/sdk";
import { createLinearTwinApp, defaultSeedState, linearToolFixture } from "../src/index.js";

const secret = "linear-fixture-test-secret-32-characters";
const sid = "linear-fixture-session";
const previousSecret = process.env.TWIN_AUTH_SECRET;
const fixtures = join(import.meta.dirname, "..", "fixtures");
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = secret;
  token = await sign(
    {
      sid,
      team_id: "tm_linear",
      linear_email: "pome-agent@pome-twin.test",
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
  const app = createLinearTwinApp({ seed: defaultSeedState() });
  const response = await app.request(`/s/${sid}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result?: { tools?: unknown } };
  return body.result?.tools;
}

describe("linear MCP tool fixture", () => {
  const meta = linearToolFixture.meta;

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

  it("declares a substrate that names the capture it projects, and proves it by digest", () => {
    // Was `twin-authored-from-vendor-docs`, and that test asserted the admission —
    // `comparedToUpstream: never`, `contentOrigin: documentation`.
    expect(meta.substrate).toBe("upstream-capture-projection");
    expect(meta.transcription).toBeUndefined();
    expect(meta.liveToolCount).toBe(22);

    // The digest is the claim: only `projection.sourceRawFileSha256` proves WHAT
    // this was derived from — a stale golden would re-hash clean without it.
    const upstreamRaw = read(join("..", "..", "..", "fixtures", "mcp-tools-list", "linear.raw.json"));
    expect(meta.projection?.sourceRawFileSha256).toBe(sha256(upstreamRaw));
    expect(meta.projection?.sourceFixture).toBe("fixtures/mcp-tools-list/linear.raw.json");
    expect(meta.projection?.sourceSubstrate).toBe("live-wire-oauth");

    // No `sourceCommit` here, and its absence is a fact rather than an omission:
    // github's golden is built from OSS source and pins the commit it was built
    // at, while Linear's is a live HTTP capture of a server nobody outside Linear
    // can build. The capture DATE is the whole provenance available, so the two
    // files must at least agree on it.
    const upstreamMeta = JSON.parse(
      read(join("..", "..", "..", "fixtures", "mcp-tools-list", "linear.meta.json")),
    ) as { captureDate: string; source?: unknown };
    expect(upstreamMeta.source).toBeUndefined();
    expect(meta.projection?.sourceCaptureDate).toBe(upstreamMeta.captureDate);
    expect(meta.captureDate).toBe(upstreamMeta.captureDate);
  });

  // The residue, named on the file rather than only in the producer. Thirty-six
  // tools Linear declares and this twin does not model, and a reason for each,
  // because a name with no reason is a suppression.
  it("enumerates every row the capture has and this twin does not, with a reason", () => {
    const dropped = meta.projection?.dropped ?? {};
    expect(Object.keys(dropped)).toHaveLength(36);
    for (const [name, reason] of Object.entries(dropped)) {
      expect(reason.length, name).toBeGreaterThan(40);
      expect(reason, name).toMatch(/out of modeled scope/);
    }

    // EMPTY, and that is the strong form of the projection rather than an oversight:
    // every row this twin serves is the capture's.
    expect(meta.projection?.carried).toEqual({});
  });

  it("is a STRICT SUBSET of the capture, so the two files stay byte-different", () => {
    // Pure subtraction is the property the producer is allowed to have and the
    // one that makes `upstream-capture-projection` an honest word. If the twin
    // ever advertised a name the capture does not carry, this fails here rather
    // than in pome-cloud's lane a day later.
    const upstream = JSON.parse(
      read(join("..", "..", "..", "fixtures", "mcp-tools-list", "linear.raw.json")),
    ) as { result: { tools: Array<{ name: string }> } };
    const upstreamNames = upstream.result.tools.map((tool) => tool.name);
    const served = [...linearToolFixture.toolNames];

    expect(upstreamNames).toHaveLength(58);
    expect(served.filter((name) => !upstreamNames.includes(name))).toEqual([]);
    expect(served.length).toBeLessThan(upstreamNames.length);
    // ORDER is the capture's too — a projection that re-sorted would be editing.
    expect(served).toEqual(upstreamNames.filter((name) => served.includes(name)));
  });

  it("advertises Linear's schemas, not a projection of the twin's own validators", () => {
    // The defect this fixture existed to make invisible: every inputSchema used
    // to be ours, so the MCP lane compared the twin against itself and every one
    // of the 22 compared tools diverged. Linear declares no `outputSchema` on any
    // tool, so a row carrying one is this twin having authored a schema again.
    const tools = JSON.parse(read(meta.files.raw)) as {
      result: { tools: Array<{ name: string; outputSchema?: unknown; description?: string }> };
    };
    expect(tools.result.tools.filter((tool) => tool.outputSchema !== undefined)).toEqual([]);
    for (const tool of tools.result.tools) {
      expect(tool.description, tool.name).toBeTruthy();
    }
  });

  it("serves exactly the fixture's listing over tools/list", async () => {
    expect(diffServedToolsAgainstFixture(await servedTools(), linearToolFixture)).toEqual([]);
  });

  it("binds fidelity.inventory.json's tools 1:1 to the fixture", () => {
    const inventory = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "fidelity.inventory.json"), "utf8")
    ) as { tools: Array<{ name: string }> };
    expect(inventory.tools.map((tool) => tool.name).sort()).toEqual(
      [...linearToolFixture.toolNames].sort()
    );
  });
});
