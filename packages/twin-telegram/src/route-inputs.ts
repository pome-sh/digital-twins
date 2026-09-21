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

export const POST_SEND_MESSAGE = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/sendMessage",
  pathParams: credParam,
  body: sendBody,
  bodyEncoding: "form",
});
