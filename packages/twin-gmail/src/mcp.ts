// SPDX-License-Identifier: Apache-2.0
// The two VALUES come from `@pome-sh/sdk/mcp-tool-fixture`, not the root barrel:
// the barrel re-exports `openTwinDatabase`, so importing it EXECUTES `db.ts`'s
// `import { DatabaseSync } from "node:sqlite"` and this module stops loading in
// any runtime without that builtin (bun, which is what pome-cloud's
// fidelity-watch runs). `ToolCallContext`/`ToolSpec` stay on the root as
// `import type` — erased before emit, so they carry no runtime edge.
import {
  deriveMcpToolTable,
  loadMcpToolFixture,
  type McpToolImplementation,
} from "@pome-sh/sdk/mcp-tool-fixture";
import type { ToolCallContext, ToolSpec } from "@pome-sh/sdk";
import { z } from "zod";
import metaListing from "../fixtures/mcp-tools-list.meta.json" with { type: "json" };
import rawListing from "../fixtures/mcp-tools-list.raw.json" with { type: "json" };
// `import type`: `GmailDomain` appears only in handler signatures here, and the
// domain barrel reaches `db.ts` -> the sdk root -> `node:sqlite`. tsc and bun
// both elide it today because nothing uses it as a value — spelling that out
// keeps it true if someone later does.
import type { GmailDomain, LabelResource } from "./domain/index.js";
import { invalidArgument } from "./errors.js";
import { identityFromSession } from "./identity.js";
import {
  createDraftInputSchema,
  createLabelInputSchema,
  getMessageInputSchema,
  getThreadInputSchema,
  listDraftsInputSchema,
  listLabelsInputSchema,
  mcpOutputSchemas,
  messageLabelsInputSchema,
  searchThreadsInputSchema,
  sensitiveMessageLabelInputSchema,
  sensitiveThreadLabelInputSchema,
  threadLabelsInputSchema,
  type CreateDraftInput,
  type CreateLabelInput,
  type GetMessageInput,
  type GetThreadInput,
  type ListDraftsInput,
  type MessageLabelsInput,
  type SearchThreadsInput,
  type SensitiveMessageLabelInput,
  type SensitiveThreadLabelInput,
  type ThreadLabelsInput,
} from "./mcp-schemas.js";
import {
  decodePageToken,
  encodePageToken,
  normalizeListBinding,
} from "./page-tokens.js";
import { gmailStateDelta } from "./state.js";
import type { SemanticMessage } from "./types.js";

type ToolName = keyof typeof mcpOutputSchemas;
type ToolImplementation = {
  schema: z.ZodType;
  mutation: boolean;
  handler: (
    domain: GmailDomain,
    args: Record<string, unknown>,
    ctx: ToolCallContext
  ) => unknown;
  contentText?: (value: unknown) => string;
};

/**
 * The tool table Gmail serves, and its provenance. `loadMcpToolFixture`
 * throws at module load if `mcp-tools-list.raw.json` no longer hashes to the
 * sha its meta declares, so an edited oracle cannot quietly become the new
 * truth (F-1325).
 */
export const gmailToolFixture = loadMcpToolFixture({
  raw: rawListing,
  meta: metaListing,
});

