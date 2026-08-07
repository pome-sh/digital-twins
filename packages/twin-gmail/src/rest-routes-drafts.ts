// SPDX-License-Identifier: Apache-2.0
import type { DeclarableRouter } from "@pome-sh/sdk/route-inputs";
import {
  asInputError,
  emailFrom,
  normalizeListBinding,
  paginate,
  rejectClassificationValues,
  rejectResumable,
} from "./rest-common.js";
import { invalidArgument } from "./errors.js";
import type { DeclaredHandlerFor, GmailRouteKit } from "./rest-routes-kit.js";
import { GMAIL_ROUTES } from "./route-inputs.js";

const RESUMABLE = "Resumable Gmail uploads are not supported";

type CreateHandler = DeclaredHandlerFor<typeof GMAIL_ROUTES.createDraft>;
type SendHandler = DeclaredHandlerFor<typeof GMAIL_ROUTES.sendDraft>;
type UpdateHandler = DeclaredHandlerFor<typeof GMAIL_ROUTES.updateDraft>;

export function registerDraftRoutes(app: DeclarableRouter, kit: GmailRouteKit): void {
  const { serializers, domain } = kit;

  kit.read(app, GMAIL_ROUTES.listDrafts, ({ path, query }, c) => {
    const email = emailFrom(path.userId, c);
    const { q, includeSpamTrash } = query;
    const drafts = asInputError(() => domain.drafts(email, q, includeSpamTrash));
    const snapshot = domain.currentHistoryIdFor(email);
    const binding = normalizeListBinding("drafts.list", email, { query: q, includeSpamTrash });
    const { page, nextPageToken } = paginate(drafts, {
      maxResults: query.maxResults,
      pageToken: query.pageToken,
      binding,
      snapshot,
    });
    return {
      body: {
        ...(page.length
          ? {
              drafts: page.map((draft) => ({
                id: draft.id,
                message: { id: draft.message.id, threadId: draft.message.threadId },
              })),
            }
          : {}),
        resultSizeEstimate: drafts.length,
        ...(nextPageToken ? { nextPageToken } : {}),
      },
    };
  });

  const create: CreateHandler = ({ path, query, body }, c) => {
    rejectResumable(query.uploadType);
    rejectClassificationValues(body.message);
    const email = emailFrom(path.userId, c);
    const draft = asInputError(() =>
      domain.createDraft(email, body.message.raw, { threadId: body.message.threadId })
    );
    return { body: serializers.draft(email, draft, "full") };
  };
  kit.write(app, GMAIL_ROUTES.createDraft, create);
  kit.write(app, GMAIL_ROUTES.createDraftUpload, create);

  const send: SendHandler = ({ path, query, body }, c) => {
    // `readDraftSend` only consulted `?uploadType=` when the body was NOT JSON:
    // the `{id, message}` envelope reached the domain even with
    // `uploadType=resumable`. Bytes on `message.raw` is exactly that
    // distinction — a JSON `raw` is always a base64url string.
    if (body.message?.raw instanceof Uint8Array) rejectResumable(query.uploadType);
    if (!body.id && !body.message) invalidArgument("Draft id is required");
    const email = emailFrom(path.userId, c);
    if (body.id) {
      if (body.message) {
        const message = body.message;
        asInputError(() => domain.updateDraft(email, body.id!, message.raw, { threadId: message.threadId }));
      }
      const sent = asInputError(() => domain.sendDraft(email, body.id!));
      return { body: serializers.message(email, sent.sender, "full") };
    }
    const message = body.message!;
    const sent = asInputError(() => domain.sendMessage(email, message.raw, { threadId: message.threadId }));
    return { body: serializers.message(email, sent.sender, "full") };
  };
  kit.write(app, GMAIL_ROUTES.sendDraft, send);
  kit.write(app, GMAIL_ROUTES.sendDraftUpload, send);

  kit.read(app, GMAIL_ROUTES.getDraft, ({ path, query }, c) => {
    const email = emailFrom(path.userId, c);
    return { body: serializers.draft(email, domain.draft(email, path.id), query.format) };
  });

  const update: UpdateHandler = ({ path, query, body }, c) => {
    rejectResumable(query.uploadType);
    rejectClassificationValues(body.message);
    const email = emailFrom(path.userId, c);
    const draft = asInputError(() =>
      domain.updateDraft(email, path.id, body.message.raw, { threadId: body.message.threadId })
    );
    return { body: serializers.draft(email, draft, "full") };
  };
  kit.write(app, GMAIL_ROUTES.updateDraft, update);
  kit.write(app, GMAIL_ROUTES.updateDraftUpload, update);

  kit.write(app, GMAIL_ROUTES.deleteDraft, ({ path }, c) => {
    domain.deleteDraft(emailFrom(path.userId, c), path.id);
    return { status: 204, body: null };
  });

  for (const declaration of [
    GMAIL_ROUTES.resumableCreateDraft,
    GMAIL_ROUTES.resumableCreateDraftPut,
    GMAIL_ROUTES.resumableSendDraft,
    GMAIL_ROUTES.resumableSendDraftPut,
    GMAIL_ROUTES.resumableUpdateDraft,
    GMAIL_ROUTES.resumableUpdateDraftPut,
  ]) {
    kit.unsupported(app, declaration, RESUMABLE);
  }
}
