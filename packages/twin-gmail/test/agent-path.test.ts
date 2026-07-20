// SPDX-License-Identifier: Apache-2.0
/**
 * Agent-path HTTP E2E checklist with Pome assertions (Phase B).
 * Covers hot REST flows agents exercise; rejects Emulate-known-bad behaviors.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import {
  createGmailTwinApp,
  defaultSeedState,
  openGmailTwinDatabase,
  type GmailStateSeed,
} from "../src/index.js";
import { buildHtmlAttachmentMime, buildTestMime, buildTestMimeRaw } from "./mime-fixtures.js";

const SID = "gmail-agent-path";
const SECRET = "gmail-agent-path-test-secret";
const EMAIL = "pome-agent@pome-twin.test";
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = SECRET;
  token = await sign(
    {
      sid: SID,
      team_id: "team_agent_path",
      gmail_email: EMAIL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SECRET
  );
});

function agentSeed(): GmailStateSeed {
  const base = defaultSeedState();
  return {
    ...base,
    clock: "2026-07-20T00:00:00.000Z",
    primaryMailbox: {
      ...base.primaryMailbox,
      filters: [
        {
          id: "filter_import_star",
          criteria: { subject: "Filter Import Target" },
          action: { addLabelIds: ["STARRED"] },
        },
      ],
    },
  };
}

function fixture(seed: GmailStateSeed = agentSeed()) {
  const db = openGmailTwinDatabase(":memory:");
  const app = createGmailTwinApp({ db, seed, runId: "agent-path-test" });
  const request = async (path: string, init: RequestInit = {}) =>
    app.request(`/s/${SID}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
  return { app, db, request };
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

describe("Gmail agent-path HTTP E2E", () => {
  it("seeds a multi-thread inbox with welcome/build/support/draft patterns", async () => {
    const { request } = fixture();
    const profile = await json(await request("/gmail/v1/users/me/profile"));
    expect(profile.emailAddress).toBe(EMAIL);
    expect(profile.messagesTotal).toBeGreaterThanOrEqual(4);
    expect(profile.threadsTotal).toBeGreaterThanOrEqual(3);

    const listed = await json(await request("/gmail/v1/users/me/messages?q=is:unread"));
    const ids = (listed.messages ?? []).map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["msg_build", "msg_support"]));

    const build = await json(await request("/gmail/v1/users/me/threads/thread_build?format=metadata"));
    expect(build.messages).toHaveLength(2);
    const drafts = await json(await request("/gmail/v1/users/me/drafts"));
    expect((drafts.drafts ?? []).some((d: { id: string }) => d.id === "draft_ack")).toBe(true);
  });

  it("gets attachments from seeded and imported messages", async () => {
    const { request } = fixture();
    const seeded = await json(await request("/gmail/v1/users/me/messages/msg_build?format=full"));
    const seededPart = seeded.payload.parts.find((part: any) => part.body?.attachmentId);
    expect(seededPart?.filename).toBe("build.log");
    const seededBytes = await json(
      await request(`/gmail/v1/users/me/messages/msg_build/attachments/${seededPart.body.attachmentId}`)
    );
    expect(Buffer.from(seededBytes.data, "base64url").toString("utf8")).toContain("BUILD FAILED");

    const mime = buildHtmlAttachmentMime({
      from: "sender@example.com",
      to: [EMAIL],
      subject: "HTML with attachment",
      htmlBody: "<p>Report ready</p>",
      attachment: { filename: "report.txt", content: "attachment-canary-data", mimeType: "text/plain" },
    });
    const imported = await json(
      await request("/gmail/v1/users/me/messages/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw: buildTestMimeRaw({
          from: "sender@example.com",
          to: [EMAIL],
          subject: "HTML with attachment",
          html: "<p>Report ready</p>",
          text: "Report ready",
          messageId: "html-attach@import.test",
          attachments: [{ filename: "report.txt", content: "attachment-canary-data", mimeType: "text/plain" }],
        }) }),
      })
    );
    expect(imported.id).toBeTruthy();
    expect(mime.includes("report.txt")).toBe(true);
    const full = await json(await request(`/gmail/v1/users/me/messages/${imported.id}?format=full`));
    const part = full.payload.parts.find((p: any) => p.body?.attachmentId);
    const downloaded = await json(
      await request(`/gmail/v1/users/me/messages/${imported.id}/attachments/${part.body.attachmentId}`)
    );
    expect(Buffer.from(downloaded.data, "base64url").toString("utf8")).toBe("attachment-canary-data");
  });

  it("applies filter-on-import labels and records history after mutations", async () => {
    const { request } = fixture();
    const profile = await json(await request("/gmail/v1/users/me/profile"));
    const startHistoryId = profile.historyId;

    const imported = await json(
      await request("/gmail/v1/users/me/messages/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          raw: buildTestMimeRaw({
            from: "filters@example.com",
            to: [EMAIL],
            subject: "Filter Import Target",
            text: "should become STARRED via filter",
          }),
        }),
      })
    );
    expect(imported.labelIds).toEqual(expect.arrayContaining(["INBOX", "STARRED"]));

    await request(`/gmail/v1/users/me/messages/${imported.id}/modify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addLabelIds: ["IMPORTANT"] }),
    });

    const history = await json(
      await request(`/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(startHistoryId)}`)
    );
    expect(history.historyId).toBeTruthy();
    expect(Number(history.historyId)).toBeGreaterThan(Number(startHistoryId));
    expect(Array.isArray(history.history) && history.history.length > 0).toBe(true);
  });

  it("modifies and trashes threads; send joins an existing thread", async () => {
    const { request } = fixture();
    const modified = await json(
      await request("/gmail/v1/users/me/threads/thread_support/modify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addLabelIds: ["Label_follow_up"] }),
      })
    );
    expect(modified.messages[0].labelIds).toContain("Label_follow_up");

    const trashed = await json(
      await request("/gmail/v1/users/me/threads/thread_support/trash", { method: "POST" })
    );
    expect(trashed.messages.every((m: { labelIds: string[] }) => m.labelIds.includes("TRASH"))).toBe(true);
    await request("/gmail/v1/users/me/threads/thread_support/untrash", { method: "POST" });

    const sent = await json(
      await request("/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "thread_support",
          raw: buildTestMimeRaw({
            from: EMAIL,
            to: ["alice@example.com"],
            subject: "Re: Production export is stuck",
            text: "Investigating now.",
            inReplyTo: "support-001@example.com",
            references: ["support-001@example.com"],
            messageId: "support-agent-reply@pome-twin.test",
          }),
        }),
      })
    );
    expect(sent.labelIds).toContain("SENT");
    expect(sent.threadId).toBe("thread_support");
    const thread = await json(await request("/gmail/v1/users/me/threads/thread_support"));
    expect(thread.messages.length).toBeGreaterThanOrEqual(2);
    expect(thread.messages.some((m: { id: string }) => m.id === sent.id)).toBe(true);
  });

  it("keeps Pome draft-id replacement, opaque tokens, loud search, and watch/stop 501", async () => {
    const { request, db } = fixture();
    const draft = await json(
      await request("/gmail/v1/users/me/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            raw: buildTestMimeRaw({
              from: EMAIL,
              to: ["carol@example.com"],
              subject: "Agent draft",
              text: "v1",
            }),
          },
        }),
      })
    );
    const updated = await json(
      await request(`/gmail/v1/users/me/drafts/${draft.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            raw: buildTestMimeRaw({
              from: EMAIL,
              to: ["carol@example.com"],
              subject: "Agent draft",
              text: "v2",
              messageId: "agent-draft-v2@pome-twin.test",
            }),
          },
        }),
      })
    );
    // Pome: draft id stable; underlying message id replaced (not Emulate in-place).
    expect(updated.id).toBe(draft.id);
    expect(updated.message.id).not.toBe(draft.message.id);

    const page = await json(await request("/gmail/v1/users/me/messages?maxResults=1"));
    expect(page.nextPageToken).toMatch(/\./);
    expect(page.nextPageToken).not.toMatch(/^\d+$/);
    const rebound = await request(
      `/gmail/v1/users/me/messages?maxResults=1&q=subject:nope&pageToken=${encodeURIComponent(page.nextPageToken)}`
    );
    expect(rebound.status).toBe(400);

    expect((await request("/gmail/v1/users/me/messages?q=xyzzy:nope")).status).toBe(400);
    expect((await request("/gmail/v1/users/me/messages?q=%28unclosed")).status).toBe(400);

    // Structured compose without raw is rejected — REST stays raw-required.
    const structured = await request("/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "alice@example.com", subject: "no raw", body: "denied" }),
    });
    expect(structured.status).toBeGreaterThanOrEqual(400);

    const before = (db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count;
    for (const path of ["/gmail/v1/users/me/watch", "/gmail/v1/users/me/stop"]) {
      const response = await request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(501);
      expect(await json(response)).toMatchObject({ error: { code: 501, status: "UNIMPLEMENTED" } });
    }
    const after = (db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count;
    expect(after).toBe(before);

    // mime helper still usable for plain buffers in other assertions
    expect(buildTestMime({ from: EMAIL, to: [EMAIL], subject: "helper" }).includes("helper")).toBe(true);
  });
});
