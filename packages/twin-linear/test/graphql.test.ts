// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAR_TOKEN,
  createLinearTwinApp,
  openLinearTwinDatabase,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

const SECRET = "linear-graphql-test-secret-32chars!";

function fixture() {
  process.env.TWIN_AUTH_SECRET = SECRET;
  const db = openLinearTwinDatabase(":memory:");
  const app = createLinearTwinApp({ db, seed: testSeed(), runId: "graphql-test" });
  return { app, db };
}

async function graphql(app: ReturnType<typeof createLinearTwinApp>, query: string, variables?: Record<string, unknown>) {
  const response = await app.request("/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEFAULT_LINEAR_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message: string }>;
    },
  };
}

describe("Linear GraphQL surface", () => {
  it("returns viewer for the seeded admin token", async () => {
    const { app } = fixture();
    const { status, body } = await graphql(
      app,
      `query { viewer { id email name admin } }`
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data?.viewer).toMatchObject({
      email: "admin@pome-twin.test",
      admin: true,
    });
  });

  it("lists seeded issues", async () => {
    const { app } = fixture();
    const { status, body } = await graphql(
      app,
      `query { issues(first: 10) { nodes { id identifier title } } }`
    );
    expect(status).toBe(200);
    const nodes = (body.data?.issues as { nodes: Array<{ identifier: string }> }).nodes;
    expect(nodes.length).toBeGreaterThanOrEqual(4);
    expect(nodes.map((n) => n.identifier).every((id) => /^ENG-\d+$/.test(id))).toBe(true);
  });

  it("creates an issue via issueCreate", async () => {
    const { app } = fixture();
    const { status, body } = await graphql(
      app,
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title team { key } }
        }
      }`,
      { input: { teamId: "team_eng", title: "GraphQL created issue" } }
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const payload = body.data?.issueCreate as {
      success: boolean;
      issue: { identifier: string; title: string; team: { key: string } };
    };
    expect(payload.success).toBe(true);
    expect(payload.issue.title).toBe("GraphQL created issue");
    expect(payload.issue.team.key).toBe("ENG");
    expect(payload.issue.identifier).toMatch(/^ENG-\d+$/);
  });
});
