// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — every REST input this twin accepts, declared by the schemas that
// validate it.
//
// Nothing here describes a handler; `parse()` IS the handler's only view of the
// request, and `method`/`path` are what the route is mounted at (see
// `rest-routes-kit.ts`). A name absent from a declaration is refused, so the
// published surface cannot be narrower or wider than the twin.
//
// The shapes are the twin's OWN acceptance, derived from the call sites this
// replaced — not Gmail's documented surface. Where the two differ, pome-cloud's
// declared-fidelity lane is what reports it.

import { z } from "zod";
import {
  booleanInput,
  declareRouteInputs,
  integerInput,
  repeatedInput,
  type RouteInputDeclaration,
} from "@pome-sh/sdk/route-inputs";

const USERS = "/gmail/v1/users/:userId";
const MESSAGES = `${USERS}/messages`;
const MESSAGES_UPLOAD = "/upload/gmail/v1/users/:userId/messages";
const DRAFTS = `${USERS}/drafts`;
const DRAFTS_UPLOAD = "/upload/gmail/v1/users/:userId/drafts";
const RESUMABLE = "/resumable/upload/gmail/v1/users/:userId";

// ─── Shared locations ────────────────────────────────────────────────────────

const USER = { userId: z.string().min(1) } as const;
const USER_ITEM = { ...USER, id: z.string().min(1) } as const;

/** Gmail's list pagination, shared by messages/threads/drafts/history. */
const LIST_QUERY = {
  maxResults: integerInput({ min: 1, max: 500 }).default(100),
  pageToken: z.string().optional(),
} as const;

/** The search half of a list surface. */
const SEARCH_QUERY = {
  q: z.string().default(""),
  includeSpamTrash: booleanInput.default(false),
} as const;

/**
 * `?uploadType=`. Read only to refuse `resumable`; any other value is accepted
 * and ignored, which is why this is a plain string and not Gmail's enum.
 */
const UPLOAD_QUERY = { uploadType: z.string().optional() } as const;

const MESSAGE_FORMAT_QUERY = {
  format: z.enum(["minimal", "full", "raw", "metadata"]).default("full"),
  metadataHeaders: repeatedInput(),
} as const;

/** Threads project no `raw`, so their `format` enum is one value shorter. */
const THREAD_FORMAT_QUERY = {
  format: z.enum(["minimal", "full", "metadata"]).default("full"),
  metadataHeaders: repeatedInput(),
} as const;

const unique = (values: string[]): string[] => [...new Set(values)];

/** A label-id list: de-duplicated, capped, and `[]` when absent. */
const stringListInput = (max: number): z.ZodType<string[]> =>
  z.array(z.string()).max(max).transform(unique).default([]);

/** The same list where absent must stay `undefined` (the domain branches on it). */
const optionalStringListInput = (max: number): z.ZodType<string[] | undefined> =>
  z.array(z.string()).max(max).transform(unique).optional();

/**
 * Gmail's `raw`: a base64url string in a JSON resource, the media bytes when
 * the same operation arrives as an upload. Empty is refused either way.
 */
const RAW_INPUT = z.union([
  z.string().min(1),
  z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0),
]);

/** Accepted, then answered 501 — Drive Labels are not modelled. */
const CLASSIFICATION_BODY = {
  addClassificationLabels: z.unknown().optional(),
  removeClassificationLabelIds: z.unknown().optional(),
} as const;

const LABEL_MODIFY_BODY = {
  addLabelIds: stringListInput(100),
  removeLabelIds: stringListInput(100),
} as const;

/** The Message resource a write accepts, wherever it is nested. */
const MESSAGE_RESOURCE = {
  raw: RAW_INPUT,
  threadId: z.string().optional(),
  labelIds: optionalStringListInput(100),
  /** Accepted, then answered 501. */
  classificationLabelValues: z.unknown().optional(),
} as const;

