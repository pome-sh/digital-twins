// SPDX-License-Identifier: Apache-2.0
import type { Context, Hono } from "hono";
import type { RouteContext } from "@pome-sh/sdk";
import { mountDeclaredRoute } from "@pome-sh/sdk/route-inputs";
import type { TelegramDomain } from "./domain.js";
import { GET_CHAT, GET_ME, POST_GET_CHAT, POST_GET_ME, POST_SEND_MESSAGE } from "./route-inputs.js";
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
}
