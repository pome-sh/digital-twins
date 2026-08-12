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
import { deriveCanonicalMcpToolListing, diffServedToolsAgainstFixture } from "@pome-sh/sdk";
import { createGitHubCloneApp } from "../src/twin.js";
import { defaultSeedState } from "../src/seed.js";
import { githubToolFixture, githubToolInputSchema, toolArgumentSchemas } from "../src/tools.js";

const secret = "github-fixture-test-secret-32-characters";
const sid = "github-fixture-session";
const previousSecret = process.env.TWIN_AUTH_SECRET;
const fixtures = join(import.meta.dirname, "..", "fixtures");
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = secret;
  token = await sign(
    { sid, team_id: "tm_github", login: "pome-agent", exp: Math.floor(Date.now() / 1000) + 3600 },
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
  const app = createGitHubCloneApp({ seed: defaultSeedState() });
  const response = await app.request(`/s/${sid}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await response.json()) as { result?: { tools?: unknown } };
  return body.result?.tools;
}

describe("github MCP tool fixture", () => {
  const meta = githubToolFixture.meta;

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
    // Was `twin-code-transcription` until F-1468, when these rows stopped being
    // ours. The word had to move with them: a reader who saw `transcription`
    // over GitHub's own descriptions and annotations would go looking for a
    // capture problem behind a file that no longer has one.
    expect(meta.substrate).toBe("upstream-capture-projection");
    expect(meta.transcription).toBeUndefined();
    expect(meta.liveToolCount).toBe(36);

    // The digest is the claim. `rawFileSha256` proves this file has not been
    // hand-edited since it was derived; only `projection.sourceRawFileSha256`
    // proves WHAT it was derived from, and re-pointing the producer at a stale
    // or hand-edited golden would re-hash clean without it.
    const upstreamRaw = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list", "github.raw.json"),
      "utf8",
    );
    expect(meta.projection?.sourceRawFileSha256).toBe(
      createHash("sha256").update(upstreamRaw, "utf8").digest("hex"),
    );
    expect(meta.projection?.sourceFixture).toBe("fixtures/mcp-tools-list/github.raw.json");
    expect(meta.projection?.sourceSubstrate).toBe("oss-source");
    // Not "a commit": the one the golden pins, so the two files cannot drift
    // into describing different builds of the same server.
    const upstreamMeta = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list", "github.meta.json"),
        "utf8",
      ),
    ) as { source: { commit: string }; captureDate: string };
    expect(meta.projection?.sourceCommit).toBe(upstreamMeta.source.commit);
    expect(meta.captureDate).toBe(upstreamMeta.captureDate);
  });

  // The residue, named on the file rather than only in the producer. Ten tools
  // GitHub declares and this twin does not model, two it serves that a flags-off
  // capture cannot carry — and a reason for each, because a name with no reason
  // is a suppression.
  it("enumerates every row that is not the capture's, with a reason", () => {
    const dropped = meta.projection?.dropped ?? {};
    const carried = meta.projection?.carried ?? {};
    expect(Object.keys(dropped).sort()).toEqual([
      "add_comment_to_pending_review",
      "assign_copilot_to_issue",
      "get_label",
      "get_team_members",
      "get_teams",
      "list_issue_fields",
      "list_issue_types",
      "request_copilot_review",
      "search_pull_requests",
      "sub_issue_write",
    ]);
    expect(Object.keys(carried).sort()).toEqual(["create_issue", "create_pull_request_review"]);
    for (const reason of [...Object.values(dropped), ...Object.values(carried)]) {
      expect(reason.length).toBeGreaterThan(40);
    }
    // Two of the ten are a coverage gap and not a scope decision, and they say
    // so in their own reason. Filing them next to `get_teams` unqualified would
    // be a scope ruling covering a defect — the shape the declared lane's
    // `disposition: open-defect` exists to keep apart.
    expect(dropped.get_label).toMatch(/COVERAGE GAP/);
    expect(dropped.search_pull_requests).toMatch(/COVERAGE GAP/);
  });

  // F-1376's arithmetic, pinned where it can be read against the upstream
  // golden in this repo rather than only in pome-cloud's lane.
  it("serves exactly two tools GitHub's captured default surface does not declare", () => {
    const upstream = new Set(
      (JSON.parse(
        readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list", "github.meta.json"), "utf8")
      ) as { liveToolOrder: string[] }).liveToolOrder
    );
    const twinOnly = githubToolFixture.toolNames.filter((name) => !upstream.has(name));
    // Both are real GitHub tools, served from Default:true toolsets behind the
    // client-settable X-MCP-Features flags `issues_granular` and
    // `pull_requests_granular`, and both carry an entry in pome-cloud's
    // known-divergences/github.mcp.yaml. See docs/github-mcp-twin-only-tools.md.
    expect(twinOnly).toEqual(["create_issue", "create_pull_request_review"]);
  });

  // F-1325 — the fixture carries the inputSchema the wire serves, and the zod
  // schemas in tools.ts are what `tools/call` validates against. Nothing keeps
  // the two together except this.
  // The NAME half of the old byte-pin, which survives F-1468 unchanged: a tool
  // in the listing with no handler answers an examinee with a crash, and a
  // handler with no listing row is unreachable. `deriveMcpToolTable` throws on
  // either at module load; this is the round trip that proves it did.
  it("declares a validator for every fixture row, and a row for every validator", () => {
    expect(toolArgumentSchemas.map((tool) => tool.name).sort()).toEqual(
      [...githubToolFixture.toolNames].sort()
    );
  });

  // The SCHEMA half is deliberately gone, and this is the note that says so
  // rather than a deletion a future reader has to reconstruct.
  //
  // It used to assert `githubToolInputSchema(declared.schema)` deep-equals the
  // fixture's `inputSchema`, which held because `regenerate-mcp-tool-fixture.ts`
  // GENERATED the fixture from those same validators. The bytes are GitHub's
  // now, carrying prose, annotations and keyword choices no zod schema
  // projects, so the assertion could only be restored by putting the twin's
  // schemas back on the wire — which is the defect F-1468 fixed.
  //
  // What that pin was buying is real and did not vanish with it: the twin can
  // now advertise one argument surface and accept another. The property moved
  // to `test/mcp-argument-surface.test.ts`, which pins the EXACT residue
  // between GitHub's declared arguments and the validators, so a new gap fails
  // and the 109 known ones are a list somebody has to edit.
  it("advertises GitHub's schemas, not a projection of its own validators", () => {
    const listIssues = githubToolFixture.tools.find((tool) => tool.name === "list_issues");
    const properties = (listIssues?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    // Three things only GitHub's document has. A regression to the old
    // generator would take all three out at once.
    expect(listIssues?.annotations).toBeDefined();
    expect(Object.keys(properties)).toContain("perPage");
    expect((listIssues?.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBeUndefined();
    // And the validator still takes the snake_case alias, which is why swapping
    // the advertised surface broke no caller. Removing the alias is the
    // breaking half and is not this change.
    const schema = toolArgumentSchemas.find((tool) => tool.name === "list_issues")!.schema;
    expect(schema.safeParse({ owner: "o", repo: "r", per_page: 5 }).success).toBe(true);
    expect(schema.safeParse({ owner: "o", repo: "r", perPage: 5 }).success).toBe(true);
  });

  it("serves exactly the fixture's listing over tools/list", async () => {
    expect(diffServedToolsAgainstFixture(await servedTools(), githubToolFixture)).toEqual([]);
  });

  it("binds fidelity.inventory.json's tools 1:1 to the fixture", () => {
    const inventory = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "fidelity.inventory.json"), "utf8")
    ) as { tools: Array<{ name: string }> };
    expect(inventory.tools.map((tool) => tool.name).sort()).toEqual(
      [...githubToolFixture.toolNames].sort()
    );
  });
});
