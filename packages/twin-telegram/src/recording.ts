// SPDX-License-Identifier: Apache-2.0
// MCP `download_media` returns `{ result: JSON.stringify({ ..., content_base64 }) }`.
// Shared redaction does not decode that envelope, so this projection replaces
// downloaded bytes with `{ sha256, size }` before the tape is stored.
import { createHash } from "node:crypto";
import type { RecorderEvent } from "@pome-sh/sdk";

export type BinaryProjection = { sha256: string; size: number };

export function projectTelegramRecording(event: RecorderEvent): RecorderEvent {
  return {
    ...event,
    request_body: projectValue(event.request_body),
    response_body: projectValue(event.response_body),
    state_delta: projectValue(event.state_delta) as RecorderEvent["state_delta"],
    error: projectValue(event.error) as RecorderEvent["error"],
  };
}

function projectValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => projectValue(item, key));
  if (!value || typeof value !== "object") {
    if (key === "content_base64" && typeof value === "string") return digestBase64(value);
    if (key === "result" && typeof value === "string") return projectResultString(value);
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = projectValue(child, childKey);
  }
  return out;
}

function projectResultString(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && typeof (parsed as { content_base64?: unknown }).content_base64 === "string"
    ) {
      const record = parsed as Record<string, unknown>;
      return JSON.stringify({ ...record, content_base64: digestBase64(record.content_base64 as string) });
    }
  } catch {
    // Leave non-JSON result strings untouched.
  }
  return value;
}

function digestBase64(value: string): BinaryProjection {
  const bytes = Buffer.from(value, "base64");
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}
