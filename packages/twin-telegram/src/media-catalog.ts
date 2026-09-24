// SPDX-License-Identifier: Apache-2.0
//
// In-memory fixture catalog for user-MCP send paths. file_path arguments
// resolve here or as an already-stored opaque file_id. The twin never reads
// or writes the host filesystem.
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
  bytes: Buffer.from("OggS-pome-telegram-fixture-voice"),
};

const WAVE_STICKER: CatalogFile = {
  path: "pome_lab/wave.webp",
  kind: "sticker",
  filename: "wave.webp",
  mimeType: "image/webp",
  bytes: Buffer.from("WEBP-pome-lab-wave"),
  emoji: "👋",
};

const OK_STICKER: CatalogFile = {
  path: "pome_lab/ok.webp",
  kind: "sticker",
  filename: "ok.webp",
  mimeType: "image/webp",
  bytes: Buffer.from("WEBP-pome-lab-ok"),
  emoji: "👍",
};

export const TELEGRAM_STICKER_SETS: CatalogStickerSet[] = [
  { name: "pome_lab", title: "Pome Lab", stickers: [WAVE_STICKER, OK_STICKER] },
];

const CATALOG = new Map<string, CatalogFile>(
  [SAMPLE_FILE, SAMPLE_VOICE, WAVE_STICKER, OK_STICKER].map((file) => [file.path, file]),
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

export function resolveCatalogFile(path: string, expected: CatalogKind): CatalogFile | string {
  assertSafeMediaPath(path);
  if (isOpaqueFileId(path)) return path;
  const file = CATALOG.get(path);
  if (!file) telegramFail(400, 400, expected === "sticker" ? "Bad Request: sticker not found" : "Bad Request: file not found");
  if (expected === "voice" && file.kind !== "voice") telegramFail(400, 400, "Bad Request: file must be an OGG/OPUS voice note");
  if (expected === "sticker" && file.kind !== "sticker") telegramFail(400, 400, "Bad Request: sticker not found");
  return file;
}
