// SPDX-License-Identifier: Apache-2.0
import type { Context } from "hono";
import type { SessionValue } from "@pome-sh/sdk/server";
import { GmailError, invalidArgument, unsupported } from "./errors.js";
import { resolveUserEmail } from "./identity.js";
import {
  decodePageToken,
  encodePageToken,
  normalizeListBinding,
} from "./page-tokens.js";

export type MessageFormat = "minimal" | "full" | "raw" | "metadata";
export type JsonObject = Record<string, unknown>;

export { normalizeListBinding };

/**
 * The mailbox this request speaks for.
 *
 * `userId` arrives already parsed by the route's declaration; the session is
 * identity, not a route input, so reading it here stays legal.
 */
export function emailFrom(userId: string, c: Context): string {
  return resolveUserEmail(userId, c.get("session") as SessionValue | undefined);
}

export function stringField(body: JsonObject, name: string, required = false): string | undefined {
  const value = body[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && value.length === 0)) invalidArgument(`Invalid ${name}`);
  return value;
}

export function stringArray(body: JsonObject, name: string, limit = 100): string[] {
  const value = body[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit || value.some((item) => typeof item !== "string")) {
    invalidArgument(`Invalid ${name}`);
  }
  return [...new Set(value as string[])];
}

/**
 * `?deleted=true` and friends: query params the twin ACCEPTS and then refuses,
 * so they are declared inputs rather than silently ignored ones. Insertion
 * order decides which flag answers first, as the old name list did.
 */
export function rejectUnsupportedFlags(flags: Record<string, boolean>): void {
  for (const [name, value] of Object.entries(flags)) {
    if (value) unsupported(`${name}=true is not supported by the Gmail twin`);
  }
}

/** `?uploadType=resumable` is accepted, then refused. */
export function rejectResumable(uploadType: string | undefined): void {
  if (uploadType === "resumable") unsupported("Resumable Gmail uploads are not supported");
}

export function rejectClassification(body: {
  addClassificationLabels?: unknown;
  removeClassificationLabelIds?: unknown;
}): void {
  if (body.addClassificationLabels !== undefined || body.removeClassificationLabelIds !== undefined) {
    unsupported("Gmail classification labels require Google Drive Labels and are not supported");
  }
}

/** The Message-resource half of the same refusal. */
export function rejectClassificationValues(resource: { classificationLabelValues?: unknown }): void {
  if (resource.classificationLabelValues !== undefined) {
    unsupported("Gmail classification labels require Google Drive Labels and are not supported");
  }
}

export function paginate<T>(
  items: T[],
  options: { maxResults: number; pageToken?: string; binding: string; snapshot: string }
): { page: T[]; nextPageToken?: string } {
  const offset = options.pageToken
    ? decodePageToken(options.pageToken, options.binding, options.snapshot)
    : 0;
  if (offset > items.length) invalidArgument("Invalid page token");
  const page = items.slice(offset, offset + options.maxResults);
  const nextOffset = offset + page.length;
  return {
    page,
    ...(nextOffset < items.length
      ? { nextPageToken: encodePageToken(nextOffset, options.binding, options.snapshot) }
      : {}),
  };
}

export function asInputError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof GmailError) throw error;
    invalidArgument(error instanceof Error ? error.message : "Invalid request");
  }
}