const MESSAGE_WRITE_BODY = { ...MESSAGE_RESOURCE, id: z.string().optional() } as const;

const DRAFT_WRITE_BODY = {
  message: z.object(MESSAGE_RESOURCE),
  id: z.string().optional(),
} as const;

/**
 * `PUT .../drafts/:id` declares a body `id` as well as the path one.
 *
 * Real Gmail's `drafts.update` request body IS a Draft resource, which carries
 * `id`, so a client written against the vendor sends it — the official
 * `@googleapis/gmail` client included. The twin read it and discarded it in
 * favour of the path param, and it still does; refusing it would fail a
 * correctly-written agent for something the vendor accepts.
 */
const DRAFT_UPDATE_BODY = {
  message: z.object(MESSAGE_RESOURCE),
  id: z.string().optional(),
} as const;

const DRAFT_SEND_BODY = {
  id: z.string().optional(),
  message: z.object({ raw: RAW_INPUT, threadId: z.string().optional() }).optional(),
} as const;

/**
 * A label's writable fields. `type`, `labelListVisibility` and
 * `messageListVisibility` are `unknown` because the twin never validated them —
 * two of the three are sent by the official client and ignored, and narrowing
 * them here would refuse a request the twin accepts today.
 */
const LABEL_BODY = {
  color: z
    .object({ textColor: z.string().optional(), backgroundColor: z.string().optional() })
    .optional(),
  type: z.unknown().optional(),
  labelListVisibility: z.unknown().optional(),
  messageListVisibility: z.unknown().optional(),
} as const;

/**
 * A filter's `criteria` / `action`. Only the top-level names are declared; the
 * per-field walk in `rest-routes-resources.ts` keeps its exact error text.
 */
const jsonObjectInput = z.record(z.string(), z.unknown());

// ─── Reused route shapes ─────────────────────────────────────────────────────
//
// A handler registered at both `/gmail/...` and `/upload/gmail/...` is TWO
// routes, so it is two declarations built from one shape.

const MESSAGE_SEND_SHAPE = {
  method: "POST",
  pathParams: USER,
  query: UPLOAD_QUERY,
  bodyEncoding: "media",
  mediaField: "raw",
  body: MESSAGE_WRITE_BODY,
} as const;

const MESSAGE_IMPORT_SHAPE = {
  method: "POST",
  pathParams: USER,
  query: {
    ...UPLOAD_QUERY,
    deleted: booleanInput.default(false),
    processForCalendar: booleanInput.default(false),
    neverMarkSpam: booleanInput.default(false),
    internalDateSource: z.enum(["receivedTime", "dateHeader"]).default("dateHeader"),
  },
  bodyEncoding: "media",
  mediaField: "raw",
  body: MESSAGE_WRITE_BODY,
} as const;

const MESSAGE_INSERT_SHAPE = {
  method: "POST",
  pathParams: USER,
  query: {
    ...UPLOAD_QUERY,
    deleted: booleanInput.default(false),
    internalDateSource: z.enum(["receivedTime", "dateHeader"]).default("receivedTime"),
  },
  bodyEncoding: "media",
  mediaField: "raw",
  body: MESSAGE_WRITE_BODY,
} as const;

const DRAFT_CREATE_SHAPE = {
  method: "POST",
  pathParams: USER,
  query: UPLOAD_QUERY,
  bodyEncoding: "media",
  mediaField: "message.raw",
  body: DRAFT_WRITE_BODY,
} as const;

const DRAFT_SEND_SHAPE = {
  method: "POST",
  pathParams: USER,
  query: UPLOAD_QUERY,
  bodyEncoding: "media",
  mediaField: "message.raw",
  body: DRAFT_SEND_BODY,
} as const;

const DRAFT_UPDATE_SHAPE = {
  method: "PUT",
  pathParams: USER_ITEM,
  query: UPLOAD_QUERY,
  bodyEncoding: "media",
  mediaField: "message.raw",
  body: DRAFT_UPDATE_BODY,
} as const;

