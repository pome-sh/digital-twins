// SPDX-License-Identifier: Apache-2.0
/**
 * Shared MIME builders for twin-gmail tests (attachments / HTML fixtures).
 * REST write paths remain raw-required — callers must pass `encodeGmailRaw(...)`.
 */
import { composeMime, encodeGmailRaw } from "../src/index.js";

export type TestMimeAttachment = {
  filename: string;
  content: string | Buffer;
  mimeType?: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
};

export type TestMimeOptions = {
  from: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: TestMimeAttachment[];
};

/** Build canonical RFC822 bytes for agent-path / REST fixtures. */
export function buildTestMime(options: TestMimeOptions): Buffer {
  const slug = options.subject.toLowerCase().replace(/\W+/g, "-").replace(/^-|-$/g, "") || "message";
  return composeMime({
    from: options.from,
    to: options.to ?? [],
    cc: options.cc,
    bcc: options.bcc,
    subject: options.subject,
    text: options.text ?? (options.html ? "" : `body for ${options.subject}`),
    html: options.html ?? "",
    date: options.date ?? "2025-01-01T12:00:00.000Z",
    messageId: options.messageId ?? `${slug}@pome-twin.test`,
    inReplyTo: options.inReplyTo,
    references: options.references,
    attachments: options.attachments?.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType ?? "application/octet-stream",
      disposition: attachment.disposition ?? "attachment",
      contentId: attachment.contentId,
      data: Buffer.from(attachment.content).toString("base64"),
    })),
  });
}

/** Base64url `raw` payload for Gmail REST writes (still required by the twin). */
export function buildTestMimeRaw(options: TestMimeOptions): string {
  return encodeGmailRaw(buildTestMime(options));
}

/** HTML + plain alternative with an optional attachment (common agent fixture). */
export function buildHtmlAttachmentMime(
  options: Omit<TestMimeOptions, "html" | "text"> & {
    text?: string;
    htmlBody: string;
    attachment?: TestMimeAttachment;
  }
): Buffer {
  return buildTestMime({
    ...options,
    text: options.text ?? options.htmlBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
    html: options.htmlBody,
    attachments: options.attachment ? [options.attachment] : options.attachments,
  });
}
