// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import type { RouteContext } from "@pome-sh/sdk";
import type { StateDelta } from "@pome-sh/wire";
import { mountDeclaredRoute } from "@pome-sh/sdk/route-inputs";
import { type TelegramDomain } from "./domain.js";
import { telegramFail } from "./errors.js";
import {
  GET_CHAT,
  GET_ME,
  GET_UPDATES,
  GET_WEBHOOK_INFO,
  POST_COPY_MESSAGE,
  POST_DELETE_MESSAGE,
  POST_DELETE_MESSAGES,
  POST_EDIT_MESSAGE_TEXT,
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
  POST_FORWARD_MESSAGE,
  POST_GET_CHAT,
  POST_GET_ME,
  POST_GET_UPDATES,
  POST_GET_WEBHOOK_INFO,
  POST_SEND_MESSAGE,
  POST_SET_WEBHOOK,
  POST_DELETE_WEBHOOK,
  GET_CHAT_ADMINISTRATORS,
  POST_GET_CHAT_ADMINISTRATORS,
  GET_CHAT_MEMBER_COUNT,
  POST_GET_CHAT_MEMBER_COUNT,
  GET_CHAT_MEMBER,
  POST_GET_CHAT_MEMBER,
  POST_SET_CHAT_TITLE,
  POST_SET_CHAT_DESCRIPTION,
  POST_SET_CHAT_PERMISSIONS,
  POST_BAN_CHAT_MEMBER,
  POST_UNBAN_CHAT_MEMBER,
  POST_RESTRICT_CHAT_MEMBER,
  POST_PROMOTE_CHAT_MEMBER,
  POST_LEAVE_CHAT,
  POST_CREATE_CHAT_INVITE_LINK,
  POST_EDIT_CHAT_INVITE_LINK,
  POST_REVOKE_CHAT_INVITE_LINK,
  POST_APPROVE_CHAT_JOIN_REQUEST,
  POST_DECLINE_CHAT_JOIN_REQUEST,
  POST_CREATE_FORUM_TOPIC,
  POST_EDIT_FORUM_TOPIC,
  POST_CLOSE_FORUM_TOPIC,
  POST_REOPEN_FORUM_TOPIC,
  POST_DELETE_FORUM_TOPIC,
} from "./route-inputs.js";
import { ZERO_ADMIN_RIGHTS, adminRightsFromFlags } from "./membership.js";
import { telegramOk } from "./serializers.js";

function botActor(c: Context): { kind: "bot"; botId: number; sid?: string } {
  const session = c.get("session") as { bot_id?: unknown; sid?: unknown } | undefined;
  const botId = typeof session?.bot_id === "number" ? session.bot_id : Number(session?.bot_id);
  return { kind: "bot", botId, ...(typeof session?.sid === "string" ? { sid: session.sid } : {}) };
}

async function mediaInput(value: unknown): Promise<string | { bytes: Buffer; filename?: string; mimeType?: string }> {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || !("arrayBuffer" in value) || typeof (value as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
    telegramFail(400, 400, "Bad Request: media must be a file upload or file_id");
  }
  const file = value as { arrayBuffer(): Promise<ArrayBuffer>; name?: unknown; type?: unknown };
  return {
    bytes: Buffer.from(await file.arrayBuffer()),
    ...(typeof file.name === "string" ? { filename: file.name } : {}),
    ...(typeof file.type === "string" && file.type ? { mimeType: file.type } : {}),
  };
}

function downloadMetadata(content: Buffer, mimeType: string | null): Record<string, string | number | null> {
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.length,
    mime_type: mimeType,
  };
}

