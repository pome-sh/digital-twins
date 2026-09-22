// SPDX-License-Identifier: Apache-2.0
import type { Context, Hono } from "hono";
import type { RouteContext } from "@pome-sh/sdk";
import { mountDeclaredRoute } from "@pome-sh/sdk/route-inputs";
import type { TelegramDomain } from "./domain.js";
import {
  GET_CHAT,
  GET_ME,
  GET_UPDATES,
  GET_WEBHOOK_INFO,
  POST_COPY_MESSAGE,
  POST_DELETE_MESSAGE,
  POST_DELETE_MESSAGES,
  POST_EDIT_MESSAGE_TEXT,
  POST_FORWARD_MESSAGE,
  POST_GET_CHAT,
  POST_GET_ME,
  POST_GET_UPDATES,
  POST_GET_WEBHOOK_INFO,
  POST_SEND_MESSAGE,
  POST_SET_WEBHOOK,
  POST_DELETE_WEBHOOK,
} from "./route-inputs.js";
import { telegramOk } from "./serializers.js";

function botActor(c: Context): { kind: "bot"; botId: number } {
  const session = c.get("session") as { bot_id?: unknown } | undefined;
  const botId = typeof session?.bot_id === "number" ? session.bot_id : Number(session?.bot_id);
  return { kind: "bot", botId };
}

export function registerTelegramRoutes(app: Hono, { domain, recorder }: RouteContext<TelegramDomain>): void {
  const getMe = recorder.handle({ mutation: false }, async (c) => {
    await GET_ME.parse(c.req);
    return { status: 200, body: telegramOk(domain.getMe(botActor(c))) };
  });
  mountDeclaredRoute(app, GET_ME, getMe);
  mountDeclaredRoute(
    app,
    POST_GET_ME,
    recorder.handle({ mutation: false }, async (c) => {
      await POST_GET_ME.parse(c.req);
      return { status: 200, body: telegramOk(domain.getMe(botActor(c))) };
    }),
  );

  mountDeclaredRoute(
    app,
    GET_CHAT,
    recorder.handle({ mutation: false }, async (c) => {
      const parsed = await GET_CHAT.parse(c.req);
      return { status: 200, body: telegramOk(domain.getChat(botActor(c), parsed.query.chat_id)) };
    }),
  );
  mountDeclaredRoute(
    app,
    POST_GET_CHAT,
    recorder.handle({ mutation: false }, async (c) => {
      const parsed = await POST_GET_CHAT.parse(c.req);
      return { status: 200, body: telegramOk(domain.getChat(botActor(c), parsed.body.chat_id)) };
    }),
  );

  mountDeclaredRoute(
    app,
    POST_SEND_MESSAGE,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_SEND_MESSAGE.parse(c.req);
      return {
        status: 200,
        body: telegramOk(
          domain.sendMessage(botActor(c), {
            chat_id: parsed.body.chat_id,
            text: parsed.body.text,
            reply_to_message_id: parsed.body.reply_to_message_id,
          }),
        ),
      };
    }),
  );

  mountDeclaredRoute(
    app,
    POST_EDIT_MESSAGE_TEXT,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_EDIT_MESSAGE_TEXT.parse(c.req);
      return { status: 200, body: telegramOk(domain.editMessageText(botActor(c), parsed.body)) };
    }),
  );
  mountDeclaredRoute(
    app,
    POST_DELETE_MESSAGE,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_DELETE_MESSAGE.parse(c.req);
      domain.deleteMessage(botActor(c), parsed.body);
      return { status: 200, body: telegramOk(true) };
    }),
  );
  mountDeclaredRoute(
    app,
    POST_DELETE_MESSAGES,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_DELETE_MESSAGES.parse(c.req);
      domain.deleteMessages(botActor(c), parsed.body);
      return { status: 200, body: telegramOk(true) };
    }),
  );
  mountDeclaredRoute(
    app,
    POST_FORWARD_MESSAGE,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_FORWARD_MESSAGE.parse(c.req);
      return { status: 200, body: telegramOk(domain.forwardMessage(botActor(c), parsed.body)) };
    }),
  );
  mountDeclaredRoute(
    app,
    POST_COPY_MESSAGE,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_COPY_MESSAGE.parse(c.req);
      return { status: 200, body: telegramOk(domain.copyMessage(botActor(c), parsed.body)) };
    }),
  );

  const getUpdates = async (args: { offset?: number; limit?: number; timeout?: number }, c: Context) => ({
    status: 200,
    body: telegramOk(await domain.waitForUpdates(botActor(c), args, c.req.raw.signal)),
  });
  mountDeclaredRoute(
    app,
    GET_UPDATES,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await GET_UPDATES.parse(c.req);
      return getUpdates(parsed.query, c);
    }),
  );
  mountDeclaredRoute(
    app,
    POST_GET_UPDATES,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_GET_UPDATES.parse(c.req);
      return getUpdates(parsed.body, c);
    }),
  );
  mountDeclaredRoute(
    app,
    POST_SET_WEBHOOK,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_SET_WEBHOOK.parse(c.req);
      domain.setWebhook(botActor(c), parsed.body);
      return { status: 200, body: telegramOk(true) };
    }),
  );
  mountDeclaredRoute(
    app,
    POST_DELETE_WEBHOOK,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_DELETE_WEBHOOK.parse(c.req);
      domain.deleteWebhook(botActor(c), parsed.body);
      return { status: 200, body: telegramOk(true) };
    }),
  );
  const getWebhookInfo = async (c: Context) => ({
    status: 200,
    body: telegramOk(domain.getWebhookInfo(botActor(c))),
  });
  mountDeclaredRoute(app, GET_WEBHOOK_INFO, recorder.handle({ mutation: false }, getWebhookInfo));
  mountDeclaredRoute(app, POST_GET_WEBHOOK_INFO, recorder.handle({ mutation: false }, async (c) => {
    await POST_GET_WEBHOOK_INFO.parse(c.req);
    return getWebhookInfo(c);
  }));
}
