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

/**
 * Process-local coordination is deliberately not state. SQLite owns the queue;
 * this only wakes a long poll or starts a bounded drain after a committed write.
 */
export class TelegramUpdateRuntime {
  private readonly waiters = new Map<number, Set<() => void>>();
  private readonly activePolls = new Set<number>();
  private dispatcher: (() => Promise<number>) | undefined;
  private draining = false;

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

  registerDispatcher(dispatcher: () => Promise<number>): void {
    this.dispatcher = dispatcher;
  }

  notify(botId: number): void {
    for (const wake of this.waiters.get(botId) ?? []) wake();
    this.scheduleDrain();
  }

  cancelAll(): void {
    for (const botId of this.waiters.keys()) this.notify(botId);
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
    queueMicrotask(() => {
      void this.dispatcher!().then((processed) => {
        this.draining = false;
        // A full pass may have left due rows behind. Schedule one more bounded
        // pass; failed rows have moved into the future and stop this chain.
        if (processed >= MAX_WEBHOOK_BATCH) this.scheduleDrain();
      }).catch(() => {
        this.draining = false;
      });
    });
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
