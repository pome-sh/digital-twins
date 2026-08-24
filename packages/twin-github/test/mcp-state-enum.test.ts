// SPDX-License-Identifier: Apache-2.0
// `list_issues.state` takes GitHub's spelling, and the fold that makes it work.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGitHubCloneApp } from "../src/twin.js";
import { toolArgumentSchemas } from "../src/tools.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const OPEN_ISSUE = 1;
const CLOSED_ISSUE = 2;

/** A world with BOTH states present. The default seed has no closed issue, so every
 *  assertion below would pass on it vacuously — "closed returns nothing". */
const WORLD = {
  repositories: [
    {
      owner: "acme",
      name: "api",
      issues: [
        { number: OPEN_ISSUE, title: "Seeded bug", state: "open" as const },
        { number: CLOSED_ISSUE, title: "Seeded and shipped", state: "closed" as const },
      ],
    },
  ],
};

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;

async function callRaw(app: ReturnType<typeof createGitHubCloneApp>, tool: string, args: unknown) {
  return app.request(
    `${base}/mcp/call`,
    withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, arguments: args }),
    }),
  );
}

async function call(app: ReturnType<typeof createGitHubCloneApp>, tool: string, args: unknown) {
  const response = await callRaw(app, tool, args);
  if (!response.ok) throw new Error(`${tool}: ${response.status} ${await response.text()}`);
  return (await response.json()) as any;
}

describe("list_issues.state — GitHub's spelling, and the fold behind it", () => {
  const numbers = (rows: Array<{ number: number }>) => rows.map((r) => r.number).sort((a, b) => a - b);

  it("state: 'OPEN' returns the OPEN issue — the fold is real, not cosmetic", async () => {
    const app = createGitHubCloneApp({ seed: WORLD as never });
    const upper = await call(app, "list_issues", { owner: "acme", repo: "api", state: "OPEN" });
    // NOT an empty array. A missing `toLowerCase()` at the MCP boundary makes
    // this `[]` — silently, with a 200 — and nothing else in the suite notices.
    expect(numbers(upper)).toEqual([OPEN_ISSUE]);
  });

  it("state: 'CLOSED' returns the CLOSED issue — the fold filters, it does not pass everything", async () => {
    // The other half. A `toLowerCase()` that ran and a filter that was skipped
    // entirely both return rows; only asking for the OTHER state separates them.
    const app = createGitHubCloneApp({ seed: WORLD as never });
    const closed = await call(app, "list_issues", { owner: "acme", repo: "api", state: "CLOSED" });
    expect(numbers(closed)).toEqual([CLOSED_ISSUE]);
  });

  it("an ABSENT state returns BOTH here, and only open over REST", async () => {
    // GitHub's two doors disagree about the absent case and the twin follows each.
    const app = createGitHubCloneApp({ seed: WORLD as never });
    const viaMcp = await call(app, "list_issues", { owner: "acme", repo: "api" });
    expect(numbers(viaMcp)).toEqual([OPEN_ISSUE, CLOSED_ISSUE]);

    const viaRest = await app.request(`${base}/repos/acme/api/issues`, withAuth(token));
    expect(viaRest.status).toBe(200);
    expect(numbers((await viaRest.json()) as Array<{ number: number }>)).toEqual([OPEN_ISSUE]);
  });

  it("state: 'open' is REFUSED — the twin no longer accepts a spelling GitHub does not declare", async () => {
    const app = createGitHubCloneApp({ seed: WORLD as never });
    const response = await callRaw(app, "list_issues", { owner: "acme", repo: "api", state: "open" });
    expect(response.ok).toBe(false);
    // Loudly, and naming the argument. A silent coercion back to lowercase would
    // make the twin accept a call GitHub refuses, which is the false PASS this
    // change exists to remove.
    expect((await response.text()).toLowerCase()).toContain("state");
  });

  // ── THE INCONSISTENCY IS GITHUB'S, AND DELIBERATE HERE ────────────────────
  // ⚠️ DO NOT "UNIFY" THESE TWO ENUMS: GitHub spells `state` differently on the
  // two tools, so unifying invents a divergence. This reads the capture, not prose.
  it("list_issues and list_pull_requests disagree on casing BECAUSE GitHub does", () => {
    const golden = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "..", "fixtures", "mcp-tools-list", "github.raw.json"),
        "utf8",
      ),
    ) as { result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, { enum?: string[] }> } }> } };
    const enumOf = (tool: string) =>
      golden.result.tools.find((t) => t.name === tool)?.inputSchema.properties?.state?.enum;

    // THREE spellings on one vendor, not two. `issue_write` was found by the parity
    // harness during the own migration, which is the argument for reading the capture.
    expect(enumOf("list_issues")).toEqual(["OPEN", "CLOSED"]);
    expect(enumOf("list_pull_requests")).toEqual(["open", "closed", "all"]);
    expect(enumOf("issue_write")).toEqual(["open", "closed"]);

    // And the twin follows each one, which is the point: `list_pull_requests` was
    // deliberately NOT tightened, because it was already right.
    const schemaOf = (tool: string) => toolArgumentSchemas.find((t) => t.name === tool)!.schema;
    const issues = schemaOf("list_issues");
    expect(issues.safeParse({ owner: "o", repo: "r", state: "OPEN" }).success).toBe(true);
    expect(issues.safeParse({ owner: "o", repo: "r", state: "open" }).success).toBe(false);
    const pulls = schemaOf("list_pull_requests");
    expect(pulls.safeParse({ owner: "o", repo: "r", state: "open" }).success).toBe(true);
    expect(pulls.safeParse({ owner: "o", repo: "r", state: "OPEN" }).success).toBe(false);
    const write = schemaOf("issue_write");
    expect(write.safeParse({ method: "update", owner: "o", repo: "r", issue_number: 1, state: "open" }).success).toBe(true);
    expect(write.safeParse({ method: "update", owner: "o", repo: "r", issue_number: 1, state: "OPEN" }).success).toBe(false);
  });
});
