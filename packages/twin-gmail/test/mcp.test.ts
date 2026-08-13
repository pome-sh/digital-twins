// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import { createFileBackedRecorderStore, createRecorderStore } from "@pome-sh/sdk/server";
import canonicalListing from "../fixtures/mcp-tools-list.canonical.json" with { type: "json" };
import {
  createGmailTwinApp,
  defaultSeedState,
  gmailTools,
} from "../src/index.js";

const secret = "gmail-mcp-test-secret-32-characters";
const sid = "gmail-mcp-session";
const email = "pome-agent@pome-twin.test";
const base = `/s/${sid}`;
const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = secret;
  token = await sign(
    {
      sid,
      team_id: "tm_gmail",
      gmail_email: email,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret
  );
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

function seed() {
  return {
    ...defaultSeedState(),
    clock: "2026-07-20T00:00:00.000Z",
    primaryMailbox: {
      email,
      labels: [{ id: "Label_seed", name: "triage" }],
      messages: [
        {
          id: "msg_seed",
          threadId: "thread_seed",
          from: "alice@example.com",
          to: [email],
          subject: "Seed message",
          text: "Unread body",
          date: "2026-07-19T12:00:00.000Z",
          messageId: "seed@example.com",
          labels: ["INBOX", "UNREAD"],
        },
      ],
      drafts: [
        {
          id: "draft_seed",
          threadId: "thread_draft_seed",
          to: ["bob@example.com"],
          subject: "Seed draft",
          text: "Draft body",
          date: "2026-07-19T13:00:00.000Z",
          messageId: "draft-seed@example.com",
        },
      ],
    },
  };
}

function withAuth(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

function rpc(app: ReturnType<typeof createGmailTwinApp>, body: unknown) {
  return app.request(
    `${base}/mcp`,
    withAuth({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function call(
  app: ReturnType<typeof createGmailTwinApp>,
  id: number,
  name: string,
  args: Record<string, unknown>
) {
  return (await (
    await rpc(app, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    })
  ).json()) as {
    jsonrpc: "2.0";
    id: number;
    result: {
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
      isError: boolean;
    };
  };
}

function rest(
  app: ReturnType<typeof createGmailTwinApp>,
  path: string,
  init: RequestInit = {}
) {
  return app.request(`${base}/gmail/v1/users/me${path}`, withAuth(init));
}

describe("Gmail MCP frozen contract", () => {
  it("pins the exact thirteen-tool order, metadata, schemas, annotations, and mutation set", async () => {
    const app = createGmailTwinApp({ seed: seed() });
    const listed = (await (
      await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" })
    ).json()) as { result: { tools: unknown[] } };
    expect(listed.result.tools).toEqual(canonicalListing.result.tools);
    expect(gmailTools).toHaveLength(13);
    expect(gmailTools.map((tool) => tool.name)).toEqual(
      canonicalListing.meta.liveToolOrder
    );
    expect(
      gmailTools.filter((tool) => tool.mutation).map((tool) => tool.name)
    ).toEqual([
      "create_draft",
      "label_thread",
      "unlabel_thread",
      "apply_sensitive_thread_label",
      "label_message",
      "unlabel_message",
      "apply_sensitive_message_label",
      "create_label",
    ]);
  });

  it("executes all thirteen tools with captured result shapes and truthful recorder flags", async () => {
    const recorder = createRecorderStore();
    const app = createGmailTwinApp({
      seed: {
        ...seed(),
        primaryMailbox: {
          ...seed().primaryMailbox,
          messages: [
            ...seed().primaryMailbox.messages,
            {
              id: "msg_spam_target",
              threadId: "thread_spam_target",
              from: "spam@example.com",
              to: [email],
              subject: "Spam target",
              text: "Sensitive label target",
              date: "2026-07-19T12:30:00.000Z",
              messageId: "spam-target@example.com",
              labels: ["INBOX"],
            },
            {
              id: "msg_trash_target",
              threadId: "thread_trash_target",
              from: "trash@example.com",
              to: [email],
              subject: "Trash target",
              text: "Thread sensitive label target",
              date: "2026-07-19T12:31:00.000Z",
              messageId: "trash-target@example.com",
              labels: ["INBOX"],
            },
          ],
        },
      },
      recorder,
      runId: "run_mcp",
    });
    const attachmentCanary = "mcp-binary-canary";
    const responses = [
      await call(app, 1, "create_draft", {
        to: ["bob@example.com"],
        subject: "MCP draft",
        body: "Created through MCP",
        attachments: [
          {
            content: Buffer.from(attachmentCanary).toString("base64"),
            filename: "canary.txt",
            mimeType: "text/plain",
          },
        ],
      }),
      await call(app, 2, "list_drafts", { pageSize: 20 }),
      await call(app, 3, "get_thread", {
        threadId: "thread_seed",
        messageFormat: "FULL_CONTENT",
      }),
      await call(app, 4, "get_message", {
        messageId: "msg_seed",
        messageFormat: "FULL_CONTENT",
      }),
      await call(app, 5, "search_threads", {
        query: "is:unread -in:draft",
        pageSize: 20,
      }),
      await call(app, 6, "label_thread", {
        threadId: "thread_seed",
        labelIds: ["Label_seed"],
      }),
      await call(app, 7, "unlabel_thread", {
        threadId: "thread_seed",
        labelIds: ["Label_seed"],
      }),
      await call(app, 8, "apply_sensitive_thread_label", {
        threadId: "thread_trash_target",
        labelOption: "TRASH",
      }),
      await call(app, 9, "list_labels", {}),
      await call(app, 10, "label_message", {
        messageId: "msg_seed",
        labelIds: ["STARRED"],
      }),
      await call(app, 11, "unlabel_message", {
        messageId: "msg_seed",
        labelIds: ["STARRED"],
      }),
      await call(app, 12, "apply_sensitive_message_label", {
        messageId: "msg_spam_target",
        labelOption: "SPAM",
      }),
      await call(app, 13, "create_label", { displayName: "Projects/Alpha" }),
    ];

    expect(responses.every((response) => response.result.isError === false)).toBe(true);
    expect(responses.every((response) => response.result.structuredContent)).toBe(true);
    for (const index of [5, 6, 7, 9, 10, 11]) {
      expect(responses[index]!.result.content).toEqual([{ type: "text", text: "OK" }]);
      expect(responses[index]!.result.structuredContent).toEqual({});
    }
    expect(responses[2]!.result.structuredContent).toMatchObject({
      id: "thread_seed",
      messages: [{ id: "msg_seed", plaintextBody: "Unread body" }],
    });
    expect(responses[3]!.result.structuredContent).toMatchObject({
      id: "msg_seed",
      plaintextBody: "Unread body",
    });
    expect(responses[4]!.result.structuredContent).toMatchObject({
      threads: [{ id: "thread_seed" }],
    });
    expect(responses[4]!.result.structuredContent).not.toHaveProperty("nextPageToken");
    expect(responses[12]!.result.structuredContent).toMatchObject({
      name: "Projects/Alpha",
      threadsTotal: 0,
      threadsUnread: 0,
    });

    const events = recorder.events();
    expect(events).toHaveLength(13);
    expect(events.map((event) => event.state_mutation)).toEqual(
      gmailTools.map((tool) => tool.mutation)
    );
    expect(
      events.map((event) => (event.state_mutation ? event.state_delta !== null : event.state_delta))
    ).toEqual([
      true,
      null,
      null,
      null,
      null,
      true,
      true,
      true,
      null,
      true,
      true,
      true,
      true,
    ]);
    const tape = JSON.stringify(events);
    expect(tape).not.toContain(attachmentCanary);
    expect(tape).not.toContain(Buffer.from(attachmentCanary).toString("base64"));
    expect(events[0]?.request_body).toMatchObject({
      arguments: {
        attachments: [{ content: { sha256: expect.any(String), size: attachmentCanary.length } }],
      },
    });
  });

  it("returns MCP isError results for independently validated bad arguments", async () => {
    const app = createGmailTwinApp({ seed: seed() });
    const invalidToolArgs = await call(app, 1, "get_thread", {});
    expect(invalidToolArgs.result.isError).toBe(true);
    expect(invalidToolArgs.result.structuredContent).toBeUndefined();
    expect(JSON.parse(invalidToolArgs.result.content[0]!.text)).toMatchObject({
      error: { code: 400, status: "INVALID_ARGUMENT" },
    });

    const invalidRpc = (await (
      await rpc(app, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_thread", arguments: "not-an-object" },
      })
    ).json()) as { error: { code: number } };
    expect(invalidRpc.error.code).toBe(-32602);
  });

  it("maps bad search queries to 400 INVALID_ARGUMENT (not 500)", async () => {
    const recorder = createRecorderStore();
    const app = createGmailTwinApp({ seed: seed(), recorder, runId: "mcp-bad-q" });
    const bad = await call(app, 1, "search_threads", { query: "xyzzy:not-real" });
    expect(bad.result.isError).toBe(true);
    const body = JSON.parse(bad.result.content[0]!.text) as {
      error: { code: number; status: string; message: string };
    };
    expect(body.error.code).toBe(400);
    expect(body.error.status).toBe("INVALID_ARGUMENT");
    expect(body.error.message).toMatch(/Unsupported search operator/i);
    const event = recorder.events().at(-1);
    expect(event?.status).toBe(400);
    expect(event?.error).toMatch(/Unsupported search operator/i);
  });

  it("records state_mutation=false for MCP label no-ops", async () => {
    const recorder = createRecorderStore();
    const app = createGmailTwinApp({ seed: seed(), recorder, runId: "mcp-noop" });
    await call(app, 1, "label_message", { messageId: "msg_seed", labelIds: ["STARRED"] });
    await call(app, 2, "label_message", { messageId: "msg_seed", labelIds: ["STARRED"] });
    const labelEvents = recorder.events().filter((event) => {
      const body = event.request_body as { tool?: string } | null;
      return body?.tool === "label_message";
    });
    expect(labelEvents).toHaveLength(2);
    expect(labelEvents[0]?.state_mutation).toBe(true);
    expect(labelEvents[0]?.state_delta).not.toBeNull();
    expect(labelEvents[1]?.state_mutation).toBe(false);
    expect(labelEvents[1]?.state_delta).toBeNull();
  });

  it("keeps MIME snippet canaries out of /_pome/events and durable tape", async () => {
    const canary = "MCP-SNIPPET-MIME-CANARY-9f3a";
    const dir = mkdtempSync(join(tmpdir(), "gmail-mcp-tape-"));
    const tapePath = join(dir, "events.jsonl");
    const recorder = createFileBackedRecorderStore({ path: tapePath, fsync: false });
    try {
      const app = createGmailTwinApp({
        seed: {
          ...seed(),
          primaryMailbox: {
            ...seed().primaryMailbox,
            messages: [
              {
                id: "msg_canary",
                threadId: "thread_canary",
                from: "alice@example.com",
                to: [email],
                subject: "Canary subject",
                text: `Hello ${canary} world`,
                date: "2026-07-19T12:00:00.000Z",
                messageId: "canary@example.com",
                labels: ["INBOX", "UNREAD"],
              },
            ],
          },
        },
        recorder,
        runId: "run_snippet_canary",
      });

      const listed = await call(app, 1, "search_threads", { query: "in:inbox" });
      expect(listed.result.isError).toBe(false);
      const listedText = JSON.stringify(listed.result);
      expect(listedText).toContain(canary);

      const got = await call(app, 2, "get_thread", { threadId: "thread_canary" });
      expect(got.result.isError).toBe(false);
      expect(JSON.stringify(got.result)).toContain(canary);

      const eventsRes = await app.request(`${base}/_pome/events`, withAuth());
      expect(eventsRes.status).toBe(200);
      const eventsJson = await eventsRes.text();
      expect(eventsJson).not.toContain(canary);

      await recorder.flush?.();
      const durable = readFileSync(tapePath, "utf8");
      expect(durable).not.toContain(canary);
      expect(JSON.stringify(recorder.events())).not.toContain(canary);
    } finally {
      await recorder.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records null state_delta for label no-op mutations", async () => {
    const recorder = createRecorderStore();
    const app = createGmailTwinApp({ seed: seed(), recorder, runId: "run_noop" });

    // msg_seed already has INBOX — re-adding is a no-op.
    const noopAdd = await call(app, 1, "label_message", {
      messageId: "msg_seed",
      labelIds: ["INBOX"],
    });
    expect(noopAdd.result.isError).toBe(false);

    // Removing a label that is not present is also a no-op.
    const noopRemove = await call(app, 2, "unlabel_message", {
      messageId: "msg_seed",
      labelIds: ["STARRED"],
    });
    expect(noopRemove.result.isError).toBe(false);

    const events = recorder.events().filter((event) => event.path.endsWith("/mcp"));
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.state_delta).toBeNull();
    }
  });
});

describe("MCP page tokens", () => {
  it("rejects cross-query and stale snapshot tokens", async () => {
    const app = createGmailTwinApp({
      seed: {
        ...seed(),
        primaryMailbox: {
          ...seed().primaryMailbox,
          messages: [
            ...seed().primaryMailbox.messages,
            {
              id: "msg_b",
              threadId: "thread_b",
              from: "bob@example.com",
              to: [email],
              subject: "Second",
              text: "Other body",
              date: "2026-07-19T12:01:00.000Z",
              messageId: "b@example.com",
              labels: ["INBOX"],
            },
            {
              id: "msg_c",
              threadId: "thread_c",
              from: "carol@example.com",
              to: [email],
              subject: "Third",
              text: "Third body",
              date: "2026-07-19T12:02:00.000Z",
              messageId: "c@example.com",
              labels: ["INBOX"],
            },
          ],
        },
      },
    });

    const first = await call(app, 1, "search_threads", { query: "", pageSize: 1 });
    expect(first.result.isError).toBe(false);
    const token = first.result.structuredContent?.nextPageToken as string;
    expect(token).toMatch(/\./);

    const crossQuery = await call(app, 2, "search_threads", {
      query: "from:bob@example.com",
      pageSize: 1,
      pageToken: token,
    });
    expect(crossQuery.result.isError).toBe(true);

    const second = await call(app, 3, "search_threads", {
      query: "",
      pageSize: 1,
      pageToken: token,
    });
    expect(second.result.isError).toBe(false);

    await call(app, 4, "label_message", {
      messageId: "msg_seed",
      labelIds: ["STARRED"],
    });
    const stale = await call(app, 5, "search_threads", {
      query: "",
      pageSize: 1,
      pageToken: token,
    });
    expect(stale.result.isError).toBe(true);
  });

  it("rejects a page token minted for a different mailbox email", async () => {
    const otherEmail = "other@pome-twin.test";
    const otherToken = await sign(
      {
        sid,
        team_id: "tm_gmail",
        gmail_email: otherEmail,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      secret
    );
    const app = createGmailTwinApp({
      seed: {
        ...seed(),
        mailboxes: [
          {
            email: otherEmail,
            messages: [
              {
                id: "msg_other_a",
                threadId: "thread_other_a",
                from: "alice@example.com",
                to: [otherEmail],
                subject: "Other A",
                text: "A",
                date: "2026-07-19T12:00:00.000Z",
                messageId: "other-a@example.com",
                labels: ["INBOX"],
              },
              {
                id: "msg_other_b",
                threadId: "thread_other_b",
                from: "bob@example.com",
                to: [otherEmail],
                subject: "Other B",
                text: "B",
                date: "2026-07-19T12:01:00.000Z",
                messageId: "other-b@example.com",
                labels: ["INBOX"],
              },
            ],
          },
        ],
        primaryMailbox: {
          ...seed().primaryMailbox,
          messages: [
            ...seed().primaryMailbox.messages,
            {
              id: "msg_b",
              threadId: "thread_b",
              from: "bob@example.com",
              to: [email],
              subject: "Second",
              text: "Other body",
              date: "2026-07-19T12:01:00.000Z",
              messageId: "b@example.com",
              labels: ["INBOX"],
            },
          ],
        },
      },
    });

    const first = await call(app, 1, "search_threads", { query: "", pageSize: 1 });
    const pageToken = first.result.structuredContent?.nextPageToken as string;
    expect(pageToken.length).toBeGreaterThan(0);

    const foreign = (await (
      await app.request(
        `${base}/mcp`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${otherToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "search_threads",
              arguments: { query: "", pageSize: 1, pageToken },
            },
          }),
        }
      )
    ).json()) as { result: { isError?: boolean } };
    expect(foreign.result.isError).toBe(true);
  });
});

// F-1400 — the listing is Google's, so every claim in it is a claim about this
// twin. These are the three the August capture added that the handlers did not
// answer: adopting the bytes without them would advertise capabilities the twin
// does not have, which is the failure F-1330 exists to prevent reached from the
// other side. The two shape tests read the ADVERTISED property set out of the
// fixture rather than listing fields by hand, so the next field Google adds is
// a red here and not a silent absence.
describe("the adopted listing's claims are behaviours", () => {
  function fixtureTool(name: string) {
    const tool = canonicalListing.result.tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`${name} is not in the fixture`);
    return tool as {
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
      outputSchema: Record<string, unknown>;
    };
  }

  /** The property names an advertised schema declares, at a `$defs` path or the root. */
  function advertisedFields(name: string, def?: string): string[] {
    const schema = fixtureTool(name).outputSchema as {
      properties?: Record<string, unknown>;
      $defs?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const target = def ? schema.$defs?.[def] : schema;
    return Object.keys(target?.properties ?? {}).sort();
  }

  /** A message carrying every optional part, so no advertised field is absent for want of data. */
  function fullyPopulatedSeed() {
    const state = seed();
    return {
      ...state,
      primaryMailbox: {
        ...state.primaryMailbox,
        messages: [
          {
            ...state.primaryMailbox.messages[0]!,
            cc: ["carol@example.com"],
            bcc: ["dan@example.com"],
            html: "<p>Unread body</p>",
            attachments: [
              {
                filename: "note.txt",
                mimeType: "text/plain",
                data: Buffer.from("attached").toString("base64"),
              },
            ],
          },
        ],
        labels: [
          { id: "Label_seed", name: "triage", color: { textColor: "#000000", backgroundColor: "#ffffff" } },
        ],
      },
    };
  }

  it("answers every field the Message schema advertises, bccRecipients included", async () => {
    const app = createGmailTwinApp({ seed: fullyPopulatedSeed() });

    const message = await call(app, 1, "get_message", {
      messageId: "msg_seed",
      messageFormat: "FULL_CONTENT",
    });
    expect(message.result.isError).toBe(false);
    expect(Object.keys(message.result.structuredContent ?? {}).sort()).toEqual(
      advertisedFields("get_message")
    );
    expect(message.result.structuredContent).toMatchObject({
      toRecipients: [email],
      ccRecipients: ["carol@example.com"],
      bccRecipients: ["dan@example.com"],
    });

    // The same shape reached through the two tools that nest it.
    const thread = await call(app, 2, "get_thread", {
      threadId: "thread_seed",
      messageFormat: "FULL_CONTENT",
    });
    const nested = (thread.result.structuredContent?.messages as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(nested).sort()).toEqual(advertisedFields("get_thread", "Message"));

    const searched = await call(app, 3, "search_threads", { query: "", view: "THREAD_VIEW_MINIMAL" });
    const searchedMessage = (
      (searched.result.structuredContent?.threads as Array<{ messages: Array<Record<string, unknown>> }>)[0]!
        .messages
    )[0]!;
    expect(searchedMessage).toHaveProperty("bccRecipients", ["dan@example.com"]);
  });

  it("lists ALL labels, the way the adopted description says, and counts messages as well as threads", async () => {
    const app = createGmailTwinApp({ seed: fullyPopulatedSeed() });

    const listed = await call(app, 1, "list_labels", {});
    expect(listed.result.isError).toBe(false);
    const labels = listed.result.structuredContent?.labels as Array<Record<string, unknown>>;

    // "Lists all labels available in the authenticated user's Gmail account" —
    // the July listing said "all user-defined labels" and the handler answered
    // exactly those. The twin's own REST surface is the oracle for "all".
    const rested = (await (await rest(app, "/labels")).json()) as {
      labels: Array<{ id: string }>;
    };
    expect(labels.map((label) => label.labelId).sort()).toEqual(
      rested.labels.map((label) => label.id).sort()
    );
    expect(labels.map((label) => label.name)).toContain("INBOX");
    expect(labels.map((label) => label.name)).toContain("triage");

    const inbox = labels.find((label) => label.name === "INBOX")!;
    expect(inbox).toMatchObject({ messagesTotal: 1, messagesUnread: 1, threadsTotal: 1, threadsUnread: 1 });

    const triage = labels.find((label) => label.name === "triage")!;
    expect(Object.keys(triage).sort()).toEqual(advertisedFields("list_labels", "Label"));

    // create_label advertises the same Label shape at its root.
    const created = await call(app, 2, "create_label", {
      displayName: "Projects/Alpha",
      color: { textColor: "#000000", backgroundColor: "#ffffff" },
    });
    expect(Object.keys(created.result.structuredContent ?? {}).sort()).toEqual(
      advertisedFields("create_label")
    );
    expect(created.result.structuredContent).toMatchObject({
      name: "Projects/Alpha",
      messagesTotal: 0,
      messagesUnread: 0,
      threadsTotal: 0,
      threadsUnread: 0,
    });
  });

  it("answers every field the search_threads root advertises, resultCountEstimate included", async () => {
    // Read out of the fixture rather than named here (F-1400's pattern): if
    // Google adds a fourth root field, this reds instead of the twin quietly
    // never serving it. Naming `resultCountEstimate` in the assertion would
    // close exactly one gap and leave the class open.
    expect(advertisedFields("search_threads")).toContain("resultCountEstimate");

    // Two threads, because this file's `seed()` has exactly one: with a single
    // match, pageSize 1 returns the whole result set and `nextPageToken` can
    // never appear, so the root could not show its full advertised shape.
    const base = seed();
    const app = createGmailTwinApp({
      seed: {
        ...base,
        primaryMailbox: {
          ...base.primaryMailbox,
          messages: [
            ...base.primaryMailbox.messages,
            {
              ...base.primaryMailbox.messages[0]!,
              id: "msg_seed_2",
              threadId: "thread_seed_2",
              subject: "Second seed message",
              messageId: "seed2@example.com",
              date: "2026-07-19T13:00:00.000Z",
            },
          ],
        },
      },
    });

    // pageSize 1 against a multi-thread mailbox so `nextPageToken` is present
    // too — otherwise the root can never show its full advertised set and the
    // comparison below would be asserting a shape the tool cannot produce.
    const page = await call(app, 1, "search_threads", { query: "", pageSize: 1 });
    expect(page.result.isError).toBe(false);
    expect(Object.keys(page.result.structuredContent ?? {}).sort()).toEqual(
      advertisedFields("search_threads")
    );

    // int64-as-string, as the outputSchema declares — a number here would
    // satisfy "present" while diverging from the advertised type.
    const estimate = (page.result.structuredContent as { resultCountEstimate?: unknown })
      .resultCountEstimate;
    expect(typeof estimate).toBe("string");

    // The WHOLE match set, not the page. This is the assertion with teeth:
    // returning `page.items.length` would also be a string and also be present,
    // and would be wrong by exactly the amount that matters.
    const all = await call(app, 2, "search_threads", { query: "" });
    const total = (all.result.structuredContent as { threads: unknown[] }).threads.length;
    expect((page.result.structuredContent as { threads: unknown[] }).threads.length).toBe(1);
    expect(estimate).toBe(String(total));
    expect(total).toBeGreaterThan(1);
  });

  it("reports a zero match count rather than omitting the field", async () => {
    // 0 is an answer to "how many matched". If the field were emitted only when
    // non-zero, an absent field would mean both "no matches" and "this twin
    // does not serve it" — which is the gap F-1417 closed.
    const app = createGmailTwinApp({ seed: fullyPopulatedSeed() });
    const none = await call(app, 1, "search_threads", { query: "is:unread from:nobody@example.invalid" });
    expect(none.result.isError).toBe(false);
    const body = none.result.structuredContent as { threads: unknown[]; resultCountEstimate?: unknown };
    expect(body.threads).toEqual([]);
    expect(body.resultCountEstimate).toBe("0");
  });

  it("takes no page arguments on list_labels, because the listing declares none", async () => {
    const app = createGmailTwinApp({ seed: fullyPopulatedSeed() });

    // `toEqual([])`, not `toMatchObject({properties:{}})` — the latter is subset
    // matching and would pass against any property set at all.
    expect(Object.keys(fixtureTool("list_labels").inputSchema.properties ?? {})).toEqual([]);
    expect(advertisedFields("list_labels")).toEqual(["labels"]);

    // Every label in one answer, and no token offering a page that cannot be asked for.
    const listed = await call(app, 1, "list_labels", {});
    expect(listed.result.structuredContent).not.toHaveProperty("nextPageToken");
    const rested = (await (await rest(app, "/labels")).json()) as { labels: unknown[] };
    expect((listed.result.structuredContent?.labels as unknown[]).length).toBe(rested.labels.length);
  });
});

describe("MCP/REST cross-surface parity", () => {
  it("shares search, get, draft, and label state with REST", async () => {
    const app = createGmailTwinApp({ seed: seed() });

    const mcpSearch = await call(app, 1, "search_threads", { query: "is:unread" });
    const restSearch = (await (
      await rest(app, "/threads?q=is%3Aunread")
    ).json()) as { threads: Array<{ id: string }> };
    expect(
      (mcpSearch.result.structuredContent?.threads as Array<{ id: string }>).map(
        (thread) => thread.id
      )
    ).toEqual(restSearch.threads.map((thread) => thread.id));

    const mcpGet = await call(app, 2, "get_thread", { threadId: "thread_seed" });
    const restGet = (await (
      await rest(app, "/threads/thread_seed")
    ).json()) as { id: string; messages: Array<{ id: string }> };
    expect(mcpGet.result.structuredContent).toMatchObject({
      id: restGet.id,
      messages: restGet.messages.map((message) => ({ id: message.id })),
    });

    const mcpDraft = await call(app, 3, "create_draft", {
      to: ["bob@example.com"],
      subject: "Parity draft",
      body: "Parity body",
    });
    const restDrafts = (await (await rest(app, "/drafts")).json()) as {
      drafts: Array<{ id: string }>;
    };
    expect(restDrafts.drafts.map((draft) => draft.id)).toContain(
      mcpDraft.result.structuredContent?.id
    );

    await call(app, 4, "label_message", {
      messageId: "msg_seed",
      labelIds: ["Label_seed"],
    });
    const restLabeled = (await (
      await rest(app, "/messages/msg_seed?format=minimal")
    ).json()) as { labelIds: string[] };
    expect(restLabeled.labelIds).toContain("Label_seed");

    await rest(app, "/messages/msg_seed/modify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["Label_seed"] }),
    });
    const mcpAfterRest = await call(app, 5, "get_thread", {
      threadId: "thread_seed",
      messageFormat: "MINIMAL",
    });
    expect(
      (
        mcpAfterRest.result.structuredContent?.messages as Array<{
          labelIds: string[];
        }>
      )[0]!.labelIds
    ).not.toContain("Label_seed");

    await rest(app, "/labels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "REST-created" }),
    });
    const mcpLabels = await call(app, 6, "list_labels", {});
    expect(
      (mcpLabels.result.structuredContent?.labels as Array<{ name: string }>).map(
        (label) => label.name
      )
    ).toContain("REST-created");
  });
});
