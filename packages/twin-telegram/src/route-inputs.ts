// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { routeInputDeclarer, type RouteInputDeclaration } from "@pome-sh/sdk/route-inputs";
import {
  MAX_POLL_OPTION_LENGTH,
  MAX_POLL_QUESTION_LENGTH,
  MAX_POLL_OPTIONS,
  MIN_POLL_OPTIONS,
  MAX_MEDIA_GROUP_MULTIPART_REQUEST_BYTES,
  MAX_MEDIA_MULTIPART_REQUEST_BYTES,
} from "./domain.js";

const declareInputs = routeInputDeclarer("ignore");

const credParam = { cred: z.string().min(1) };
const chatIdBody = { chat_id: z.coerce.number().int() };
const jsonValue = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}, z.unknown());
const mediaValue = z.unknown().refine((value) => value !== undefined, "media is required");
const mediaGroup = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}, z.array(z.object({
  type: z.enum(["photo", "document", "video", "audio"]),
  media: z.string(),
  caption: z.string().optional(),
})).min(2).max(10));
const sendBody = {
  chat_id: z.coerce.number().int(),
  text: z.string(),
  reply_to_message_id: z.coerce.number().int().optional(),
  reply_markup: jsonValue.optional(),
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
const formBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);
const dropPending = formBoolean.optional();
const allowedUpdates = z
  .preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }, z.array(z.enum(["message", "callback_query", "poll_answer", "message_reaction"])).max(4))
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

export const POST_EDIT_MESSAGE_CAPTION = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/editMessageCaption",
  pathParams: credParam,
  body: { ...messageBody, caption: z.string().optional() },
  bodyEncoding: "form",
});

export const POST_SEND_PHOTO = declareInputs({
  method: "POST", path: "/:cred{bot[^/]+}/sendPhoto", pathParams: credParam,
  body: { chat_id: z.coerce.number().int(), photo: mediaValue, caption: z.string().optional() }, bodyEncoding: "form", maxBodyBytes: MAX_MEDIA_MULTIPART_REQUEST_BYTES,
});
export const POST_SEND_DOCUMENT = declareInputs({
  method: "POST", path: "/:cred{bot[^/]+}/sendDocument", pathParams: credParam,
  body: { chat_id: z.coerce.number().int(), document: mediaValue, caption: z.string().optional() }, bodyEncoding: "form", maxBodyBytes: MAX_MEDIA_MULTIPART_REQUEST_BYTES,
});
export const POST_SEND_VIDEO = declareInputs({
  method: "POST", path: "/:cred{bot[^/]+}/sendVideo", pathParams: credParam,
  body: { chat_id: z.coerce.number().int(), video: mediaValue, caption: z.string().optional() }, bodyEncoding: "form", maxBodyBytes: MAX_MEDIA_MULTIPART_REQUEST_BYTES,
});
export const POST_SEND_AUDIO = declareInputs({
  method: "POST", path: "/:cred{bot[^/]+}/sendAudio", pathParams: credParam,
  body: { chat_id: z.coerce.number().int(), audio: mediaValue, caption: z.string().optional() }, bodyEncoding: "form", maxBodyBytes: MAX_MEDIA_MULTIPART_REQUEST_BYTES,
});
export const POST_SEND_VOICE = declareInputs({
  method: "POST", path: "/:cred{bot[^/]+}/sendVoice", pathParams: credParam,
  body: { chat_id: z.coerce.number().int(), voice: mediaValue, caption: z.string().optional() }, bodyEncoding: "form", maxBodyBytes: MAX_MEDIA_MULTIPART_REQUEST_BYTES,
});
export const POST_SEND_MEDIA_GROUP = declareInputs({
  method: "POST", path: "/:cred{bot[^/]+}/sendMediaGroup", pathParams: credParam,
  body: { chat_id: z.coerce.number().int(), media: mediaGroup },
  bodyEncoding: "form",
  maxBodyBytes: MAX_MEDIA_GROUP_MULTIPART_REQUEST_BYTES,
  multipartAttachmentsFrom: "media",
});
export const POST_GET_FILE = declareInputs({
  method: "POST", path: "/:cred{bot[^/]+}/getFile", pathParams: credParam,
  body: { file_id: z.string().min(1) }, bodyEncoding: "form",
});
export const POST_SEND_CHAT_ACTION = declareInputs({
  method: "POST", path: "/:cred{bot[^/]+}/sendChatAction", pathParams: credParam,
  body: { chat_id: z.coerce.number().int(), action: z.string().min(1) }, bodyEncoding: "form",
});
/** The download path is opaque media/<file_id>, never a host path. */
export const GET_FILE_DOWNLOAD = declareInputs({
  method: "GET", path: "/file/:cred{bot[^/]+}/:file_path{.+}", pathParams: { ...credParam, file_path: z.string().min(1) },
});

