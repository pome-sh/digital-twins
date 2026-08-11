// SPDX-License-Identifier: Apache-2.0
//
// Slack Web API domain routes (F-683, F-1179). Pure domain shape: every handler
// maps DECLARED inputs onto a SlackDomain call and wraps the result in the
// Slack `{ok:true, ...}` envelope. The declaration in `./route-inputs.ts` is
// both the mounted method/path and the only parse — a handler is handed the
// parsed inputs and no request object, so it cannot read around its own
// declaration. Everything cross-cutting — auth, recording, redaction, error
// envelopes, the 501 catch-all — is the engine's (`@pome-sh/sdk`), wired
// through the twin manifest in ./twin.ts.

import type { Context, Hono } from "hono";
import type { RouteContext } from "@pome-sh/sdk";
import {
  UndeclaredInputError,
  mountDeclaredRoute,
  type DeclaredRouteInputs,
  type RouteInputDeclaration,
  type RouteInputSpec,
} from "@pome-sh/sdk/route-inputs";
import type { StateDelta } from "@pome-sh/wire";
import type { SlackDomain, Actor } from "./domain/index.js";
import { TwinError, validationFailed } from "./errors.js";
import {
  SLACK_READS,
  SLACK_WRITES,
  type SlackDeclaredArgs,
  type SlackInputShape,
  type SlackReadSurfaces,
  type SlackWriteSurface,
} from "./route-inputs.js";
import { slackOk } from "./serializers.js";

type DeltaHook = (delta: StateDelta) => void;

function actorFrom(c: Context): Actor {
  const session = c.get("session") as { login?: unknown } | undefined;
  return { login: typeof session?.login === "string" ? session.login : undefined };
}

/**
 * Parse a request through its own declaration, projecting the declaration's
 * refusals into Slack's `{ok:false, error}` envelope.
 *
 * `UndeclaredInputError` becomes `invalid_arguments` — Slack's own documented
 * code for an argument it does not accept (`errors.ts`) — carrying the offending
 * names in `response_metadata.messages`, which is where `slackErrorEnvelope`
 * already reports a bad ARGUMENT VALUE. A `z.ZodError` needs no conversion:
 * that same hook already renders it as 200 `{ok:false, error:"invalid_arguments",
 * response_metadata:{messages}}`, so a bad declared value is never a 500.
 */
async function parseDeclared<S extends RouteInputSpec>(
  declaration: RouteInputDeclaration<S>,
  c: Context
): Promise<DeclaredRouteInputs<S>> {
  try {
    return await declaration.parse(c.req);
  } catch (error) {
    if (error instanceof UndeclaredInputError) {
      validationFailed("invalid_arguments", {
        response_metadata: { messages: [error.message] },
      });
    }
    throw error;
  }
}

