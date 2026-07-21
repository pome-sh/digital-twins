// SPDX-License-Identifier: Apache-2.0
/**
 * Official @linear/sdk smoke against an in-process twin.
 *
 * High-level SDK helpers (createIssue/updateIssue) request a large Issue
 * fragment the twin does not fully emulate. We still bind LinearClient to the
 * twin GraphQL URL and exercise create/update/comment via the SDK's raw
 * GraphQL client with twin-supported selections.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { LinearClient } from "@linear/sdk";
import { DEFAULT_LINEAR_TOKEN, createLinearTwinApp, openLinearTwinDatabase } from "../src/index.js";
import { testSeed } from "./_helpers.js";

const SECRET = "linear-official-client-secret-32!!";
let server: Server;
let apiUrl: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = SECRET;
  const db = openLinearTwinDatabase(":memory:");
  const app = createLinearTwinApp({ db, seed: testSeed(), runId: "official-client" });
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${address.port}/graphql`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

describe("pinned @linear/sdk smoke", () => {
  it(
    "uses LinearClient against the twin for create/update/comment",
    async () => {
      const client = new LinearClient({
        apiKey: DEFAULT_LINEAR_TOKEN,
        apiUrl,
      });

      const viewer = await client.client.rawRequest<
        { viewer: { email: string } },
        Record<string, never>
      >(`query { viewer { email } }`);
      expect(viewer.data?.viewer.email).toBe("admin@pome-twin.test");

      const created = await client.client.rawRequest<
        {
          issueCreate: { success: boolean; issue: { id: string; identifier: string; title: string } };
        },
        { input: Record<string, unknown> }
      >(
        `mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id identifier title }
          }
        }`,
        { input: { teamId: "team_eng", title: "Official SDK issue", description: "via rawRequest" } }
      );
      expect(created.data?.issueCreate.success).toBe(true);
      const issue = created.data!.issueCreate.issue;
      expect(issue.identifier).toMatch(/^ENG-\d+$/);

      const updated = await client.client.rawRequest<
        { issueUpdate: { success: boolean; issue: { id: string; title: string } } },
        { id: string; input: Record<string, unknown> }
      >(
        `mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue { id title }
          }
        }`,
        { id: issue.id, input: { title: "Official SDK issue updated" } }
      );
      expect(updated.data?.issueUpdate.success).toBe(true);
      expect(updated.data?.issueUpdate.issue.title).toBe("Official SDK issue updated");

      const commented = await client.client.rawRequest<
        {
          commentCreate: {
            success: boolean;
            comment: { id: string; body: string; issue: { id: string } };
          };
        },
        { input: Record<string, unknown> }
      >(
        `mutation($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment { id body issue { id } }
          }
        }`,
        { input: { issueId: issue.id, body: "Official client comment" } }
      );
      expect(commented.data?.commentCreate.success).toBe(true);
      expect(commented.data?.commentCreate.comment.body).toBe("Official client comment");
      expect(commented.data?.commentCreate.comment.issue.id).toBe(issue.id);
    },
    30_000
  );
});
