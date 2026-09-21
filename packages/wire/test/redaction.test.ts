// SPDX-License-Identifier: Apache-2.0
// Telegram credentials must not persist on the tape: bot tokens in paths and
// free text, secret_token bodies, and X-Telegram-Bot-Api-Secret-Token headers.
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redaction.js";

const TELEGRAM_BOT_TOKEN = "123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

describe("redactSecrets — Telegram bot tokens", () => {
  it("replaces the token run in /botTOKEN/sendMessage and keeps the prefix and method", () => {
    expect(redactSecrets(`/bot${TELEGRAM_BOT_TOKEN}/sendMessage`)).toBe("/bot[REDACTED]/sendMessage");
  });

  it("replaces the token run in /file/botTOKEN/photos/x and keeps the prefix and suffix", () => {
    expect(redactSecrets(`/file/bot${TELEGRAM_BOT_TOKEN}/photos/x`)).toBe(
      "/file/bot[REDACTED]/photos/x",
    );
  });

  it("redacts header key X-Telegram-Bot-Api-Secret-Token regardless of case", () => {
    const out = redactSecrets({
      "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
    }) as Record<string, unknown>;
    expect(out["X-Telegram-Bot-Api-Secret-Token"]).toBe("[REDACTED]");
  });

  it("hard-redacts body field secret_token", () => {
    const out = redactSecrets({ secret_token: "webhook-secret", chat_id: 1 }) as Record<
      string,
      unknown
    >;
    expect(out.secret_token).toBe("[REDACTED]");
    expect(out.chat_id).toBe(1);
  });

  it("redacts the token inside a larger JSON string", () => {
    const raw = JSON.stringify({
      url: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      error: `Unauthorized: invalid token ${TELEGRAM_BOT_TOKEN}`,
    });
    const out = redactSecrets(raw) as string;
    expect(out).not.toContain(TELEGRAM_BOT_TOKEN);
    expect(out).toContain("/bot[REDACTED]/sendMessage");
    expect(out).toContain("invalid token [REDACTED]");
  });

  it("redacts a token whose secret run contains hyphens and underscores", () => {
    const token = "123456789:AAH-dqTcvCH1vGWJxfSeofSAs0K5PALD_saw";
    expect(redactSecrets(`/bot${token}/getMe`)).toBe("/bot[REDACTED]/getMe");
  });

  it("redacts a query-encoded colon (%3A / %3a)", () => {
    const secret = "AAH-dqTcvCH1vGWJxfSeofSAs0K5PALD_saw";
    expect(redactSecrets(`https://example.com/hook?token=123456789%3A${secret}`)).toBe(
      "https://example.com/hook?token=[REDACTED]",
    );
    expect(redactSecrets(`https://example.com/hook?token=123456789%3a${secret}`)).toBe(
      "https://example.com/hook?token=[REDACTED]",
    );
    expect(redactSecrets(`https://example.com/hook?token=123456789:${secret}`)).toBe(
      "https://example.com/hook?token=[REDACTED]",
    );
  });

  it("redacts a token that is immediately followed by a query string", () => {
    expect(redactSecrets(`/bot${TELEGRAM_BOT_TOKEN}?offset=1`)).toBe("/bot[REDACTED]?offset=1");
  });

  it("redacts secret_token in a query string", () => {
    expect(redactSecrets("/setWebhook?secret_token=webhook-secret")).toBe(
      "/setWebhook?secret_token=[REDACTED]",
    );
    expect(
      redactSecrets("/setWebhook?url=https://example.com&secret_token=webhook-secret"),
    ).toBe("/setWebhook?url=https://example.com&secret_token=[REDACTED]");
    expect(
      redactSecrets(`/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=https://example.com&secret_token=webhook-secret`),
    ).toBe("/bot[REDACTED]/setWebhook?url=https://example.com&secret_token=[REDACTED]");
  });

  it("redacts secret_token inside a JSON string", () => {
    expect(redactSecrets('{"secret_token":"webhook-secret"}')).toBe(
      '{"secret_token":"[REDACTED]"}',
    );
    expect(redactSecrets('{ "secret_token": "webhook-secret" }')).toBe(
      '{ "secret_token":"[REDACTED]" }',
    );
    expect(redactSecrets("secret_token=webhook-secret")).toBe("secret_token=[REDACTED]");
    const nested = JSON.stringify({ body: '{"secret_token":"webhook-secret"}' });
    expect(redactSecrets(nested)).not.toContain("webhook-secret");
    expect(redactSecrets(nested)).toContain("[REDACTED]");
  });

  it("does not redact a non-token path like /botanic/garden", () => {
    expect(redactSecrets("/botanic/garden")).toBe("/botanic/garden");
  });

  it("does not redact clock times or ports", () => {
    expect(redactSecrets("meet at 12:30 on :8080")).toBe("meet at 12:30 on :8080");
  });
});

describe("redactSecrets — existing credential shapes still scrub", () => {
  it("still redacts ghp_, xoxb-, and sk_test_ runs", () => {
    const ghp = `ghp_${"a".repeat(36)}`;
    const xoxb = `xoxb-${"c".repeat(24)}`;
    const stripe = "sk_test_pome_default";
    expect(redactSecrets(`token ${ghp} and ${xoxb} and ${stripe}`)).toBe(
      "token [REDACTED] and [REDACTED] and [REDACTED]",
    );
  });
});
