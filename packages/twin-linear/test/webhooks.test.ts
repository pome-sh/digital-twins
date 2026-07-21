// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAR_TOKEN,
  LinearCommands,
  createLinearTwinApp,
  defaultSeedState,
  openLinearTwinDatabase,
  type LinearStateSeed,
} from "../src/index.js";

const SECRET = "linear-webhooks-test-secret-32chars!";
let receiver: Server;
let receiverUrl: string;
let deliveries: Array<{ body: string; headers: Record<string, string | string[] | undefined> }> = [];

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = SECRET;
  receiver = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      deliveries.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address() as AddressInfo;
  receiverUrl = `http://127.0.0.1:${address.port}/hooks`;
});

afterAll(async () => {
  if (receiver) {
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

function seedWithoutWebhooks(): LinearStateSeed {
  const base = defaultSeedState();
  return { ...base, webhooks: [] };
}

async function graphql(
  app: ReturnType<typeof createLinearTwinApp>,
  query: string,
  variables?: Record<string, unknown>
) {
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
    body: (await response.json()) as { data?: Record<string, unknown>; errors?: unknown[] },
  };
}

describe("Linear webhooks", () => {
  it("creates a webhook, delivers on issue mutate, and logs delivery", async () => {
    deliveries = [];
    const db = openLinearTwinDatabase(":memory:");
    const app = createLinearTwinApp({
      db,
      seed: seedWithoutWebhooks(),
      runId: "webhooks-test",
    });

    const createdHook = await graphql(
      app,
      `mutation($input: WebhookCreateInput!) {
        webhookCreate(input: $input) { success webhook { id url } }
      }`,
      {
        input: {
          url: receiverUrl,
          label: "Test hook",
          resourceTypes: ["Issue"],
          teamId: "team_eng",
          secret: "whsec_local",
        },
      }
    );
    expect(createdHook.body.errors).toBeUndefined();
    const webhookId = (
      createdHook.body.data?.webhookCreate as { webhook: { id: string } }
    ).webhook.id;

    const createdIssue = await graphql(
      app,
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { id identifier } }
      }`,
      { input: { teamId: "team_eng", title: "Webhook trigger" } }
    );
    expect(createdIssue.body.errors).toBeUndefined();

    // Allow the async fetch to complete.
    for (let i = 0; i < 20 && deliveries.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0]!.headers["linear-event"]).toBe("Issue");
    expect(deliveries[0]!.body).toContain("Webhook trigger");

    const commands = new LinearCommands(db);
    const state = commands.exportState();
    const logged = state.webhookDeliveries as Array<{ webhookId: string; event: string }>;
    expect(logged.some((row) => row.webhookId === webhookId && row.event === "Issue")).toBe(true);
  });

  it("returns 501 for unsupported routes without side effects", async () => {
    const db = openLinearTwinDatabase(":memory:");
    const app = createLinearTwinApp({
      db,
      seed: seedWithoutWebhooks(),
      runId: "webhooks-501",
    });
    const before = (
      db.prepare("SELECT COUNT(*) AS count FROM issues").get() as { count: number }
    ).count;

    const response = await app.request("/unsupported/linear/path", {
      method: "POST",
      headers: {
        authorization: `Bearer ${DEFAULT_LINEAR_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "should not persist" }),
    });
    expect(response.status).toBe(501);
    const after = (
      db.prepare("SELECT COUNT(*) AS count FROM issues").get() as { count: number }
    ).count;
    expect(after).toBe(before);
  });
});
