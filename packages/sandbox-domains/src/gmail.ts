// SPDX-License-Identifier: Apache-2.0
//
// Gmail — the domain runtime pome-cloud boots in-process. See `./github.ts` for
// why the domain and the opener come through the twin's package root while the
// seed and the vocabulary come through narrow subpaths.
export { GmailDomain } from "@pome-sh/twin-gmail";
export { openGmailTwinDatabase, migrate, resetDatabase } from "@pome-sh/twin-gmail";
export type { DraftResource, FilterResource, LabelResource } from "@pome-sh/twin-gmail";
export type {
  GmailIdentity,
  GmailStateSeed,
  GmailTwinDatabase,
  SeedAttachment,
  SeedDraft,
  SeedFilter,
  SeedLabel,
  SeedMailbox,
  SeedMessage,
  SemanticMessage,
} from "@pome-sh/twin-gmail";

export { defaultSeedState, gmailSeedSchema, parseSeed } from "@pome-sh/twin-gmail/seed";
export type { ParsedGmailStateSeed } from "@pome-sh/twin-gmail/seed";

export { GMAIL_CHECKS } from "@pome-sh/twin-gmail/checks";
export type { Check } from "@pome-sh/twin-gmail/checks";
export type {
  GmailCheckState,
  GmailCheckStateDraft,
  GmailCheckStateLabel,
  GmailCheckStateMailbox,
  GmailCheckStateMessage,
  GmailCheckStateMessageLabel,
} from "@pome-sh/twin-gmail/checks";