const implementations: Record<ToolName, ToolImplementation> = {
  create_draft: {
    schema: createDraftInputSchema,
    mutation: true,
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as CreateDraftInput;
        const email = identityFromSession(ctx.session).email;
        const draft = domain.createComposedDraft(email, {
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text: input.body,
          html: input.htmlBody,
          replyToMessageId: input.replyToMessageId,
          attachments: input.attachments?.map((attachment, index) => ({
            filename: attachment.filename ?? "",
            mimeType: attachment.mimeType,
            disposition: attachment.inline ? "inline" : "attachment",
            contentId: attachment.inline
              ? (attachment.contentId ?? attachment.filename ?? attachment.id ?? `inline-${index + 1}`)
              : undefined,
            data: attachment.content,
          })),
        });
        return draftResult(draft.id, draft.message, false);
      }),
  },
  list_drafts: {
    schema: listDraftsInputSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as ListDraftsInput;
      const email = identityFromSession(ctx.session).email;
      const drafts = domain.listDrafts(email, input.query ?? "");
      const page = paginate(domain, email, "drafts.list", drafts, input.pageSize, input.pageToken, {
        query: input.query ?? "",
        view: input.view ?? "DRAFT_VIEW_FULL",
      });
      return {
        drafts: page.items.map((draft) =>
          draftResult(
            draft.id,
            draft.message,
            input.view === "DRAFT_VIEW_METADATA_ONLY"
          )
        ),
        ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      };
    },
  },
  get_thread: {
    schema: getThreadInputSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as GetThreadInput;
      const email = identityFromSession(ctx.session).email;
      return threadResult(
        domain.getThread(email, input.threadId),
        normalizeMessageFormat(input.messageFormat)
      );
    },
  },
  get_message: {
    schema: getMessageInputSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as GetMessageInput;
      const email = identityFromSession(ctx.session).email;
      return messageResult(
        domain.getMessage(email, input.messageId),
        normalizeMessageFormat(input.messageFormat)
      );
    },
  },
  search_threads: {
    schema: searchThreadsInputSchema,
    mutation: false,
    handler: (domain, args, ctx) => {
      const input = args as SearchThreadsInput;
      const email = identityFromSession(ctx.session).email;
      const threads = domain.searchThreads(email, input.query ?? "", {
        includeTrash: input.includeTrash,
      });
      const page = paginate(domain, email, "threads.search", threads, input.pageSize, input.pageToken, {
        includeTrash: input.includeTrash ?? false,
        query: input.query ?? "",
        view: input.view ?? "THREAD_VIEW_MINIMAL",
      });
      return {
        threads: page.items.map((thread) =>
          threadResult(
            thread,
            input.view === "THREAD_VIEW_METADATA_ONLY" ? "metadata" : "minimal"
          )
        ),
        // `threads` above is the PAGE; this is the whole match set, which is
        // why the count is exact rather than an estimate. Google documents the
        // field as a lower bound, so an exact count satisfies the contract —
        // and the advertised type is int64-as-STRING, not a number (F-1417).
        // Unconditional: it is the answer to "how many matched", and 0 matches
        // is an answer. Emitting it only when non-zero would make an absent
        // field mean two different things.
        resultCountEstimate: String(threads.length),
        ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      };
    },
  },
  label_thread: labelThreadImplementation(true),
  unlabel_thread: labelThreadImplementation(false),
  apply_sensitive_thread_label: {
    schema: sensitiveThreadLabelInputSchema,
    mutation: true,
    contentText: () => "OK",
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as SensitiveThreadLabelInput;
        const label = resolveSensitiveLabel(input.labelOption);
        const other = label === "TRASH" ? "SPAM" : "TRASH";
        domain.modifyThreadLabels(
          identityFromSession(ctx.session).email,
          input.threadId,
          [label],
          ["INBOX", other]
        );
        return {};
      }),
  },
  list_labels: {
    schema: listLabelsInputSchema,
    mutation: false,
    // "Lists all labels available in the authenticated user's Gmail account."
    // ALL of them, system included, and in one answer — the adopted listing
    // takes no page arguments and offers no nextPageToken back. The July
    // listing this twin used to serve said "all user-defined labels", which is
    // what `listUserLabels` returns and what this handler used to call; the
    // widening is Google's and F-1400 is the twin following it.
    handler: (domain, _args, ctx) => ({
      labels: domain.labels(identityFromSession(ctx.session).email).map(labelResult),
    }),
  },
  label_message: labelMessageImplementation(true),
  unlabel_message: labelMessageImplementation(false),
  apply_sensitive_message_label: {
    schema: sensitiveMessageLabelInputSchema,
    mutation: true,
    contentText: () => "OK",
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as SensitiveMessageLabelInput;
        const label = resolveSensitiveLabel(input.labelOption);
        const other = label === "TRASH" ? "SPAM" : "TRASH";
        domain.modifyMessageLabels(
          identityFromSession(ctx.session).email,
          input.messageId,
          [label],
          ["INBOX", other]
        );
        return {};
      }),
  },
  create_label: {
    schema: createLabelInputSchema,
    mutation: true,
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as CreateLabelInput;
        const email = identityFromSession(ctx.session).email;
        if (input.autoCreateParentLabels !== false) {
          const parts = input.displayName.split("/");
          for (let index = 1; index < parts.length; index += 1) {
            const parent = parts.slice(0, index).join("/");
            const exists = domain
              .listUserLabels(email)
              .some((label) => label.name.toLowerCase() === parent.toLowerCase());
            if (!exists) domain.createLabel(email, parent);
          }
        }
        const created = domain.createLabel(email, input.displayName, input.color);
        return labelResult(domain.label(email, created.id));
      }),
  },
};

/**
 * Every Gmail handler's return value is parsed against the tool's own
 * `outputSchema` before it reaches the wire, so a handler cannot answer a
 * shape the listing does not advertise.
 */
const validatedImplementations = Object.fromEntries(
  Object.entries(implementations).map(([name, implementation]) => [
    name,
    {
      ...implementation,
      handler: (domain: GmailDomain, args: Record<string, unknown>, ctx: ToolCallContext) =>
        mcpOutputSchemas[name as ToolName].parse(implementation.handler(domain, args, ctx)),
    },
  ])
) as Record<string, McpToolImplementation<GmailDomain>>;

export const gmailTools: ToolSpec<GmailDomain>[] = deriveMcpToolTable(
  gmailToolFixture,
  validatedImplementations,
  { includeIsError: true }
);

function labelThreadImplementation(add: boolean): ToolImplementation {
  return {
    schema: threadLabelsInputSchema,
    mutation: true,
    contentText: () => "OK",
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as ThreadLabelsInput;
        domain.modifyThreadLabels(
          identityFromSession(ctx.session).email,
          input.threadId,
          add ? input.labelIds : [],
          add ? [] : input.labelIds
        );
        return {};
      }),
  };
}