export function registerSlackRoutes(app: Hono, { domain, recorder }: RouteContext<SlackDomain>): void {
  /**
   * A read endpoint. Slack serves its reads on GET and on POST, so this mounts
   * two routes from two declarations over one shape: GET takes the arguments as
   * query inputs, POST as form/JSON body inputs.
   */
  const read = <S extends SlackInputShape>(
    surfaces: SlackReadSurfaces<S>,
    call: (args: SlackDeclaredArgs<S>, actor: Actor) => Record<string, unknown>
  ) => {
    mountDeclaredRoute(
      app,
      surfaces.get,
      recorder.handle({ mutation: false }, async (c) => ({
        status: 200,
        body: slackOk(call((await parseDeclared(surfaces.get, c)).query, actorFrom(c))),
      }))
    );
    mountDeclaredRoute(
      app,
      surfaces.post,
      recorder.handle({ mutation: false }, async (c) => ({
        status: 200,
        body: slackOk(call((await parseDeclared(surfaces.post, c)).body, actorFrom(c))),
      }))
    );
  };

  /** A mutation endpoint (POST only) with state-delta capture. */
  const write = <S extends SlackInputShape>(
    declaration: SlackWriteSurface<S>,
    call: (args: SlackDeclaredArgs<S>, actor: Actor, delta: DeltaHook) => Record<string, unknown>,
    mutated: (result: Record<string, unknown>) => boolean = () => true
  ) => {
    mountDeclaredRoute(
      app,
      declaration,
      recorder.handle({ mutation: true }, async (c) => {
        let delta: StateDelta = null;
        const inputs = await parseDeclared(declaration, c);
        const result = call(inputs.body, actorFrom(c), (d) => {
          delta = d;
        });
        return { status: 200, body: slackOk(result), delta, mutation: mutated(result) };
      })
    );
  };

  // ── Auth ──────────────────────────────────────────────────────────────────
  read(SLACK_READS.authTest, (_args, actor) => domain.authTest(actor));

  // ── Conversations ─────────────────────────────────────────────────────────
  read(SLACK_READS.conversationsList, (args) =>
    domain.conversationsList({
      types: args.types,
      exclude_archived: args.exclude_archived,
      limit: args.limit,
      cursor: args.cursor,
      team_id: args.team_id,
    })
  );

  read(SLACK_READS.conversationsInfo, (args, actor) => {
    if (!args.channel) throw new TwinError("channel_not_found", 400, "channel_not_found");
    return domain.conversationsInfo(
      { channel: args.channel, include_num_members: args.include_num_members },
      actor
    );
  });

  write(SLACK_WRITES.conversationsCreate, (args, actor, delta) =>
    domain.conversationsCreate(
      { name: args.name, is_private: args.is_private, team_id: args.team_id },
      actor,
      delta
    )
  );

  write(SLACK_WRITES.conversationsArchive, (args, actor, delta) =>
    domain.conversationsArchive({ channel: args.channel }, actor, delta)
  );

  write(SLACK_WRITES.conversationsInvite, (args, actor, delta) =>
    domain.conversationsInvite({ channel: args.channel, users: args.users }, actor, delta)
  );

  write(SLACK_WRITES.conversationsJoin, (args, actor, delta) =>
    domain.conversationsJoin({ channel: args.channel }, actor, delta)
  );

  write(SLACK_WRITES.conversationsLeave, (args, actor, delta) =>
    domain.conversationsLeave({ channel: args.channel }, actor, delta)
  );

  write(SLACK_WRITES.conversationsKick, (args, actor, delta) =>
    domain.conversationsKick({ channel: args.channel, user: args.user }, actor, delta)
  );

  read(SLACK_READS.conversationsMembers, (args, actor) =>
    domain.conversationsMembers(
      { channel: args.channel, limit: args.limit, cursor: args.cursor },
      actor
    )
  );

  read(SLACK_READS.conversationsHistory, (args, actor) =>
    domain.conversationsHistory(
      {
        channel: args.channel,
        cursor: args.cursor,
        inclusive: args.inclusive,
        latest: args.latest,
        limit: args.limit,
        oldest: args.oldest,
      },
      actor
    )
  );

  read(SLACK_READS.conversationsReplies, (args, actor) =>
    domain.conversationsReplies(
      {
        channel: args.channel,
        ts: args.ts,
        cursor: args.cursor,
        inclusive: args.inclusive,
        latest: args.latest,
        limit: args.limit,
        oldest: args.oldest,
      },
      actor
    )
  );

  write(
    SLACK_WRITES.conversationsOpen,
    (args, actor, delta) =>
      domain.conversationsOpen(
        { users: args.users, channel: args.channel, return_im: args.return_im },
        actor,
        delta
      ),
    (result) => !result.already_open
  );

  write(SLACK_WRITES.conversationsSetTopic, (args, actor, delta) =>
    domain.conversationsSetTopic({ channel: args.channel, topic: args.topic }, actor, delta)
  );

  write(SLACK_WRITES.conversationsSetPurpose, (args, actor, delta) =>
    domain.conversationsSetPurpose({ channel: args.channel, purpose: args.purpose }, actor, delta)
  );

  // ── Chat ──────────────────────────────────────────────────────────────────
  write(SLACK_WRITES.chatPostMessage, (args, actor, delta) =>
    domain.chatPostMessage(
      {
        channel: args.channel,
        text: args.text,
        blocks: args.blocks,
        attachments: args.attachments,
        thread_ts: args.thread_ts,
        reply_broadcast: args.reply_broadcast,
        icon_emoji: args.icon_emoji,
        icon_url: args.icon_url,
        username: args.username,
        as_user: args.as_user,
      },
      actor,
      delta
    )
  );

  write(SLACK_WRITES.chatUpdate, (args, actor, delta) =>
    domain.chatUpdate(
      {
        channel: args.channel,
        ts: args.ts,
        text: args.text,
        blocks: args.blocks,
        attachments: args.attachments,
      },
      actor,
      delta
    )
  );

  write(SLACK_WRITES.chatDelete, (args, actor, delta) =>
    domain.chatDelete({ channel: args.channel, ts: args.ts }, actor, delta)
  );

  write(SLACK_WRITES.chatScheduleMessage, (args, actor, delta) =>
    domain.chatScheduleMessage(
      {
        channel: args.channel,
        text: args.text,
        post_at: args.post_at,
        thread_ts: args.thread_ts,
        blocks: args.blocks,
      },
      actor,
      delta
    )
  );

  write(SLACK_WRITES.chatDeleteScheduledMessage, (args, actor, delta) =>
    domain.chatDeleteScheduledMessage(
      { channel: args.channel, scheduled_message_id: args.scheduled_message_id },
      actor,
      delta
    )
  );

  // ── Reactions ─────────────────────────────────────────────────────────────
  write(SLACK_WRITES.reactionsAdd, (args, actor, delta) =>
    domain.reactionsAdd(
      { channel: args.channel, timestamp: args.timestamp, name: args.name },
      actor,
      delta
    )
  );

  write(SLACK_WRITES.reactionsRemove, (args, actor, delta) =>
    domain.reactionsRemove(
      { channel: args.channel, timestamp: args.timestamp, name: args.name },
      actor,
      delta
    )
  );

  read(SLACK_READS.reactionsGet, (args, actor) =>
    domain.reactionsGet(
      { channel: args.channel, timestamp: args.timestamp, full: args.full },
      actor
    )
  );

  // ── Users ─────────────────────────────────────────────────────────────────
  read(SLACK_READS.usersList, (args) =>
    domain.usersList({
      cursor: args.cursor,
      limit: args.limit,
      include_locale: args.include_locale,
      team_id: args.team_id,
    })
  );

  read(SLACK_READS.usersInfo, (args) =>
    domain.usersInfo({ user: args.user, include_locale: args.include_locale })
  );

  read(SLACK_READS.usersLookupByEmail, (args) => domain.usersLookupByEmail({ email: args.email }));

  read(SLACK_READS.usersProfileGet, (args, actor) =>
    domain.usersProfileGet({ user: args.user, include_labels: args.include_labels }, actor)
  );

  write(SLACK_WRITES.usersProfileSet, (args, actor, delta) =>
    domain.usersProfileSet(
      { user: args.user, profile: args.profile, name: args.name, value: args.value },
      actor,
      delta
    )
  );

  // ── Pins ──────────────────────────────────────────────────────────────────
  write(SLACK_WRITES.pinsAdd, (args, actor, delta) =>
    domain.pinsAdd({ channel: args.channel, timestamp: args.timestamp }, actor, delta)
  );

  write(SLACK_WRITES.pinsRemove, (args, actor, delta) =>
    domain.pinsRemove({ channel: args.channel, timestamp: args.timestamp }, actor, delta)
  );

  read(SLACK_READS.pinsList, (args, actor) => domain.pinsList({ channel: args.channel }, actor));

  // ── Search ────────────────────────────────────────────────────────────────
  read(SLACK_READS.searchMessages, (args, actor) =>
    domain.searchMessages(
      {
        query: args.query,
        count: args.count,
        page: args.page,
        sort: args.sort,
        sort_dir: args.sort_dir,
        highlight: args.highlight,
      },
      actor
    )
  );

  // ── Files (metadata-only) ─────────────────────────────────────────────────
  write(SLACK_WRITES.filesUpload, (args, actor, delta) =>
    domain.filesUpload(
      {
        channels: args.channels,
        filename: args.filename,
        title: args.title,
        filetype: args.filetype,
        content: args.content,
        initial_comment: args.initial_comment,
        thread_ts: args.thread_ts,
      },
      actor,
      delta
    )
  );

  read(SLACK_READS.filesInfo, (args) => domain.filesInfo({ file: args.file }));

  read(SLACK_READS.filesList, (args) =>
    domain.filesList({
      channel: args.channel,
      user: args.user,
      count: args.count,
      page: args.page,
      types: args.types,
    })
  );

  write(SLACK_WRITES.filesDelete, (args, actor, delta) =>
    domain.filesDelete({ file: args.file }, actor, delta)
  );

  // ── Bookmarks ─────────────────────────────────────────────────────────────
  write(SLACK_WRITES.bookmarksAdd, (args, actor, delta) =>
    domain.bookmarksAdd(
      {
        channel_id: args.channel_id,
        title: args.title,
        type: args.type,
        link: args.link,
        emoji: args.emoji,
        entity_id: args.entity_id,
      },
      actor,
      delta
    )
  );

  write(SLACK_WRITES.bookmarksRemove, (args, actor, delta) =>
    domain.bookmarksRemove(
      { channel_id: args.channel_id, bookmark_id: args.bookmark_id },
      actor,
      delta
    )
  );

  read(SLACK_READS.bookmarksList, (args) => domain.bookmarksList({ channel_id: args.channel_id }));

  // ── Team ──────────────────────────────────────────────────────────────────
  read(SLACK_READS.teamInfo, (args) => domain.teamInfo({ team: args.team }));

  // ── Canvases (Wave 3) ─────────────────────────────────────────────────────
  write(SLACK_WRITES.canvasesCreate, (args, actor, delta) =>
    domain.canvasesCreate(
      {
        title: args.title,
        document_content: args.document_content,
        channel_id: args.channel_id,
      },
      actor,
      delta
    )
  );

  write(SLACK_WRITES.canvasesEdit, (args, actor, delta) =>
    domain.canvasesEdit({ canvas_id: args.canvas_id, changes: args.changes }, actor, delta)
  );

  write(SLACK_WRITES.canvasesDelete, (args, actor, delta) =>
    domain.canvasesDelete({ canvas_id: args.canvas_id }, actor, delta)
  );

  // ── Emoji (Wave 3) ────────────────────────────────────────────────────────
  read(SLACK_READS.emojiList, (args) =>
    domain.emojiList({ include_categories: args.include_categories })
  );
}
