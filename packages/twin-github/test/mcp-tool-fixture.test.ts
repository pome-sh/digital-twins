// SPDX-License-Identifier: Apache-2.0
// The fixture is the tool table, not a document about it.

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
    // Was `twin-code-transcription` until these rows stopped being ours.
    expect(meta.substrate).toBe("upstream-capture-projection");
    expect(meta.transcription).toBeUndefined();
    expect(meta.liveToolCount).toBe(36);

    // The digest is the claim: only `projection.sourceRawFileSha256` proves WHAT
    // this was derived from — a stale golden would re-hash clean without it.
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

  // the arithmetic, pinned where it can be read against the upstream
  // golden in this repo rather than only in pome-cloud's lane.
  it("serves exactly two tools GitHub's captured default surface does not declare", () => {
    const upstream = new Set(
      (JSON.parse(
        readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list", "github.meta.json"), "utf8")
      ) as { liveToolOrder: string[] }).liveToolOrder
    );
    const twinOnly = githubToolFixture.toolNames.filter((name) => !upstream.has(name));
    // Both are real GitHub tools behind the `issues_granular` /
    // `pull_requests_granular` feature flags. See docs/github-mcp-twin-only-tools.md.
    expect(twinOnly).toEqual(["create_issue", "create_pull_request_review"]);
  });

  // The fixture carries the inputSchema the wire serves, and the zod schemas in
  // tools.ts are what `tools/call` validates against.
  it("declares a validator for every fixture row, and a row for every validator", () => {
    expect(toolArgumentSchemas.map((tool) => tool.name).sort()).toEqual(
      [...githubToolFixture.toolNames].sort()
    );
  });

  // The SCHEMA half is deliberately gone, and this is the note that says so rather
  // than a deletion a future reader has to reconstruct.
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