function captureDelta<T>(fn: (report: (delta: StateDelta) => void) => T): { value: T; delta: StateDelta } {
  let delta: StateDelta = null;
  const value = fn((next) => { delta = next; });
  return { value, delta };
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
      const result = captureDelta((report) =>
        domain.sendMessage(
          botActor(c),
          {
            chat_id: parsed.body.chat_id,
            text: parsed.body.text,
            reply_to_message_id: parsed.body.reply_to_message_id,
            message_thread_id: parsed.body.message_thread_id,
            reply_markup: parsed.body.reply_markup,
          },
          report,
        ),
      );
      return { status: 200, body: telegramOk(result.value), delta: result.delta };
    }),
  );

  const mediaRoute = (declaration: typeof POST_SEND_PHOTO, kind: "photo" | "document" | "video" | "audio" | "voice", field: "photo" | "document" | "video" | "audio" | "voice") => {
    mountDeclaredRoute(app, declaration, recorder.handle({ mutation: true, captureRequestBody: false }, async (c) => {
      const parsed = await declaration.parse(c.req);
      const media = await mediaInput((parsed.body as Record<string, unknown>)[field]);
      const result = captureDelta((report) => domain.sendMedia(botActor(c), { chat_id: parsed.body.chat_id, kind, media, caption: parsed.body.caption, message_thread_id: parsed.body.message_thread_id }, report));
      return { status: 200, body: telegramOk(result.value), delta: result.delta };
    }));
  };
  mediaRoute(POST_SEND_PHOTO, "photo", "photo");
  mediaRoute(POST_SEND_DOCUMENT as unknown as typeof POST_SEND_PHOTO, "document", "document");
  mediaRoute(POST_SEND_VIDEO as unknown as typeof POST_SEND_PHOTO, "video", "video");
  mediaRoute(POST_SEND_AUDIO as unknown as typeof POST_SEND_PHOTO, "audio", "audio");
  mediaRoute(POST_SEND_VOICE as unknown as typeof POST_SEND_PHOTO, "voice", "voice");

  mountDeclaredRoute(app, POST_EDIT_MESSAGE_CAPTION, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_EDIT_MESSAGE_CAPTION.parse(c.req);
    const result = captureDelta((report) => domain.editMessageCaption(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(result.value), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_SEND_MEDIA_GROUP, recorder.handle({ mutation: true, captureRequestBody: false }, async (c) => {
    const parsed = await POST_SEND_MEDIA_GROUP.parse(c.req);
    const media = await Promise.all(parsed.body.media.map(async (item) => {
      if (!item.media.startsWith("attach://")) return item;
      const attachment = parsed.attachments?.[item.media.slice("attach://".length)];
      if (!attachment || typeof attachment === "string") telegramFail(400, 400, "Bad Request: attachment not found");
      return { ...item, media: await mediaInput(attachment) };
    }));
    const result = captureDelta((report) => domain.sendMediaGroup(botActor(c), { chat_id: parsed.body.chat_id, media, message_thread_id: parsed.body.message_thread_id }, report));
    return { status: 200, body: telegramOk(result.value), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_GET_FILE, recorder.handle({ mutation: false }, async (c) => {
    const parsed = await POST_GET_FILE.parse(c.req);
    return { status: 200, body: telegramOk(domain.getFile(botActor(c), parsed.body.file_id)) };
  }));
  mountDeclaredRoute(app, POST_SEND_CHAT_ACTION, recorder.handle({ mutation: false }, async (c) => {
    const parsed = await POST_SEND_CHAT_ACTION.parse(c.req);
    return { status: 200, body: telegramOk(domain.sendChatAction(botActor(c), parsed.body)) };
  }));
  // Byte downloads have no Bot API JSON envelope, but their path is still declared.
  mountDeclaredRoute(app, GET_FILE_DOWNLOAD, async (c: Context) => {
    const started = Date.now();
    try {
      const parsed = await GET_FILE_DOWNLOAD.parse(c.req);
      const file = domain.downloadFile(botActor(c), parsed.path.file_path);
      recorder.recordRawResponse(c, { started, status: 200, body: { media: downloadMetadata(file.content, file.mimeType) }, error: null });
      return c.body(new Uint8Array(file.content), 200, file.mimeType ? { "content-type": file.mimeType } : undefined);
    } catch {
      const body = { ok: false, error_code: 404, description: "Not Found" };
      recorder.recordRawResponse(c, { started, status: 404, body, error: "Not Found" });
      return c.json(body, 404);
    }
  });

  mountDeclaredRoute(app, POST_EDIT_MESSAGE_REPLY_MARKUP, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_EDIT_MESSAGE_REPLY_MARKUP.parse(c.req);
    const result = captureDelta((report) => domain.editMessageReplyMarkup(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(result.value), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_PIN_CHAT_MESSAGE, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_PIN_CHAT_MESSAGE.parse(c.req);
    const result = captureDelta((report) => domain.pinChatMessage(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_UNPIN_CHAT_MESSAGE, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_UNPIN_CHAT_MESSAGE.parse(c.req);
    const result = captureDelta((report) => domain.unpinChatMessage(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_UNPIN_ALL_CHAT_MESSAGES, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_UNPIN_ALL_CHAT_MESSAGES.parse(c.req);
    const result = captureDelta((report) => domain.unpinAllChatMessages(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_ANSWER_CALLBACK_QUERY, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_ANSWER_CALLBACK_QUERY.parse(c.req);
    const result = captureDelta((report) => domain.answerCallbackQuery(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_SEND_POLL, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_SEND_POLL.parse(c.req);
    const result = captureDelta((report) => domain.sendPoll(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(result.value), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_STOP_POLL, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_STOP_POLL.parse(c.req);
    const result = captureDelta((report) => domain.stopPoll(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(result.value), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_SET_MESSAGE_REACTION, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_SET_MESSAGE_REACTION.parse(c.req);
    const result = captureDelta((report) => domain.setMessageReaction(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));

  mountDeclaredRoute(
    app,
    POST_EDIT_MESSAGE_TEXT,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_EDIT_MESSAGE_TEXT.parse(c.req);
      const result = captureDelta((report) => domain.editMessageText(botActor(c), parsed.body, report));
      return { status: 200, body: telegramOk(result.value), delta: result.delta };
    }),
  );
  mountDeclaredRoute(
    app,
    POST_DELETE_MESSAGE,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_DELETE_MESSAGE.parse(c.req);
      const result = captureDelta((report) => domain.deleteMessage(botActor(c), parsed.body, report));
      return { status: 200, body: telegramOk(true), delta: result.delta };
    }),
  );
  mountDeclaredRoute(
    app,
    POST_DELETE_MESSAGES,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_DELETE_MESSAGES.parse(c.req);
      const result = captureDelta((report) => domain.deleteMessages(botActor(c), parsed.body, report));
      return { status: 200, body: telegramOk(true), delta: result.delta };
    }),
  );
  mountDeclaredRoute(
    app,
    POST_FORWARD_MESSAGE,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_FORWARD_MESSAGE.parse(c.req);
      const result = captureDelta((report) => domain.forwardMessage(botActor(c), parsed.body, report));
      return { status: 200, body: telegramOk(result.value), delta: result.delta };
    }),
  );
  mountDeclaredRoute(
    app,
    POST_COPY_MESSAGE,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_COPY_MESSAGE.parse(c.req);
      const result = captureDelta((report) => domain.copyMessage(botActor(c), parsed.body, report));
      return { status: 200, body: telegramOk(result.value), delta: result.delta };
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
      const result = captureDelta((report) => domain.setWebhook(botActor(c), parsed.body, report));
      return { status: 200, body: telegramOk(true), delta: result.delta };
    }),
  );
  mountDeclaredRoute(
    app,
    POST_DELETE_WEBHOOK,
    recorder.handle({ mutation: true }, async (c) => {
      const parsed = await POST_DELETE_WEBHOOK.parse(c.req);
      const result = captureDelta((report) => domain.deleteWebhook(botActor(c), parsed.body, report));
      return { status: 200, body: telegramOk(true), delta: result.delta };
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

  mountDeclaredRoute(app, GET_CHAT_ADMINISTRATORS, recorder.handle({ mutation: false }, async (c) => {
    const parsed = await GET_CHAT_ADMINISTRATORS.parse(c.req);
    return { status: 200, body: telegramOk(domain.getChatAdministrators(botActor(c), parsed.query.chat_id)) };
  }));
  mountDeclaredRoute(app, POST_GET_CHAT_ADMINISTRATORS, recorder.handle({ mutation: false }, async (c) => {
    const parsed = await POST_GET_CHAT_ADMINISTRATORS.parse(c.req);
    return { status: 200, body: telegramOk(domain.getChatAdministrators(botActor(c), parsed.body.chat_id)) };
  }));
  mountDeclaredRoute(app, GET_CHAT_MEMBER_COUNT, recorder.handle({ mutation: false }, async (c) => {
    const parsed = await GET_CHAT_MEMBER_COUNT.parse(c.req);
    return { status: 200, body: telegramOk(domain.getChatMemberCount(botActor(c), parsed.query.chat_id)) };
  }));
  mountDeclaredRoute(app, POST_GET_CHAT_MEMBER_COUNT, recorder.handle({ mutation: false }, async (c) => {
    const parsed = await POST_GET_CHAT_MEMBER_COUNT.parse(c.req);
    return { status: 200, body: telegramOk(domain.getChatMemberCount(botActor(c), parsed.body.chat_id)) };
  }));
  mountDeclaredRoute(app, GET_CHAT_MEMBER, recorder.handle({ mutation: false }, async (c) => {
    const parsed = await GET_CHAT_MEMBER.parse(c.req);
    return { status: 200, body: telegramOk(domain.getChatMember(botActor(c), parsed.query)) };
  }));
  mountDeclaredRoute(app, POST_GET_CHAT_MEMBER, recorder.handle({ mutation: false }, async (c) => {
    const parsed = await POST_GET_CHAT_MEMBER.parse(c.req);
    return { status: 200, body: telegramOk(domain.getChatMember(botActor(c), parsed.body)) };
  }));
  mountDeclaredRoute(app, POST_SET_CHAT_TITLE, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_SET_CHAT_TITLE.parse(c.req);
    const result = captureDelta((report) => domain.setChatTitle(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_SET_CHAT_DESCRIPTION, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_SET_CHAT_DESCRIPTION.parse(c.req);
    const result = captureDelta((report) => domain.setChatDescription(botActor(c), {
      ...parsed.body,
      description: parsed.body.description ?? "",
    }, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_SET_CHAT_PERMISSIONS, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_SET_CHAT_PERMISSIONS.parse(c.req);
    const result = captureDelta((report) => domain.setChatPermissions(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_BAN_CHAT_MEMBER, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_BAN_CHAT_MEMBER.parse(c.req);
    const result = captureDelta((report) => domain.banChatMember(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_UNBAN_CHAT_MEMBER, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_UNBAN_CHAT_MEMBER.parse(c.req);
    const result = captureDelta((report) => domain.unbanChatMember(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_RESTRICT_CHAT_MEMBER, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_RESTRICT_CHAT_MEMBER.parse(c.req);
    const result = captureDelta((report) => domain.restrictChatMember(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_PROMOTE_CHAT_MEMBER, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_PROMOTE_CHAT_MEMBER.parse(c.req);
    const { chat_id, user_id, ...flags } = parsed.body;
    const result = captureDelta((report) => domain.promoteChatMember(botActor(c), {
      chat_id,
      user_id,
      rights: adminRightsFromFlags(flags, ZERO_ADMIN_RIGHTS),
    }, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_LEAVE_CHAT, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_LEAVE_CHAT.parse(c.req);
    const result = captureDelta((report) => domain.leaveChat(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_CREATE_CHAT_INVITE_LINK, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_CREATE_CHAT_INVITE_LINK.parse(c.req);
    const result = captureDelta((report) => domain.createChatInviteLink(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(result.value), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_EDIT_CHAT_INVITE_LINK, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_EDIT_CHAT_INVITE_LINK.parse(c.req);
    const result = captureDelta((report) => domain.editChatInviteLink(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(result.value), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_REVOKE_CHAT_INVITE_LINK, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_REVOKE_CHAT_INVITE_LINK.parse(c.req);
    const result = captureDelta((report) => domain.revokeChatInviteLink(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(result.value), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_APPROVE_CHAT_JOIN_REQUEST, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_APPROVE_CHAT_JOIN_REQUEST.parse(c.req);
    const result = captureDelta((report) => domain.approveChatJoinRequest(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_DECLINE_CHAT_JOIN_REQUEST, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_DECLINE_CHAT_JOIN_REQUEST.parse(c.req);
    const result = captureDelta((report) => domain.declineChatJoinRequest(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_CREATE_FORUM_TOPIC, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_CREATE_FORUM_TOPIC.parse(c.req);
    const result = captureDelta((report) => domain.createForumTopic(botActor(c), {
      chat_id: parsed.body.chat_id,
      title: parsed.body.name,
      icon_color: parsed.body.icon_color,
      icon_emoji_id: parsed.body.icon_custom_emoji_id,
    }, report));
    return { status: 200, body: telegramOk(result.value), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_EDIT_FORUM_TOPIC, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_EDIT_FORUM_TOPIC.parse(c.req);
    const result = captureDelta((report) => domain.editForumTopic(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_CLOSE_FORUM_TOPIC, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_CLOSE_FORUM_TOPIC.parse(c.req);
    const result = captureDelta((report) => domain.closeForumTopic(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_REOPEN_FORUM_TOPIC, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_REOPEN_FORUM_TOPIC.parse(c.req);
    const result = captureDelta((report) => domain.reopenForumTopic(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
  mountDeclaredRoute(app, POST_DELETE_FORUM_TOPIC, recorder.handle({ mutation: true }, async (c) => {
    const parsed = await POST_DELETE_FORUM_TOPIC.parse(c.req);
    const result = captureDelta((report) => domain.deleteForumTopic(botActor(c), parsed.body, report));
    return { status: 200, body: telegramOk(true), delta: result.delta };
  }));
}
