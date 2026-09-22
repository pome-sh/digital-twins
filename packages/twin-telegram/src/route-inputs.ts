// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { routeInputDeclarer, type RouteInputDeclaration } from "@pome-sh/sdk/route-inputs";

const declareInputs = routeInputDeclarer("ignore");

const credParam = { cred: z.string().min(1) };
const chatIdBody = { chat_id: z.coerce.number().int() };
const sendBody = {
  chat_id: z.coerce.number().int(),
  text: z.string(),
  reply_to_message_id: z.coerce.number().int().optional(),
};

export const GET_ME = declareInputs({
  method: "GET",
  path: "/:cred{bot[^/]+}/getMe",
  pathParams: credParam,
});

export const POST_GET_ME = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/getMe",
  pathParams: credParam,
});

export const GET_CHAT = declareInputs({
  method: "GET",
  path: "/:cred{bot[^/]+}/getChat",
  pathParams: credParam,
  query: chatIdBody,
});

export const POST_GET_CHAT = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/getChat",
  pathParams: credParam,
  body: chatIdBody,
  bodyEncoding: "form",
});

const messageBody = {
  chat_id: z.coerce.number().int(),
  message_id: z.coerce.number().int(),
};
const transferBody = {
  chat_id: z.coerce.number().int(),
  from_chat_id: z.coerce.number().int(),
  message_id: z.coerce.number().int(),
};
const dropPending = z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).optional();
const allowedUpdates = z
  .preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, z.array(z.enum(["message"])).max(1))
  .optional();
const updateArgs = {
  offset: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  timeout: z.coerce.number().int().min(0).max(50).optional(),
  allowed_updates: allowedUpdates,
};
const webhookBody = {
  url: z.string().min(1),
  allowed_updates: allowedUpdates,
  secret_token: z.string().min(1).max(256).optional(),
  max_connections: z.coerce.number().int().min(1).max(100).optional(),
  drop_pending_updates: dropPending,
};

export const POST_SEND_MESSAGE = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/sendMessage",
  pathParams: credParam,
  body: sendBody,
  bodyEncoding: "form",
});

export const POST_EDIT_MESSAGE_TEXT = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/editMessageText",
  pathParams: credParam,
  body: { ...messageBody, text: z.string() },
  bodyEncoding: "form",
});

export const POST_DELETE_MESSAGE = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/deleteMessage",
  pathParams: credParam,
  body: messageBody,
  bodyEncoding: "form",
});

export const POST_DELETE_MESSAGES = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/deleteMessages",
  pathParams: credParam,
  body: { chat_id: z.coerce.number().int(), message_ids: z.array(z.coerce.number().int()) },
  bodyEncoding: "form",
});

export const POST_FORWARD_MESSAGE = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/forwardMessage",
  pathParams: credParam,
  body: transferBody,
  bodyEncoding: "form",
});

export const POST_COPY_MESSAGE = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/copyMessage",
  pathParams: credParam,
  body: transferBody,
  bodyEncoding: "form",
});

export const GET_UPDATES = declareInputs({
  method: "GET",
  path: "/:cred{bot[^/]+}/getUpdates",
  pathParams: credParam,
  query: updateArgs,
});

export const POST_GET_UPDATES = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/getUpdates",
  pathParams: credParam,
  body: updateArgs,
  bodyEncoding: "form",
});

export const POST_SET_WEBHOOK = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/setWebhook",
  pathParams: credParam,
  body: webhookBody,
  bodyEncoding: "form",
});

export const POST_DELETE_WEBHOOK = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/deleteWebhook",
  pathParams: credParam,
  body: { drop_pending_updates: dropPending },
  bodyEncoding: "form",
});

export const GET_WEBHOOK_INFO = declareInputs({
  method: "GET",
  path: "/:cred{bot[^/]+}/getWebhookInfo",
  pathParams: credParam,
});

export const POST_GET_WEBHOOK_INFO = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/getWebhookInfo",
  pathParams: credParam,
  body: {},
  bodyEncoding: "form",
});

/** Every Bot API surface mounted by routes.ts. Telegram is not yet in the global artifact lane. */
export const TELEGRAM_ROUTE_INPUTS: readonly RouteInputDeclaration[] = [
  GET_ME,
  POST_GET_ME,
  GET_CHAT,
  POST_GET_CHAT,
  POST_SEND_MESSAGE,
  POST_EDIT_MESSAGE_TEXT,
  POST_DELETE_MESSAGE,
  POST_DELETE_MESSAGES,
  POST_FORWARD_MESSAGE,
  POST_COPY_MESSAGE,
  GET_UPDATES,
  POST_GET_UPDATES,
  POST_SET_WEBHOOK,
  POST_DELETE_WEBHOOK,
  GET_WEBHOOK_INFO,
  POST_GET_WEBHOOK_INFO,
];