/** `kit.unsupported` reads nothing but the mount point. */
const REFUSED = { method: "POST", pathParams: USER } as const;
const REFUSED_PUT = { method: "PUT", pathParams: USER } as const;
const REFUSED_ITEM = { method: "POST", pathParams: USER_ITEM } as const;
const REFUSED_ITEM_PUT = { method: "PUT", pathParams: USER_ITEM } as const;

// ─── The routes ──────────────────────────────────────────────────────────────

export const GMAIL_ROUTES = {
  // messages
  listMessages: declareRouteInputs({
    method: "GET",
    path: MESSAGES,
    pathParams: USER,
    query: { ...SEARCH_QUERY, ...LIST_QUERY, labelIds: repeatedInput() },
  }),
  batchModifyMessages: declareRouteInputs({
    method: "POST",
    path: `${MESSAGES}/batchModify`,
    pathParams: USER,
    bodyEncoding: "json",
    body: {
      ids: stringListInput(1000),
      ...LABEL_MODIFY_BODY,
      ...CLASSIFICATION_BODY,
    },
  }),
  batchDeleteMessages: declareRouteInputs({
    method: "POST",
    path: `${MESSAGES}/batchDelete`,
    pathParams: USER,
    bodyEncoding: "json",
    body: { ids: stringListInput(1000) },
  }),
  sendMessage: declareRouteInputs({ ...MESSAGE_SEND_SHAPE, path: `${MESSAGES}/send` }),
  sendMessageUpload: declareRouteInputs({
    ...MESSAGE_SEND_SHAPE,
    path: `${MESSAGES_UPLOAD}/send`,
  }),
  importMessage: declareRouteInputs({ ...MESSAGE_IMPORT_SHAPE, path: `${MESSAGES}/import` }),
  importMessageUpload: declareRouteInputs({
    ...MESSAGE_IMPORT_SHAPE,
    path: `${MESSAGES_UPLOAD}/import`,
  }),
  insertMessage: declareRouteInputs({ ...MESSAGE_INSERT_SHAPE, path: MESSAGES }),
  insertMessageUpload: declareRouteInputs({ ...MESSAGE_INSERT_SHAPE, path: MESSAGES_UPLOAD }),
  getMessage: declareRouteInputs({
    method: "GET",
    path: `${MESSAGES}/:id`,
    pathParams: USER_ITEM,
    query: MESSAGE_FORMAT_QUERY,
  }),
  modifyMessage: declareRouteInputs({
    method: "POST",
    path: `${MESSAGES}/:id/modify`,
    pathParams: USER_ITEM,
    bodyEncoding: "json",
    body: { ...LABEL_MODIFY_BODY, ...CLASSIFICATION_BODY },
  }),
  trashMessage: declareRouteInputs({
    method: "POST",
    path: `${MESSAGES}/:id/trash`,
    pathParams: USER_ITEM,
  }),
  untrashMessage: declareRouteInputs({
    method: "POST",
    path: `${MESSAGES}/:id/untrash`,
    pathParams: USER_ITEM,
  }),
  deleteMessage: declareRouteInputs({
    method: "DELETE",
    path: `${MESSAGES}/:id`,
    pathParams: USER_ITEM,
  }),
  getAttachment: declareRouteInputs({
    method: "GET",
    path: `${MESSAGES}/:messageId/attachments/:id`,
    pathParams: { ...USER_ITEM, messageId: z.string().min(1) },
  }),
  resumableInsertMessage: declareRouteInputs({ ...REFUSED, path: `${RESUMABLE}/messages` }),
  resumableInsertMessagePut: declareRouteInputs({
    ...REFUSED_PUT,
    path: `${RESUMABLE}/messages`,
  }),
  resumableSendMessage: declareRouteInputs({ ...REFUSED, path: `${RESUMABLE}/messages/send` }),
  resumableSendMessagePut: declareRouteInputs({
    ...REFUSED_PUT,
    path: `${RESUMABLE}/messages/send`,
  }),
  resumableImportMessage: declareRouteInputs({
    ...REFUSED,
    path: `${RESUMABLE}/messages/import`,
  }),
  resumableImportMessagePut: declareRouteInputs({
    ...REFUSED_PUT,
    path: `${RESUMABLE}/messages/import`,
  }),

  // drafts
  listDrafts: declareRouteInputs({
    method: "GET",
    path: DRAFTS,
    pathParams: USER,
    query: { ...SEARCH_QUERY, ...LIST_QUERY },
  }),
  createDraft: declareRouteInputs({ ...DRAFT_CREATE_SHAPE, path: DRAFTS }),
  createDraftUpload: declareRouteInputs({ ...DRAFT_CREATE_SHAPE, path: DRAFTS_UPLOAD }),
  sendDraft: declareRouteInputs({ ...DRAFT_SEND_SHAPE, path: `${DRAFTS}/send` }),
  sendDraftUpload: declareRouteInputs({ ...DRAFT_SEND_SHAPE, path: `${DRAFTS_UPLOAD}/send` }),
  getDraft: declareRouteInputs({
    method: "GET",
    path: `${DRAFTS}/:id`,
    pathParams: USER_ITEM,
    query: { format: MESSAGE_FORMAT_QUERY.format },
  }),
  updateDraft: declareRouteInputs({ ...DRAFT_UPDATE_SHAPE, path: `${DRAFTS}/:id` }),
  updateDraftUpload: declareRouteInputs({
    ...DRAFT_UPDATE_SHAPE,
    path: `${DRAFTS_UPLOAD}/:id`,
  }),
  deleteDraft: declareRouteInputs({
    method: "DELETE",
    path: `${DRAFTS}/:id`,
    pathParams: USER_ITEM,
  }),
  resumableCreateDraft: declareRouteInputs({ ...REFUSED, path: `${RESUMABLE}/drafts` }),
  resumableCreateDraftPut: declareRouteInputs({ ...REFUSED_PUT, path: `${RESUMABLE}/drafts` }),
  resumableSendDraft: declareRouteInputs({ ...REFUSED, path: `${RESUMABLE}/drafts/send` }),
  resumableSendDraftPut: declareRouteInputs({
    ...REFUSED_PUT,
    path: `${RESUMABLE}/drafts/send`,
  }),
  resumableUpdateDraft: declareRouteInputs({ ...REFUSED_ITEM, path: `${RESUMABLE}/drafts/:id` }),
  resumableUpdateDraftPut: declareRouteInputs({
    ...REFUSED_ITEM_PUT,
    path: `${RESUMABLE}/drafts/:id`,
  }),

  // profile, threads
  getProfile: declareRouteInputs({ method: "GET", path: `${USERS}/profile`, pathParams: USER }),
  listThreads: declareRouteInputs({
    method: "GET",
    path: `${USERS}/threads`,
    pathParams: USER,
    query: { ...SEARCH_QUERY, ...LIST_QUERY, labelIds: repeatedInput() },
  }),
  getThread: declareRouteInputs({
    method: "GET",
    path: `${USERS}/threads/:id`,
    pathParams: USER_ITEM,
    query: THREAD_FORMAT_QUERY,
  }),
  modifyThread: declareRouteInputs({
    method: "POST",
    path: `${USERS}/threads/:id/modify`,
    pathParams: USER_ITEM,
    bodyEncoding: "json",
    body: LABEL_MODIFY_BODY,
  }),
  trashThread: declareRouteInputs({
    method: "POST",
    path: `${USERS}/threads/:id/trash`,
    pathParams: USER_ITEM,
  }),
  untrashThread: declareRouteInputs({
    method: "POST",
    path: `${USERS}/threads/:id/untrash`,
    pathParams: USER_ITEM,
  }),
  deleteThread: declareRouteInputs({
    method: "DELETE",
    path: `${USERS}/threads/:id`,
    pathParams: USER_ITEM,
  }),

  // labels
  listLabels: declareRouteInputs({ method: "GET", path: `${USERS}/labels`, pathParams: USER }),
  getLabel: declareRouteInputs({
    method: "GET",
    path: `${USERS}/labels/:id`,
    pathParams: USER_ITEM,
  }),
  createLabel: declareRouteInputs({
    method: "POST",
    path: `${USERS}/labels`,
    pathParams: USER,
    bodyEncoding: "json",
    body: { name: z.string().min(1), ...LABEL_BODY },
  }),
  updateLabel: declareRouteInputs({
    method: "PUT",
    path: `${USERS}/labels/:id`,
    pathParams: USER_ITEM,
    bodyEncoding: "json",
    body: { name: z.string().min(1), ...LABEL_BODY },
  }),
  patchLabel: declareRouteInputs({
    method: "PATCH",
    path: `${USERS}/labels/:id`,
    pathParams: USER_ITEM,
    bodyEncoding: "json",
    // `stringField(body, "name")` let `""` through to the domain, which answers
    // "Label name is required"; `.min(1)` here would move that error.
    body: { name: z.string().optional(), ...LABEL_BODY },
  }),
  deleteLabel: declareRouteInputs({
    method: "DELETE",
    path: `${USERS}/labels/:id`,
    pathParams: USER_ITEM,
  }),

  // history
  listHistory: declareRouteInputs({
    method: "GET",
    path: `${USERS}/history`,
    pathParams: USER,
    query: {
      ...LIST_QUERY,
      startHistoryId: z.string().min(1),
      historyTypes: repeatedInput(),
      labelId: z.string().optional(),
    },
  }),

  // settings
  listFilters: declareRouteInputs({
    method: "GET",
    path: `${USERS}/settings/filters`,
    pathParams: USER,
  }),
  getFilter: declareRouteInputs({
    method: "GET",
    path: `${USERS}/settings/filters/:id`,
    pathParams: USER_ITEM,
  }),
  createFilter: declareRouteInputs({
    method: "POST",
    path: `${USERS}/settings/filters`,
    pathParams: USER,
    bodyEncoding: "json",
    body: { criteria: jsonObjectInput.optional(), action: jsonObjectInput.optional() },
  }),
  deleteFilter: declareRouteInputs({
    method: "DELETE",
    path: `${USERS}/settings/filters/:id`,
    pathParams: USER_ITEM,
  }),
  listForwardingAddresses: declareRouteInputs({
    method: "GET",
    path: `${USERS}/settings/forwardingAddresses`,
    pathParams: USER,
  }),
  getForwardingAddress: declareRouteInputs({
    method: "GET",
    path: `${USERS}/settings/forwardingAddresses/:forwardingEmail`,
    pathParams: { ...USER, forwardingEmail: z.string().min(1) },
  }),
  listSendAs: declareRouteInputs({
    method: "GET",
    path: `${USERS}/settings/sendAs`,
    pathParams: USER,
  }),
  getSendAs: declareRouteInputs({
    method: "GET",
    path: `${USERS}/settings/sendAs/:sendAsEmail`,
    pathParams: { ...USER, sendAsEmail: z.string().min(1) },
  }),

  // Pub/Sub
  watch: declareRouteInputs({ ...REFUSED, path: `${USERS}/watch` }),
  stop: declareRouteInputs({ ...REFUSED, path: `${USERS}/stop` }),
} as const;

/** Every REST route this twin serves. Read by the artifact emitter and the 1:1 test. */
export const GMAIL_ROUTE_INPUTS: readonly RouteInputDeclaration[] = Object.values(GMAIL_ROUTES);