export const POST_EDIT_MESSAGE_REPLY_MARKUP = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/editMessageReplyMarkup",
  pathParams: credParam,
  body: { ...messageBody, reply_markup: jsonValue.nullish() },
  bodyEncoding: "form",
});

export const POST_PIN_CHAT_MESSAGE = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/pinChatMessage",
  pathParams: credParam,
  body: messageBody,
  bodyEncoding: "form",
});

export const POST_UNPIN_CHAT_MESSAGE = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/unpinChatMessage",
  pathParams: credParam,
  body: { chat_id: z.coerce.number().int(), message_id: z.coerce.number().int().optional() },
  bodyEncoding: "form",
});

export const POST_UNPIN_ALL_CHAT_MESSAGES = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/unpinAllChatMessages",
  pathParams: credParam,
  body: chatIdBody,
  bodyEncoding: "form",
});

export const POST_ANSWER_CALLBACK_QUERY = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/answerCallbackQuery",
  pathParams: credParam,
  body: { callback_query_id: z.string().min(1), text: z.string().max(200).optional(), show_alert: formBoolean.optional(), url: z.string().url().optional(), cache_time: z.coerce.number().int().min(0).optional() },
  bodyEncoding: "form",
});

export const POST_SEND_POLL = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/sendPoll",
  pathParams: credParam,
  body: { chat_id: z.coerce.number().int(), question: z.string().min(1).max(MAX_POLL_QUESTION_LENGTH), options: z.preprocess((value) => { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } }, z.array(z.string().min(1).max(MAX_POLL_OPTION_LENGTH)).min(MIN_POLL_OPTIONS).max(MAX_POLL_OPTIONS)), is_anonymous: formBoolean.optional(), allows_multiple_answers: formBoolean.optional(), allow_paid_broadcast: z.never().optional(), business_connection_id: z.never().optional(), message_effect_id: z.never().optional(), type: z.never().optional(), correct_option_id: z.never().optional(), explanation: z.never().optional() },
  bodyEncoding: "form",
});

export const POST_STOP_POLL = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/stopPoll",
  pathParams: credParam,
  body: messageBody,
  bodyEncoding: "form",
});

export const POST_SET_MESSAGE_REACTION = declareInputs({
  method: "POST",
  path: "/:cred{bot[^/]+}/setMessageReaction",
  pathParams: credParam,
  body: { ...messageBody, reaction: jsonValue.optional(), is_big: z.never().optional() },
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
  body: {
    chat_id: z.coerce.number().int(),
    message_ids: z.preprocess((value) => {
      if (typeof value !== "string") return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }, z.array(z.coerce.number().int())),
  },
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
  POST_EDIT_MESSAGE_CAPTION,
  POST_SEND_PHOTO,
  POST_SEND_DOCUMENT,
  POST_SEND_VIDEO,
  POST_SEND_AUDIO,
  POST_SEND_VOICE,
  POST_SEND_MEDIA_GROUP,
  POST_GET_FILE,
  POST_SEND_CHAT_ACTION,
  GET_FILE_DOWNLOAD,
  POST_EDIT_MESSAGE_REPLY_MARKUP,
  POST_PIN_CHAT_MESSAGE,
  POST_UNPIN_CHAT_MESSAGE,
  POST_UNPIN_ALL_CHAT_MESSAGES,
  POST_ANSWER_CALLBACK_QUERY,
  POST_SEND_POLL,
  POST_STOP_POLL,
  POST_SET_MESSAGE_REACTION,
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
