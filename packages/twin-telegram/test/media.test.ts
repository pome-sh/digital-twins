// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { describe, expect, it } from "vitest";
import {
  TelegramDomain,
  MAX_CAPTION_UTF16,
  MAX_MEDIA_GROUP_UPLOAD_BYTES,
  MAX_MEDIA_MULTIPART_REQUEST_BYTES,
  MAX_MEDIA_UPLOAD_BYTES,
} from "../src/domain.js";
import { openTelegramTwinDatabase } from "../src/db.js";
import { defaultSeedState, SYNTHETIC_BOT_TOKEN } from "../src/seed.js";
import { createTelegramTwinApp } from "../src/twin.js";

const BOT = { kind: "bot" as const, botId: 1100001 };

function domainAt(now = 1_700_000_000) {
  const db = openTelegramTwinDatabase(":memory:");
  const domain = new TelegramDomain(db, () => now);
  domain.seed(defaultSeedState());
  return { db, domain };
}

describe("HTTP media foundation domain", () => {
  it("keeps an uploaded file bot-scoped and returns the exact stored bytes", () => {
    const { domain } = domainAt();
    const bytes = Buffer.from("digest equality\n");
    const message = domain.sendMedia(BOT, { chat_id: 2001, kind: "document", media: { bytes, filename: "report.txt", mimeType: "text/plain" }, caption: "report" });
    const document = message.document as { file_id: string };
    const file = domain.getFile(BOT, document.file_id);
    expect(domain.downloadFile(BOT, file.file_path as string).content.equals(bytes)).toBe(true);
    expect(() => domain.sendMedia(BOT, { chat_id: 2001, kind: "photo", media: "unique_not_a_handle" })).toThrow(/file_unique_id/);
    expect(() => domain.sendMedia(BOT, { chat_id: 2001, kind: "photo", media: "../../etc/passwd" })).toThrow(/URLs and host file paths/);
    const state = defaultSeedState();
    state.bots.push({ id: 1100002, token: "1100002:BBHBBBBBBBBBBBBBBBBBBBBB", first_name: "Y", username: "y_bot" });
    state.chats[0]!.members.push(1100002);
    domain.seed(state);
    const owned = domain.sendMedia(BOT, { chat_id: 2001, kind: "photo", media: { bytes: Buffer.from("owned") } });
    const ownedId = (owned.photo as Array<{ file_id: string }>)[0]!.file_id;
    expect(() => domain.sendMedia({ kind: "bot", botId: 1100002 }, { chat_id: 2001, kind: "photo", media: ownedId })).toThrow(/file not found/);
  });

  it("lets a receiving bot getFile user-sent media and keeps a foreign bot out", () => {
    const { domain } = domainAt();
    const state = defaultSeedState();
    state.bots.push({ id: 1100002, token: "1100002:BBHBBBBBBBBBBBBBBBBBBBBB", first_name: "Y", username: "y_bot" });
    state.chats[1]!.members.push(1100002);
    domain.seed(state);
    const bytes = Buffer.from("pome-telegram-fixture-file\n");
    const sent = domain.sendMedia({ kind: "user", account: "alice" }, {
      chat_id: 2001,
      kind: "document",
      media: { bytes, filename: "sample.txt", mimeType: "text/plain" },
    });
    const fileId = (sent.document as { file_id: string }).file_id;
    const file = domain.getFile(BOT, fileId);
    expect(domain.downloadFile(BOT, file.file_path as string).content.equals(bytes)).toBe(true);
    expect(() => domain.getFile({ kind: "bot", botId: 1100002 }, fileId)).toThrow(/file not found/);
  });

  it("uses the latest upload metadata for repeated bytes", () => {
    const { domain } = domainAt();
    const bytes = Buffer.from("same content");
    const first = domain.sendMedia(BOT, {
      chat_id: 2001,
      kind: "document",
      media: { bytes, filename: "first.txt", mimeType: "text/plain" },
    });
    const second = domain.sendMedia(BOT, {
      chat_id: 2001,
      kind: "document",
      media: { bytes, filename: "second.json", mimeType: "application/json" },
    });
    const firstDocument = first.document as { file_id: string };
    const secondDocument = second.document as { file_id: string; file_name: string; mime_type: string };
    expect(secondDocument.file_id).toBe(firstDocument.file_id);
    expect(secondDocument).toMatchObject({ file_name: "second.json", mime_type: "application/json" });
    expect(domain.downloadFile(BOT, domain.getFile(BOT, secondDocument.file_id).file_path as string).mimeType).toBe("application/json");
  });

  it("expires media, removes it on reset, and bounds captions and uploads", () => {
    let now = 10;
    const db = openTelegramTwinDatabase(":memory:");
    const domain = new TelegramDomain(db, () => now);
    domain.seed(defaultSeedState());
    const message = domain.sendMedia(BOT, { chat_id: 2001, kind: "voice", media: { bytes: Buffer.from("voice") } });
    const id = (message.voice as { file_id: string }).file_id;
    now += 24 * 3600;
    expect(() => domain.getFile(BOT, id)).toThrow(/file not found/);
    expect(() => domain.sendMedia(BOT, { chat_id: 2001, kind: "photo", media: { bytes: Buffer.alloc(MAX_MEDIA_UPLOAD_BYTES + 1) } })).toThrow(/upload/);
    expect(() => domain.sendMedia(BOT, { chat_id: 2001, kind: "photo", media: { bytes: Buffer.from("x") }, caption: "x".repeat(MAX_CAPTION_UTF16 + 1) })).toThrow(/caption/);
    domain.resetToDefault();
    expect(() => domain.getFile(BOT, id)).toThrow(/file not found/);
  });

  it("does not partially create an album when one reference is unavailable", () => {
    const { db, domain } = domainAt();
    expect(() => domain.sendMediaGroup(BOT, {
      chat_id: 2001,
      media: [
        { type: "photo", media: { bytes: Buffer.from("one") } },
        { type: "photo", media: "file_1100001_00000000000000000000000000000000" },
      ],
    })).toThrow(/file not found/);
    expect((db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count).toBe(0);
  });

  it("gives same-second albums with identical types distinct media group ids", () => {
    const { domain } = domainAt(1_700_000_000);
    const first = domain.sendMediaGroup(BOT, {
      chat_id: 2001,
      media: [
        { type: "photo", media: { bytes: Buffer.from("one") } },
        { type: "photo", media: { bytes: Buffer.from("two") } },
      ],
    });
    const second = domain.sendMediaGroup(BOT, {
      chat_id: 2001,
      media: [
        { type: "photo", media: { bytes: Buffer.from("three") } },
        { type: "photo", media: { bytes: Buffer.from("four") } },
      ],
    });
    const firstGroupId = (first[0] as { media_group_id: string }).media_group_id;
    expect(firstGroupId).not.toBe((second[0] as { media_group_id: string }).media_group_id);
    expect(first.map((message) => (message as { media_group_id: string }).media_group_id)).toEqual([
      firstGroupId,
      firstGroupId,
    ]);
  });
});

function albumForm(sizes: number[]): FormData {
  const form = new FormData();
  form.set("chat_id", "2001");
  form.set("media", JSON.stringify(sizes.map((_, index) => ({ type: "photo", media: `attach://image-${index}` }))));
  for (const [index, size] of sizes.entries()) {
    form.set(`image-${index}`, new Blob([Buffer.alloc(size, index)]), `image-${index}.png`);
  }
  return form;
}

describe("HTTP media foundation", () => {
  it("records sendChatAction as validation without a state mutation", async () => {
    const db = openTelegramTwinDatabase(":memory:");
    const recorder = createRecorderStore();
    const app = createTelegramTwinApp({ db, seed: defaultSeedState(), recorder });
    const response = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: 2001, action: "typing" }),
    });
    expect(response.status).toBe(200);
    expect(recorder.events().at(-1)).toMatchObject({ state_mutation: false, state_delta: null });
    expect((db.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count).toBe(0);
  });

  it("resolves attach:// album files and permits a multipart aggregate above one file limit", async () => {
    const app = createTelegramTwinApp({ seed: defaultSeedState() });
    const response = await app.request(`/bot${SYNTHETIC_BOT_TOKEN}/sendMediaGroup`, {
      method: "POST",
      body: albumForm([11 * 1024 * 1024, 11 * 1024 * 1024]),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: Array<{ media_group_id: string; photo: Array<{ file_id: string }> }> };
    expect(body.result).toHaveLength(2);
    expect(body.result[0]!.media_group_id).toBe(body.result[1]!.media_group_id);
  });

  it("enforces the aggregate request budget without Content-Length", async () => {
    const recorder = createRecorderStore();
    const app = createTelegramTwinApp({ seed: defaultSeedState(), recorder });
    let pulls = 0;
    let cancelled = false;
    const request = new Request(`http://twin.invalid/bot${SYNTHETIC_BOT_TOKEN}/sendMediaGroup`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(Buffer.alloc(MAX_MEDIA_GROUP_UPLOAD_BYTES + 1024 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 }),
      duplex: "half",
    } as RequestInit);
    const response = await app.request(request);
    expect(response.status).toBe(413);
    const event = recorder.events().at(-1)!;
    expect(event.request_headers?.["content-length"]).toBeUndefined();
    expect(event.error).toBe("Request Entity Too Large");
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
    expect(MAX_MEDIA_GROUP_UPLOAD_BYTES).toBe(64 * 1024 * 1024);
  });

  it("rejects oversized declared and chunked multipart bodies before recorder capture or full buffering", async () => {
    const recorder = createRecorderStore();
    const app = createTelegramTwinApp({ seed: defaultSeedState(), recorder });
    const declaredLength = new Request(`http://twin.invalid/bot${SYNTHETIC_BOT_TOKEN}/sendDocument`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(MAX_MEDIA_MULTIPART_REQUEST_BYTES + 1),
      },
      body: new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }),
      duplex: "half",
    } as RequestInit);
    const declaredLengthResponse = await app.request(declaredLength);
    expect(declaredLengthResponse.status).toBe(413);
    expect(recorder.events().at(-1)?.request_body).toBeNull();

    let chunkPulls = 0;
    let cancelled = false;
    const chunked = new Request(`http://twin.invalid/bot${SYNTHETIC_BOT_TOKEN}/sendDocument`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          chunkPulls += 1;
          controller.enqueue(Buffer.alloc(MAX_MEDIA_MULTIPART_REQUEST_BYTES + 1));
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 }),
      duplex: "half",
    } as RequestInit);
    const chunkedResponse = await app.request(chunked);
    expect(chunkedResponse.status).toBe(413);
    expect(chunkPulls).toBe(1);
    expect(cancelled).toBe(true);
    expect(recorder.events().at(-1)?.request_body).toBeNull();
  });

  it("downloads raw bytes with MIME type only in the owning session and records redacted metadata", async () => {
    const recorder = createRecorderStore();
    const app = createTelegramTwinApp({ seed: defaultSeedState(), recorder, runId: "telegram-download" });
    const bytes = Buffer.from("download-canary-bytes");
    const upload = new FormData();
    upload.set("chat_id", "2001");
    upload.set("document", new Blob([bytes], { type: "text/plain" }), "canary.txt");
    const sent = await app.request(`/s/owner/bot${SYNTHETIC_BOT_TOKEN}/sendDocument`, { method: "POST", body: upload });
    expect(sent.status).toBe(200);
    const sentBody = await sent.json() as { result: { document: { file_id: string } } };
    const file = await app.request(`/s/owner/bot${SYNTHETIC_BOT_TOKEN}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: sentBody.result.document.file_id }),
    });
    const fileBody = await file.json() as { result: { file_path: string } };
    const download = await app.request(`/s/owner/file/bot${SYNTHETIC_BOT_TOKEN}/${fileBody.result.file_path}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("text/plain");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);

    const otherSession = await app.request(`/s/other/file/bot${SYNTHETIC_BOT_TOKEN}/${fileBody.result.file_path}`);
    expect(otherSession.status).toBe(404);

    const event = recorder.events().find((candidate) => candidate.path.startsWith("/s/owner/file/"))!;
    const expectedMetadata = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      mime_type: "text/plain",
    };
    expect(event.path).toBe(`/s/owner/file/bot[REDACTED]/${fileBody.result.file_path}`);
    expect(event.response_body).toEqual({ media: expectedMetadata });
    expect(JSON.stringify(event)).not.toContain(SYNTHETIC_BOT_TOKEN);
    expect(JSON.stringify(event)).not.toContain(bytes.toString());
  });
});
