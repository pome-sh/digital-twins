// SPDX-License-Identifier: Apache-2.0
import type { DeclarableRouter } from "@pome-sh/sdk/route-inputs";
import {
  asInputError,
  emailFrom,
  normalizeListBinding,
  paginate,
  rejectClassification,
  rejectClassificationValues,
  rejectResumable,
  rejectUnsupportedFlags,
} from "./rest-common.js";
import type { DeclaredHandlerFor, GmailRouteKit } from "./rest-routes-kit.js";
import { GMAIL_ROUTES } from "./route-inputs.js";
import { invalidArgument } from "./errors.js";

const RESUMABLE = "Resumable Gmail uploads are not supported";

// Three handlers are each mounted at both `/gmail/...` and `/upload/gmail/...`,
// so they need a name — and a name needs the type its own declaration parses to.
type SendHandler = DeclaredHandlerFor<typeof GMAIL_ROUTES.sendMessage>;
type ImportHandler = DeclaredHandlerFor<typeof GMAIL_ROUTES.importMessage>;
type InsertHandler = DeclaredHandlerFor<typeof GMAIL_ROUTES.insertMessage>;

export function registerMessageRoutes(app: DeclarableRouter, kit: GmailRouteKit): void {
  const { serializers, domain } = kit;

  kit.read(app, GMAIL_ROUTES.listMessages, ({ path, query }, c) => {
    const email = emailFrom(path.userId, c);
    const { q, includeSpamTrash, labelIds } = query;
    let messages = asInputError(() => domain.searchMessages(email, q, { includeTrash: includeSpamTrash }));
    if (!/\bin:draft\b/i.test(q)) messages = messages.filter((message) => !message.labelIds.includes("DRAFT"));
    if (labelIds.length) {
      messages = messages.filter((message) => labelIds.every((labelId) => message.labelIds.includes(labelId)));
    }
    const snapshot = domain.currentHistoryIdFor(email);
    const binding = normalizeListBinding("messages.list", email, { query: q, includeSpamTrash, labelIds });
    const { page, nextPageToken } = paginate(messages, {
      maxResults: query.maxResults,
      pageToken: query.pageToken,
      binding,
      snapshot,
    });
    return {
      body: {
        ...(page.length ? { messages: page.map((message) => ({ id: message.id, threadId: message.threadId })) } : {}),
        resultSizeEstimate: messages.length,
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    };
  });

  kit.write(app, GMAIL_ROUTES.batchModifyMessages, ({ path, body }, c) => {
    const email = emailFrom(path.userId, c);
    rejectClassification(body);
    if (!body.ids.length) invalidArgument("ids is required");
    domain.db.transaction(() => {
      for (const id of body.ids) domain.modifyMessageLabels(email, id, body.addLabelIds, body.removeLabelIds);
    }).immediate();
    return { body: {} };
  });

  kit.write(app, GMAIL_ROUTES.batchDeleteMessages, ({ path, body }, c) => {
    const email = emailFrom(path.userId, c);
    if (!body.ids.length) invalidArgument("ids is required");
    domain.batchDeleteMessages(email, body.ids);
    return { status: 204, body: null };
  });

  const send: SendHandler = ({ path, query, body }, c) => {
    rejectResumable(query.uploadType);
    rejectClassificationValues(body);
    const email = emailFrom(path.userId, c);
    const result = asInputError(() => domain.sendMessage(email, body.raw, { threadId: body.threadId }));
    return { body: serializers.message(email, result.sender, "full") };
  };
  kit.write(app, GMAIL_ROUTES.sendMessage, send);
  kit.write(app, GMAIL_ROUTES.sendMessageUpload, send);

  const importMessage: ImportHandler = ({ path, query, body }, c) => {
    rejectResumable(query.uploadType);
    rejectUnsupportedFlags({ deleted: query.deleted, processForCalendar: query.processForCalendar });
    rejectClassificationValues(body);
    const email = emailFrom(path.userId, c);
    const inserted = asInputError(() =>
      domain.insertMessage(email, body.raw, {
        threadId: body.threadId,
        labels: body.labelIds,
        incoming: true,
      })
    );
    const message = domain.applyInternalDateSource(email, inserted.id, query.internalDateSource);
    return { body: serializers.message(email, message, "full") };
  };
  kit.write(app, GMAIL_ROUTES.importMessage, importMessage);
  kit.write(app, GMAIL_ROUTES.importMessageUpload, importMessage);

  const insert: InsertHandler = ({ path, query, body }, c) => {
    rejectResumable(query.uploadType);
    rejectUnsupportedFlags({ deleted: query.deleted });
    rejectClassificationValues(body);
    const email = emailFrom(path.userId, c);
    const inserted = asInputError(() =>
      domain.insertMessage(email, body.raw, { threadId: body.threadId, labels: body.labelIds })
    );
    const message = domain.applyInternalDateSource(email, inserted.id, query.internalDateSource);
    return { body: serializers.message(email, message, "full") };
  };
  kit.write(app, GMAIL_ROUTES.insertMessage, insert);
  kit.write(app, GMAIL_ROUTES.insertMessageUpload, insert);

  kit.read(app, GMAIL_ROUTES.getMessage, ({ path, query }, c) => {
    const email = emailFrom(path.userId, c);
    const message = domain.getMessage(email, path.id);
    return { body: serializers.message(email, message, query.format, query.metadataHeaders) };
  });

  kit.write(app, GMAIL_ROUTES.modifyMessage, ({ path, body }, c) => {
    const email = emailFrom(path.userId, c);
    rejectClassification(body);
    const message = domain.modifyMessageLabels(email, path.id, body.addLabelIds, body.removeLabelIds);
    return { body: serializers.message(email, message, "minimal") };
  });

  kit.write(app, GMAIL_ROUTES.trashMessage, ({ path }, c) => {
    const email = emailFrom(path.userId, c);
    const message = domain.modifyMessageLabels(email, path.id, ["TRASH"], ["INBOX"]);
    return { body: serializers.message(email, message, "minimal") };
  });

  kit.write(app, GMAIL_ROUTES.untrashMessage, ({ path }, c) => {
    const email = emailFrom(path.userId, c);
    const message = domain.modifyMessageLabels(email, path.id, [], ["TRASH"]);
    return { body: serializers.message(email, message, "minimal") };
  });

  kit.write(app, GMAIL_ROUTES.deleteMessage, ({ path }, c) => {
    domain.deleteMessage(emailFrom(path.userId, c), path.id);
    return { status: 204, body: null };
  });

  kit.read(app, GMAIL_ROUTES.getAttachment, ({ path }, c) => ({
    body: domain.attachment(emailFrom(path.userId, c), path.messageId, path.id),
  }));

  for (const declaration of [
    GMAIL_ROUTES.resumableInsertMessage,
    GMAIL_ROUTES.resumableInsertMessagePut,
    GMAIL_ROUTES.resumableSendMessage,
    GMAIL_ROUTES.resumableSendMessagePut,
    GMAIL_ROUTES.resumableImportMessage,
    GMAIL_ROUTES.resumableImportMessagePut,
  ]) {
    kit.unsupported(app, declaration, RESUMABLE);
  }
}
