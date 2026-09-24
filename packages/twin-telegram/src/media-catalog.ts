// SPDX-License-Identifier: Apache-2.0
//
// In-memory fixture catalog for user-MCP send paths. file_path arguments
// resolve here or as an already-stored opaque file_id. The twin never reads
// or writes the host filesystem.
import { createHash } from "node:crypto";
import { telegramFail } from "./errors.js";

export type CatalogKind = "document" | "voice" | "sticker" | "photo";

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

// Verified decode: ffprobe Opus, Pillow WEBP 2x2. Do not replace with
// signature-only placeholders — downloaded bytes must actually parse.
const VOICE_OGG = Buffer.from(
  "T2dnUwACAAAAAAAAAABFfWCbAAAAAIQWg24BE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAEV9YJsBAAAA06V8TgE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMgEAAAAdAAAAZW5jb2Rlcj1MYXZjNjIuMjguMTAyIGxpYm9wdXNPZ2dTAASYCgAAAAAAAEV9YJsCAAAAhT4ungMDAwP4//74//74//4=",
  "base64",
);
const WAVE_WEBP = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAIAAUAmJaQAA3AA/vz0AAA=", "base64");
const OK_WEBP = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoCAAIAAUAmJaQAA3AA/v02aAA=", "base64");
const PHOTO_WEBP = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQqEIUtP+BiOh/AAA=", "base64");

const SAMPLE_PHOTO: CatalogFile = {
  path: "photo.webp",
  kind: "photo",
  filename: "photo.webp",
  mimeType: "image/webp",
  bytes: PHOTO_WEBP,
};

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
  bytes: VOICE_OGG,
};

const WAVE_STICKER: CatalogFile = {
  path: "pome_lab/wave.webp",
  kind: "sticker",
  filename: "wave.webp",
  mimeType: "image/webp",
  bytes: WAVE_WEBP,
  emoji: "👋",
};

const OK_STICKER: CatalogFile = {
  path: "pome_lab/ok.webp",
  kind: "sticker",
  filename: "ok.webp",
  mimeType: "image/webp",
  bytes: OK_WEBP,
  emoji: "👍",
};

export const TELEGRAM_STICKER_SETS: CatalogStickerSet[] = [
  { name: "pome_lab", title: "Pome Lab", stickers: [WAVE_STICKER, OK_STICKER] },
];

const CATALOG = new Map<string, CatalogFile>(
  [SAMPLE_FILE, SAMPLE_VOICE, SAMPLE_PHOTO, WAVE_STICKER, OK_STICKER].map((file) => [file.path, file]),
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

/** Chat photos accept the fixture catalog or an owned opaque file_id. No host path. */
export function resolveChatPhoto(path: string): CatalogFile | string {
  assertSafeMediaPath(path);
  const catalog = CATALOG.get(path) ?? (isOpaqueFileId(path) ? catalogProvenance(path) : undefined);
  if (catalog) {
    if (catalog.kind !== "photo") telegramFail(400, 400, "Bad Request: file must be a photo");
    return CATALOG.has(path) ? catalog : path;
  }
  if (isOpaqueFileId(path)) return path;
  telegramFail(400, 400, "Bad Request: file not found");
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
