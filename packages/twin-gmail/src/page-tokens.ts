// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GmailError, invalidArgument } from "./errors.js";

const TOKEN_VERSION = 1;

/** Process-local fallback when neither page-token nor auth secret is configured. */
let ephemeralSecret: string | undefined;

/**
 * Resolve the HMAC key for opaque page tokens.
 *
 * Order: `POME_GMAIL_PAGE_TOKEN_SECRET` → derived from `TWIN_AUTH_SECRET` →
 * per-process ephemeral secret. Never fall back to a forgeable public default
 * string (that would let cross-mailbox tokens verify under a known key).
 */
export function resolvePageTokenSecret(
  env: NodeJS.ProcessEnv = process.env
): string {
  if (env.POME_GMAIL_PAGE_TOKEN_SECRET) return env.POME_GMAIL_PAGE_TOKEN_SECRET;
  if (env.TWIN_AUTH_SECRET) {
    return createHash("sha256")
      .update(`pome-gmail-page-token:${env.TWIN_AUTH_SECRET}`)
      .digest("hex");
  }
  ephemeralSecret ??= randomBytes(32).toString("hex");
  return ephemeralSecret;
}

export function encodePageToken(
  offset: number,
  binding: string,
  snapshot: string,
  secret: string = resolvePageTokenSecret()
): string {
  const payload = Buffer.from(
    JSON.stringify({ v: TOKEN_VERSION, o: offset, b: binding, s: snapshot }),
    "utf8"
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function decodePageToken(
  token: string,
  binding: string,
  snapshot: string,
  secret: string = resolvePageTokenSecret()
): number {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) invalidArgument("Invalid page token");
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    invalidArgument("Invalid page token");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    invalidArgument("Invalid page token");
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: unknown;
      o?: unknown;
      b?: unknown;
      s?: unknown;
    };
    if (
      parsed.v !== TOKEN_VERSION ||
      parsed.b !== binding ||
      parsed.s !== snapshot ||
      !Number.isInteger(parsed.o) ||
      (parsed.o as number) < 0
    ) {
      invalidArgument("Invalid page token");
    }
    return parsed.o as number;
  } catch (error) {
    if (error instanceof GmailError) throw error;
    invalidArgument("Invalid page token");
  }
}

export function normalizeListBinding(
  route: string,
  email: string,
  values: Record<string, unknown>
): string {
  const canonical = Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]);
  return createHash("sha256")
    .update(JSON.stringify([route, email.toLowerCase(), canonical]))
    .digest("hex");
}
