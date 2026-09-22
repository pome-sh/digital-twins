// SPDX-License-Identifier: Apache-2.0
import type { TelegramTwinDatabase } from "./db.js";

/** The only webhook transport this twin permits: an injected local test fixture. */
export type TelegramWebhookDelivery = (input: {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}) => Promise<{ status: number }> | { status: number };

export const UPDATE_RETENTION_SEC = 24 * 60 * 60;
export const MAX_WEBHOOK_BATCH = 8;

export type WebhookDrainResult = {
  processed: number;
  nextAttemptAt?: number;
};

/**
 * Process-local coordination is deliberately not state. SQLite owns the queue;
 * this only wakes a long poll or starts a bounded drain after a committed write.
 */
export class TelegramUpdateRuntime {
  private readonly waiters = new Map<number, Set<() => void>>();
  private readonly activePolls = new Set<number>();
  private dispatcher: (() => Promise<WebhookDrainResult>) | undefined;
  private now: () => number = () => Math.floor(Date.now() / 1000);
  private draining = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAt: number | undefined;
  private generation = 0;

  constructor(
    readonly db: TelegramTwinDatabase,
    private delivery: TelegramWebhookDelivery | undefined,
  ) {}

  setDelivery(delivery: TelegramWebhookDelivery | undefined): void {
    this.delivery = delivery;
  }

  getDelivery(): TelegramWebhookDelivery | undefined {
    return this.delivery;
  }

  registerDispatcher(dispatcher: () => Promise<WebhookDrainResult>, now: () => number): void {
    // One domain owns the runtime clock and drain callback for this database.
    // Read-only helper domains (notably auth lookups) must not replace it.
    if (this.dispatcher) return;
    this.dispatcher = dispatcher;
    this.now = now;
    // The SQLite outbox survives process restart; registration is its wakeup.
    // A drain either delivers due rows or arms the earliest durable retry.
    this.scheduleDrain();
  }

  currentGeneration(): number {
    return this.generation;
  }

  isCurrentGeneration(generation: number): boolean {
    return generation === this.generation;
  }

  notify(botId: number): void {
    for (const wake of this.waiters.get(botId) ?? []) wake();
    this.scheduleDrain();
  }

  cancelAll(): void {
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAt = undefined;
    for (const waiters of this.waiters.values()) {
      for (const wake of waiters) wake();
    }
  }

  acquirePoll(botId: number): () => void {
    if (this.activePolls.has(botId)) throw new Error("poll_already_active");
    this.activePolls.add(botId);
    return () => this.activePolls.delete(botId);
  }

  async waitForUpdate(botId: number, timeoutSeconds: number, signal: AbortSignal | undefined): Promise<void> {
    if (timeoutSeconds <= 0 || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.waiters.get(botId)?.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutSeconds * 1000);
      const bucket = this.waiters.get(botId) ?? new Set<() => void>();
      bucket.add(finish);
      this.waiters.set(botId, bucket);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  private scheduleDrain(): void {
    if (this.draining || !this.dispatcher) return;
    this.draining = true;
    const generation = this.generation;
    queueMicrotask(() => {
      void this.dispatcher!().then((result) => {
        this.draining = false;
        // A reset may have replaced every durable row while this delivery was
        // in flight. Start a fresh drain for the new generation only.
        if (!this.isCurrentGeneration(generation)) {
          this.scheduleDrain();
          return;
        }
        // A full pass may have left due rows behind. Schedule one more bounded
        // pass; failed rows have moved into the future and stop this chain.
        if (result.processed >= MAX_WEBHOOK_BATCH) this.scheduleDrain();
        if (result.nextAttemptAt !== undefined) this.scheduleRetry(result.nextAttemptAt);
      }).catch(() => {
        this.draining = false;
      });
    });
  }

  private scheduleRetry(nextAttemptAt: number): void {
    if (this.retryAt !== undefined && this.retryAt <= nextAttemptAt) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryAt = nextAttemptAt;
    const generation = this.generation;
    const delayMs = Math.max(0, nextAttemptAt - this.now()) * 1000;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryAt = undefined;
      if (!this.isCurrentGeneration(generation)) return;
      // A custom clock can remain frozen while host time advances. Do not spin
      // a wall-time retry loop before the durable logical due time.
      if (this.now() < nextAttemptAt) return;
      this.scheduleDrain();
    }, delayMs);
  }
}

const runtimes = new WeakMap<TelegramTwinDatabase, TelegramUpdateRuntime>();

export function telegramUpdateRuntime(
  db: TelegramTwinDatabase,
  delivery?: TelegramWebhookDelivery,
): TelegramUpdateRuntime {
  const current = runtimes.get(db);
  if (current) {
    if (delivery !== undefined) current.setDelivery(delivery);
    return current;
  }
  const runtime = new TelegramUpdateRuntime(db, delivery);
  runtimes.set(db, runtime);
  return runtime;
}

/** True only for a literal loopback host; this never resolves DNS. */
export function isLoopbackWebhookUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.") || host === "[::1]";
  } catch {
    return false;
  }
}

/** No DNS lookup is made: only an exact URL explicitly registered by a test may be loopback. */
export function webhookUrlError(url: string, localFixtures: ReadonlySet<string>): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Bad Request: webhook URL is invalid";
  }
  if (parsed.username || parsed.password || parsed.hash) return "Bad Request: webhook URL is invalid";
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Bad Request: webhook URL must use HTTP or HTTPS";
  }
  const host = parsed.hostname.toLowerCase();
  if (isLoopbackWebhookUrl(url) && !localFixtures.has(url)) {
    return "Bad Request: loopback webhook URLs require an explicit local fixture";
  }
  // Literal private addresses are refused before any transport is selected.
  if (/^(10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "::" || host.startsWith("fc") || host.startsWith("fd")) {
    return "Bad Request: private webhook destination is blocked";
  }
  return undefined;
}
