// SPDX-License-Identifier: Apache-2.0
//
// In-memory fixture catalog for user-MCP send paths. file_path arguments
// resolve here or as an already-stored opaque file_id. The twin never reads
// or writes the host filesystem.
import { createHash } from "node:crypto";
import { telegramFail } from "./errors.js";

export type CatalogKind = "document" | "voice" | "sticker";

export type CatalogFile = {
  path: string;
  kind: CatalogKind;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  emoji?: string;
};

export type CatalogStickerSet = {
  name: string;
  title: string;
  stickers: CatalogFile[];
};

function oggVoiceBytes(): Buffer {
  // Minimal Ogg page: capture tests only require the OggS signature.
  const header = Buffer.alloc(27);
  header.write("OggS", 0);
  header[5] = 0x02;
  header[26] = 1;
  return Buffer.concat([header, Buffer.from([0x09]), Buffer.from("pomevoice")]);
}

function riffWebpBytes(tag: string): Buffer {
  const payload = Buffer.from(tag);
  const bytes = Buffer.alloc(12 + payload.length);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(4 + payload.length, 4);
  bytes.write("WEBP", 8);
  payload.copy(bytes, 12);
  return bytes;
}

const SAMPLE_FILE: CatalogFile = {
  path: "sample.txt",
  kind: "document",
  filename: "sample.txt",
  mimeType: "text/plain",
  bytes: Buffer.from("pome-telegram-fixture-file\n"),
};

const SAMPLE_VOICE: CatalogFile = {
  path: "voice.ogg",
  kind: "voice",
  filename: "voice.ogg",
  mimeType: "audio/ogg",
  bytes: oggVoiceBytes(),
};

const WAVE_STICKER: CatalogFile = {
  path: "pome_lab/wave.webp",
  kind: "sticker",
  filename: "wave.webp",
  mimeType: "image/webp",
  bytes: riffWebpBytes("wave"),
  emoji: "👋",
};

const OK_STICKER: CatalogFile = {
  path: "pome_lab/ok.webp",
  kind: "sticker",
  filename: "ok.webp",
  mimeType: "image/webp",
  bytes: riffWebpBytes("ok"),
  emoji: "👍",
};

export const TELEGRAM_STICKER_SETS: CatalogStickerSet[] = [
  { name: "pome_lab", title: "Pome Lab", stickers: [WAVE_STICKER, OK_STICKER] },
];

const CATALOG = new Map<string, CatalogFile>(
  [SAMPLE_FILE, SAMPLE_VOICE, WAVE_STICKER, OK_STICKER].map((file) => [file.path, file]),
);

const CATALOG_BY_DIGEST = new Map(
  [...CATALOG.values()].map((file) => [createHash("sha256").update(file.bytes).digest("hex").slice(0, 32), file]),
);

const OPAQUE_FILE_ID = /^file_\d+_[a-f0-9]{8}_[a-f0-9]{32}$/;

export function isOpaqueFileId(value: string): boolean {
  return OPAQUE_FILE_ID.test(value);
}

export function assertSafeMediaPath(value: string): void {
  if (
    /^(?:https?:|file:|attach:\/\/)/i.test(value) ||
    value.includes("\\") ||
    value.includes("..") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    telegramFail(400, 400, "Bad Request: URLs and host file paths are not supported");
  }
  if (value.startsWith("unique_")) {
    telegramFail(400, 400, "Bad Request: file_unique_id cannot be used as a file reference");
  }
}

export function listStickerSets(): Array<{ name: string; title: string; stickers: Array<{ file_path: string; emoji: string }> }> {
  return TELEGRAM_STICKER_SETS.map((set) => ({
    name: set.name,
    title: set.title,
    stickers: set.stickers.map((sticker) => ({ file_path: sticker.path, emoji: sticker.emoji ?? "" })),
  }));
}

function catalogProvenance(fileId: string): CatalogFile | undefined {
  const digest = fileId.split("_").at(-1);
  return digest ? CATALOG_BY_DIGEST.get(digest) : undefined;
}

function assertExpectedKind(file: CatalogFile, expected: CatalogKind): void {
  if (expected === "voice" && file.kind !== "voice") telegramFail(400, 400, "Bad Request: file must be an OGG/OPUS voice note");
  if (expected === "sticker" && file.kind !== "sticker") telegramFail(400, 400, "Bad Request: sticker not found");
}

export function resolveCatalogFile(path: string, expected: CatalogKind): CatalogFile | string {
  assertSafeMediaPath(path);
  const catalog = CATALOG.get(path) ?? (isOpaqueFileId(path) ? catalogProvenance(path) : undefined);
  if (catalog) {
    assertExpectedKind(catalog, expected);
    return CATALOG.has(path) ? catalog : path;
  }
  if (isOpaqueFileId(path)) return path;
  telegramFail(400, 400, expected === "sticker" ? "Bad Request: sticker not found" : "Bad Request: file not found");
}
