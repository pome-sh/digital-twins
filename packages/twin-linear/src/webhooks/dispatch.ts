// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import { linearId } from "../ids.js";
import type { LinearCommands } from "../commands/index.js";
import type { LinearUser, LinearWebhook } from "../types.js";

export type LinearWebhookEvent = {
  type: string;
  action: string;
  data: unknown;
  actor?: LinearUser | null;
  teamId?: string | null;
  url?: string | null;
  updatedFrom?: Record<string, unknown>;
};

export async function dispatchLinearWebhook(
  commands: LinearCommands,
  event: LinearWebhookEvent
): Promise<void> {
  const organization = commands.getOrganization();
  const webhooks = commands.listWebhooks().filter((webhook) => matchesWebhook(commands, webhook, event));

  for (const webhook of webhooks) {
    const deliveryId = linearId();
    const payload = {
      action: event.action,
      type: event.type,
      actor: event.actor
        ? {
            id: event.actor.id,
            name: event.actor.name,
            displayName: event.actor.displayName,
            email: event.actor.email,
          }
        : null,
      data: event.data,
      url: event.url ?? null,
      createdAt: commands.now(),
      organizationId: organization?.id ?? null,
      webhookTimestamp: Date.parse(commands.now()),
      webhookId: webhook.id,
      ...(event.updatedFrom ? { updatedFrom: event.updatedFrom } : {}),
    };
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Accept-Charset": "utf-8",
      "Content-Type": "application/json; charset=utf-8",
      "Linear-Delivery": deliveryId,
      "Linear-Event": event.type,
      "User-Agent": "Linear-Webhook",
    };
    if (webhook.secret) {
      headers["Linear-Signature"] = createHmac("sha256", webhook.secret).update(body).digest("hex");
    }

    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(webhook.url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    commands.recordWebhookDelivery({
      id: deliveryId,
      webhookId: webhook.id,
      event: event.type,
      action: event.action,
      url: webhook.url,
      status,
      error,
      payload,
      headers,
    });
  }
}

function matchesWebhook(
  commands: LinearCommands,
  webhook: LinearWebhook,
  event: LinearWebhookEvent
): boolean {
  if (!webhook.enabled) return false;
  if (!webhook.resourceTypes.includes(event.type) && !webhook.resourceTypes.includes("*")) {
    return false;
  }
  if (webhook.allPublicTeams) {
    if (!event.teamId) return true;
    const team = commands.getTeam(event.teamId);
    return team ? !team.private : true;
  }
  return webhook.teamId === event.teamId;
}
