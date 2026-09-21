// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { routeInputDeclarer } from "@pome-sh/sdk/route-inputs";

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
