// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
// Note: all runtime ids use the deterministic counter (`linearIdFromCounter`);
// there is intentionally no random id generator for domain entities.

/** Deterministic uuid-like id from a namespace + counter (seed / logical clock). */
export function linearIdFromCounter(namespace: string, counter: number): string {
  const digest = createHash("sha256").update(`${namespace}:${counter}`).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

export function token(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