function labelMessageImplementation(add: boolean): ToolImplementation {
  return {
    schema: messageLabelsInputSchema,
    mutation: true,
    contentText: () => "OK",
    handler: (domain, args, ctx) =>
      mutate(domain, ctx, () => {
        const input = args as MessageLabelsInput;
        domain.modifyMessageLabels(
          identityFromSession(ctx.session).email,
          input.messageId,
          add ? input.labelIds : [],
          add ? [] : input.labelIds
        );
        return {};
      }),
  };
}

function mutate<T>(domain: GmailDomain, ctx: ToolCallContext, operation: () => T): T {
  const before = domain.exportState();
  const output = operation();
  ctx.reportDelta(gmailStateDelta(before, domain.exportState()));
  return output;
}

function draftResult(id: string, message: SemanticMessage, metadataOnly: boolean) {
  return {
    id,
    threadId: message.threadId,
    toRecipients: message.to,
    ccRecipients: message.cc,
    bccRecipients: message.bcc,
    date: dateOnly(message.internalDate),
    ...(!metadataOnly
      ? {
          subject: message.subject,
          plaintextBody: message.text,
          ...(message.html ? { htmlBody: message.html } : {}),
        }
      : {}),
  };
}

function threadResult(
  thread: { id: string; messages: SemanticMessage[] },
  format: "metadata" | "minimal" | "full"
) {
  return {
    id: thread.id,
    messages: thread.messages.map((message) => messageResult(message, format)),
  };
}

function messageResult(
  message: SemanticMessage,
  format: "metadata" | "minimal" | "full"
) {
  const metadata = {
    id: message.id,
    labelIds: message.labelIds,
    date: dateOnly(message.internalDate),
  };
  if (format === "metadata") return metadata;
  const minimal = {
    ...metadata,
    snippet: message.snippet,
    subject: message.subject,
    sender: message.from,
    toRecipients: message.to,
    ccRecipients: message.cc,
    // F-1400: the adopted listing declares it on Message, so it is served
    // wherever the other two recipient lists are — `get_message`, `get_thread`
    // and the threads `search_threads` nests.
    bccRecipients: message.bcc,
  };
  if (format === "minimal") return minimal;
  return {
    ...minimal,
    plaintextBody: message.text,
    ...(message.html ? { htmlBody: message.html } : {}),
    attachmentIds: message.attachments.map((attachment) => attachment.id),
    ...(message.attachments.length
      ? {
          attachments: message.attachments.map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
          })),
        }
      : {}),
  };
}

/**
 * The listing's `Label`, and only its fields — `LabelResource` also carries the
 * twin's own `type`, which Google's schema does not declare and the output
 * validator would pass through unnoticed.
 */
function labelResult(label: LabelResource) {
  const color = {
    ...(label.textColor ? { textColor: label.textColor } : {}),
    ...(label.backgroundColor ? { backgroundColor: label.backgroundColor } : {}),
  };
  return {
    labelId: label.id,
    name: label.name,
    ...(Object.keys(color).length > 0 ? { color } : {}),
    // F-1400: the August listing declares the message counters beside the
    // thread ones. The domain has counted both all along — the REST
    // serializer already published all four — so this was a projection that
    // dropped two fields, not a measurement the twin could not make.
    messagesTotal: label.messagesTotal,
    messagesUnread: label.messagesUnread,
    threadsTotal: label.threadsTotal,
    threadsUnread: label.threadsUnread,
  };
}

function normalizeMessageFormat(
  format: GetThreadInput["messageFormat"] | GetMessageInput["messageFormat"]
): "metadata" | "minimal" | "full" {
  if (format === "METADATA_ONLY") return "metadata";
  if (format === "MINIMAL") return "minimal";
  return "full";
}

function resolveSensitiveLabel(
  option: SensitiveThreadLabelInput["labelOption"] | SensitiveMessageLabelInput["labelOption"]
): "TRASH" | "SPAM" {
  if (option === "TRASH" || option === "SPAM") return option;
  invalidArgument("labelOption must be TRASH or SPAM");
}

function paginate<T>(
  domain: GmailDomain,
  email: string,
  route: string,
  items: T[],
  requestedSize: number | undefined,
  token: string | undefined,
  filter: Record<string, unknown>
): { items: T[]; nextPageToken?: string } {
  const size = requestedSize ?? 20;
  const snapshot = domain.currentHistoryIdFor(email);
  const binding = normalizeListBinding(route, email, filter);
  const offset = token ? decodePageToken(token, binding, snapshot) : 0;
  if (offset > items.length) invalidArgument("Invalid pageToken");
  const page = items.slice(offset, offset + size);
  const nextOffset = offset + page.length;
  return {
    items: page,
    ...(nextOffset < items.length
      ? { nextPageToken: encodePageToken(nextOffset, binding, snapshot) }
      : {}),
  };
}

function dateOnly(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
