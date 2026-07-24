// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { GmailError } from "./errors.js";
import type { GmailTwinDatabase } from "./types.js";

// Named, reusable fault-injection primitives. A seed lists faults by NAME; the
// name is teaching vocabulary. Default seeds carry none, so faults are strictly
// opt-in (mirrors twin-linear `strictScopes`). Extend KNOWN_FAULT_NAMES to add
// a primitive.
const KNOWN_FAULT_NAMES = ["rate-limited"] as const;

export const gmailFaultSchema = z
  .object({
    name: z.enum(KNOWN_FAULT_NAMES),
    target: z.string().min(1).max(128).default("messages.send"),
    succeedFirst: z.number().int().nonnegative().max(1000).default(2),
    throttleFor: z.number().int().positive().max(1000).default(3),
    retryAfterSeconds: z.number().int().positive().max(3600).default(1),
  })
  .strict();

export type GmailFault = z.output<typeof gmailFaultSchema>;

/**
 * Increment the per-operation call counter and, if a `rate-limited` fault is
 * armed for `operation`, throw a 429 during the throttle window. Deterministic
 * and clock-free: calls 1..succeedFirst pass, the next `throttleFor` calls
 * throw, every call after passes. EVERY matching call (including throttled
 * ones) advances the counter, so an agent that retries with backoff clears the
 * window while one that doesn't leaves those sends undelivered.
 */
export function checkFault(db: GmailTwinDatabase, operation: string): void {
  const fault = readFaults(db).find((f) => f.target === operation);
  if (!fault) return;
  const calls = bumpFaultCounter(db, operation);
  if (calls > fault.succeedFirst && calls <= fault.succeedFirst + fault.throttleFor) {
    throw new GmailError(
      429,
      "rateLimitExceeded",
      `Rate limit exceeded for ${operation}. Retry after ${fault.retryAfterSeconds}s.`,
    );
  }
}

function readFaults(db: GmailTwinDatabase): GmailFault[] {
  const row = db.prepare("SELECT value FROM gmail_config WHERE key = 'faults'").get() as
    | { value: string }
    | undefined;
  if (!row) return [];
  try {
    return JSON.parse(row.value) as GmailFault[];
  } catch {
    return [];
  }
}

function bumpFaultCounter(db: GmailTwinDatabase, operation: string): number {
  db.prepare(
    "INSERT INTO fault_counters(operation, calls) VALUES (?, 1) " +
      "ON CONFLICT(operation) DO UPDATE SET calls = calls + 1",
  ).run(operation);
  const row = db.prepare("SELECT calls FROM fault_counters WHERE operation = ?").get(operation) as {
    calls: number;
  };
  return row.calls;
}
