// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { TelegramDomain, MAX_CAPTION_UTF16, MAX_MEDIA_UPLOAD_BYTES } from "../src/domain.js";
import { openTelegramTwinDatabase } from "../src/db.js";
import { defaultSeedState } from "../src/seed.js";

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
});
