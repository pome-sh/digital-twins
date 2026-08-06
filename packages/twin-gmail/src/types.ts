// SPDX-License-Identifier: Apache-2.0
// `@pome-sh/sdk/db` rather than the `@pome-sh/sdk` root, for the same reason
// `seed.ts` uses `@pome-sh/sdk/failure-injection`: this module is vendored into
// `@pome-sh/checks`'s published declarations, and the sdk ROOT's `.d.ts` pulls the
// whole engine's type surface with it — `hono`, the DOM `Response`, the auth
// module. `db.d.ts` is one self-contained interface file with no imports at all.
import type { TwinDatabase } from "@pome-sh/sdk/db";

export type GmailTwinDatabase = TwinDatabase;
export type DeliveryMode = "sender-only" | "seeded-mailboxes";

export type SeedLabel = {
  id?: string;
  name: string;
  color?: { textColor?: string; backgroundColor?: string };
};

export type SeedAttachment = {
  filename: string;
  mimeType?: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
  data: string;
};

export type SeedMessage = {
  id?: string;
  threadId?: string;
  raw?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  labels?: string[];
  attachments?: SeedAttachment[];
};

export type SeedDraft = Omit<SeedMessage, "labels"> & {
  id?: string;
};

export type SeedFilter = {
  id?: string;
  criteria?: {
    from?: string;
    to?: string;
    subject?: string;
    query?: string;
    negatedQuery?: string;
    hasAttachment?: boolean;
    excludeChats?: boolean;
    size?: number;
    sizeComparison?: "larger" | "smaller";
  };
  action?: {
    addLabelIds?: string[];
    removeLabelIds?: string[];
    forward?: string;
  };
};

export type SeedSendAs = {
  sendAsEmail: string;
  displayName?: string;
  replyToAddress?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  verificationStatus?: "accepted" | "pending";
};

export type SeedMailbox = {
  email: string;
  displayName?: string;
  labels?: SeedLabel[];
  messages?: SeedMessage[];
  drafts?: SeedDraft[];
  filters?: SeedFilter[];
  forwardingAddresses?: Array<{
    forwardingEmail: string;
    verificationStatus?: "accepted" | "pending";
  }>;
  sendAs?: SeedSendAs[];
};

export type GmailStateSeed = {
  primaryMailbox: SeedMailbox;
  mailboxes?: SeedMailbox[];
  deliveryMode?: DeliveryMode;
  clock?: string;
  faults?: import("./faults.js").GmailFault[];
};

export type MessageRow = {
  mailbox_id: number;
  id: string;
  thread_id: string;
  rfc_message_id: string;
  internal_date: number;
  sent_at: string;
  from_address: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  delivered_to: string;
  subject: string;
  normalized_subject: string;
  snippet: string;
  text_body: string;
  html_body: string;
  headers_json: string;
  size_estimate: number;
};

export type DraftRow = {
  mailbox_id: number;
  id: string;
  message_id: string;
  created_at: string;
  updated_at: string;
};

export type HistoryEvent = {
  id: string;
  mailboxEmail: string;
  messageId: string | null;
  threadId: string | null;
  type: string;
  labelIds: string[];
  timestamp: string;
};

export type GmailIdentity = {
  email: string;
};

export type SemanticMessage = {
  id: string;
  threadId: string;
  rfcMessageId: string;
  internalDate: number;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  snippet: string;
  text: string;
  html: string;
  sizeEstimate: number;
  labelIds: string[];
  attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    disposition: string;
    contentId: string | null;
    sha256: string;
    size: number;
  }>;
};
