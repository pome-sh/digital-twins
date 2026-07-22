// SPDX-License-Identifier: Apache-2.0
import { badUserInput } from "./errors.js";

/** Returns an error message when the URL is not a safe webhook destination, else null. */
export function webhookUrlError(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Invalid webhook URL: ${url}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Webhook URL must use http or https: ${url}`;
  }
  if (parsed.username || parsed.password) {
    return `Webhook URL must not include credentials`;
  }
  return null;
}

export function assertWebhookUrl(url: string): string {
  const error = webhookUrlError(url);
  if (error) badUserInput(error);
  return url;
}
