// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import { createFileBackedRecorderStore, createRecorderStore } from "@pome-sh/sdk/server";
import {
  composeMime,
  createGmailTwinApp,
  encodeGmailRaw,
  openGmailTwinDatabase,
  type GmailStateSeed,
} from "../src/index.js";

const SID = "canary-matrix";
const SECRET = "canary-matrix-secret";
const EMAIL = "pome-agent@pome-twin.test";
const BODY_CANARY = "BODY-CANARY-MATRIX-7f91-secret";
const ATTACH_CANARY = "ATTACH-CANARY-MATRIX-3a0c-secret";
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = SECRET;
  token = await sign(
    {
      sid: SID,
      team_id: "team_test",
      gmail_email: EMAIL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SECRET
  );
});

function seed(): GmailStateSeed {
  return {
    primaryMailbox: { email: EMAIL, displayName: "Canary" },
    clock: "2025-01-01T00:00:00.000Z",
  };
}

function canaryMime() {
  return composeMime({
    from: EMAIL,
    to: ["recipient@example.test"],
    subject: "Canary matrix",
    text: `visible ${BODY_CANARY}`,
    date: "2025-01-01T12:00:00.000Z",
    messageId: "canary-matrix@test",
    attachments: [
      {
        filename: "secret.txt",
        mimeType: "text/plain",
        data: Buffer.from(ATTACH_CANARY).toString("base64"),
      },
    ],
  });
}

describe("canary matrix across recorder sinks", () => {
  it("keeps body+attachment secrets out of events, durable tape, /_pome/state, and error bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-canary-"));
    const tapePath = join(dir, "events.jsonl");
    const recorder = createFileBackedRecorderStore({ path: tapePath, fsync: false });
    try {
      const db = openGmailTwinDatabase(":memory:");
      const app = createGmailTwinApp({ db, seed: seed(), recorder, runId: "canary-matrix" });
      const request = async (path: string, init: RequestInit = {}) =>
        app.request(`/s/${SID}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${token}`, ...init.headers },
        });

      const created = (await (
        await request("/gmail/v1/users/me/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ raw: encodeGmailRaw(canaryMime()) }),
        })
      ).json()) as { id: string; snippet?: string };
      expect(created.snippet).toContain(BODY_CANARY);

      const full = (await (
        await request(`/gmail/v1/users/me/messages/${created.id}?format=full`)
      ).json()) as { payload?: { parts?: Array<{ body?: { attachmentId?: string } }> } };
      const attachmentId = full.payload?.parts?.find((part) => part.body?.attachmentId)?.body?.attachmentId;
      expect(attachmentId).toBeTruthy();
      const attachment = (await (
        await request(`/gmail/v1/users/me/messages/${created.id}/attachments/${attachmentId}`)
      ).json()) as { data: string };
      expect(Buffer.from(attachment.data, "base64url").toString()).toBe(ATTACH_CANARY);

      const eventsRes = await request("/_pome/events");
      expect(eventsRes.status).toBe(200);
      const eventsText = await eventsRes.text();
      expect(eventsText).not.toContain(BODY_CANARY);
      expect(eventsText).not.toContain(ATTACH_CANARY);

      await recorder.flush?.();
      const durable = readFileSync(tapePath, "utf8");
      expect(durable).not.toContain(BODY_CANARY);
      expect(durable).not.toContain(ATTACH_CANARY);
      expect(JSON.stringify(recorder.events())).not.toContain(BODY_CANARY);
      expect(JSON.stringify(recorder.events())).not.toContain(ATTACH_CANARY);

      const stateRes = await request("/_pome/state");
      expect(stateRes.status).toBe(200);
      const stateText = await stateRes.text();
      expect(stateText).not.toContain(BODY_CANARY);
      expect(stateText).not.toContain(ATTACH_CANARY);

      // Provoke an error that might echo request material; envelope must stay canary-free.
      const bad = await request("/gmail/v1/users/me/messages/batchModify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: Array.from({ length: 1001 }, (_, i) => `msg_${i}`),
          addLabelIds: [BODY_CANARY],
        }),
      });
      expect(bad.status).toBe(400);
      const errorText = await bad.text();
      expect(errorText).not.toContain(BODY_CANARY);
      expect(errorText).not.toContain(ATTACH_CANARY);
    } finally {
      await recorder.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps canaries out of heap recorder events for MCP paths", async () => {
    const recorder = createRecorderStore();
    const app = createGmailTwinApp({
      seed: {
        ...seed(),
        primaryMailbox: {
          email: EMAIL,
          messages: [
            {
              id: "msg_canary",
              threadId: "thread_canary",
              from: "alice@example.com",
              to: [EMAIL],
              subject: "Seeded canary",
              text: `Hello ${BODY_CANARY}`,
              date: "2025-01-01T12:00:00.000Z",
              messageId: "seed-canary@test",
              labels: ["INBOX", "UNREAD"],
              attachments: [
                {
                  filename: "seed.txt",
                  data: Buffer.from(ATTACH_CANARY).toString("base64"),
                },
              ],
            },
          ],
        },
      },
      recorder,
      runId: "mcp-canary-matrix",
    });
    const response = await app.request(`/s/${SID}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_thread", arguments: { threadId: "thread_canary", messageFormat: "FULL_CONTENT" } },
      }),
    });
    const body = (await response.json()) as { result: { structuredContent?: unknown } };
    expect(JSON.stringify(body.result.structuredContent)).toContain(BODY_CANARY);
    const tape = JSON.stringify(recorder.events());
    expect(tape).not.toContain(BODY_CANARY);
    expect(tape).not.toContain(ATTACH_CANARY);

    const state = await (
      await app.request(`/s/${SID}/_pome/state`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).text();
    expect(state).not.toContain(BODY_CANARY);
    expect(state).not.toContain(ATTACH_CANARY);
  });
});
