// SPDX-License-Identifier: Apache-2.0
//
// F-1179 — every input every Slack Web-API route accepts, as the schemas that
// validate it. `routes.ts` mounts these and its handlers see nothing else.
//
// # Slack's two surfaces per read method
//
// Slack mounts its read methods on GET and on POST, so each read endpoint is
// TWO registered routes and therefore two declarations sharing one shape. The
// artifact keys on `"<METHOD> <path>"` and pome-cloud normalises per method, so
// one declaration cannot cover both.
//
// # Where an argument is declared, and why that is a decision
//
// The pre-F-1179 handler read `{...c.req.query(), ...body}` — query OR body,
// body wins, on every method. The mechanism refuses one name declared in two
// locations (a name in two places makes the published surface ambiguous), so
// "either location" is not expressible. What is declared instead is what Slack
// documents and what every client does:
//
//   * GET  — the arguments are `query` inputs.
//   * POST — the arguments are `body` inputs, `bodyEncoding: "form"` (Slack's
//     SDKs send `application/x-www-form-urlencoded`; MCP clients send JSON;
//     the encoding handles both).
//
// A POST that puts its arguments in the query string is therefore refused
// where it used to be accepted. Nothing in this package's suites, its smoke
// script, or the bundled examples does that: the two POSTs that carry
// arguments over the wire send a form body (`test/auth.test.ts` "accepts
// token=<jwt> in form-encoded POST body", `scripts/smoke.ts` step 15) and
// every query-argument call is a GET.
//
// # `token` is an ambient input on every surface
//
// `twin.ts` declares `tokenResolvers: [queryTokenResolver("token"),
// formTokenResolver("token")]`, so `token` genuinely arrives on EVERY endpoint
// and is consumed by the engine's auth middleware before a handler runs. It is
// an input this twin accepts everywhere, so it is declared everywhere — in
// `query` on GET and in `body` on POST, following the rule above. Declaring it
// in only one location would make the other refuse a request the engine had
// already authenticated (`test/auth.test.ts` proves both arrive).
//
// # The schemas say what the twin does, not what Slack declares
//
// The old handlers picked fields out of a merged bag with `asString(args.x)` /
// `asOptionalString` / `asBool(args.x,false)` / `optNum(args.x,n)`. Those
// coercions ARE the twin's acceptance, so the schemas below reproduce them
// rather than tightening to real Slack's requiredness — `asString` answers `""`
// for a missing value, so `channel` on `conversations.archive` is declared
// optional-with-`""`, and the twin's own `channel_not_found` still answers.
// Where that diverges from what Slack declares, pome-cloud's lane reports the
// divergence; inventing requiredness here would change behaviour and report a
// match nobody measured.

import { z } from "zod";
import {
  booleanInput,
  integerInput,
  routeInputDeclarer,
  type RouteInputDeclaration,
} from "@pome-sh/sdk/route-inputs";

/**
 * F-1372 — Slack accepts an argument it does not know and gets on with the
 * call, so this twin does too.
 *
 * Measured 2026-08-09 against `slack.com/api`: `api.test` — the one Web API
 * method that answers without a token — returned `{"ok":true,"args":
 * {"pome_undeclared_probe":"x"}}` for the argument as a GET query key and again
 * as a POST form field. Slack's own Web API page names three ways to pass
 * arguments and no way to get one rejected: there is no `unknown_argument` in
 * its error vocabulary, and `invalid_arguments` — the code this twin refuses
 * with today — is documented for arguments a method HAS whose values are wrong.
 * `docs/undeclared-route-inputs.md` carries the transcript.
 *
 * The `token` argument is the reason this matters more here than anywhere else:
 * it rides on every method, so an SDK that sends one extra field alongside it
 * met a refusal on all 62 surfaces at once.
 */
const declareInputs = routeInputDeclarer("ignore");

/** A route's declared input names and the schemas that validate them. */
export type SlackInputShape = Record<string, z.ZodType>;

/** A read endpoint's GET spec: the arguments are query inputs. */
type ReadSpec<S extends SlackInputShape> = { method: "GET"; path: string; query: S };

/** A POST spec — a mutation, or a read's POST half: the arguments are body inputs. */
type PostSpec<S extends SlackInputShape> = {
  method: "POST";
  path: string;
  body: S;
  bodyEncoding: "form";
};

/**
 * The values a handler receives for shape `S` — `{ [K in keyof S]: z.infer<S[K]> }`,
 * but spelled as the declaration's own output so the two are the SAME type to
 * the compiler rather than two structurally-equal ones. Both halves of a read
 * carry it: GET puts the arguments in `query`, POST in `body`.
 */
export type SlackDeclaredArgs<S extends SlackInputShape> = Awaited<
  ReturnType<RouteInputDeclaration<ReadSpec<S>>["parse"]>
>["query"];

/** `token` rides on every endpoint: the engine resolves it from either location. */
const AMBIENT_INPUTS = { token: z.string().optional() };

type WithAmbient<S extends SlackInputShape> = S & typeof AMBIENT_INPUTS;

/** The two surfaces one Slack read endpoint occupies. */
export interface SlackReadSurfaces<S extends SlackInputShape> {
  readonly get: RouteInputDeclaration<ReadSpec<S>>;
  readonly post: RouteInputDeclaration<PostSpec<S>>;
}

/** The single surface a Slack mutation occupies. */
export type SlackWriteSurface<S extends SlackInputShape> = RouteInputDeclaration<PostSpec<S>>;

function slackRead<S extends SlackInputShape>(
  path: string,
  args: S
): SlackReadSurfaces<WithAmbient<S>> {
  const shape = { ...AMBIENT_INPUTS, ...args } as WithAmbient<S>;
  return {
    get: declareInputs({ method: "GET", path, query: shape }),
    post: declareInputs({ method: "POST", path, body: shape, bodyEncoding: "form" }),
  };
}

function slackWrite<S extends SlackInputShape>(
  path: string,
  args: S
): SlackWriteSurface<WithAmbient<S>> {
  const shape = { ...AMBIENT_INPUTS, ...args } as WithAmbient<S>;
  return declareInputs({ method: "POST", path, body: shape, bodyEncoding: "form" });
}

// ─── The twin's coercions, as schemas ────────────────────────────────────────
//
// One helper per `util.ts` coercion the handlers used, so the mapping from the
// old call site to the new declaration is one-to-one and checkable by eye.

/** `asString(args.x)`: a missing value reads as `""`, never as an error. */
const emptyIfAbsent = (): z.ZodType<string> => z.string().default("");

/** `asOptionalString(args.x)`: absent, or present and empty, is absent. */
const absentIfEmpty = (): z.ZodType<string | undefined> =>
  z
    .string()
    .optional()
    .transform((value) => (value ? value : undefined));

/** `asBool(args.x, false)`, minus the silent fallback — see `booleanInput`. */
const falseIfAbsent = (): z.ZodType<boolean> => booleanInput.default(false);

/** `optNum(args.x, n)`: absent stays absent, so the domain applies its default. */
const optionalInteger = (): z.ZodType<number | undefined> => integerInput().optional();

/** `asNumber(args.x, 0)`: a missing value reads as `0`. */
const zeroIfAbsent = (): z.ZodType<number> => integerInput().default(0);

/** A value the handler forwards without inspecting (canvas document bodies). */
const opaque = (): z.ZodType<unknown> => z.unknown().optional();

// ─── Reads: mounted on GET and POST ──────────────────────────────────────────

export const SLACK_READS = {
  authTest: slackRead("/auth.test", {}),

  conversationsList: slackRead("/conversations.list", {
    types: absentIfEmpty(),
    exclude_archived: falseIfAbsent(),
    limit: optionalInteger(),
    cursor: absentIfEmpty(),
    team_id: absentIfEmpty(),
  }),

  // `channel` is read with `asOptionalString` and the handler raises Slack's own
  // `channel_not_found` when it is absent, so the schema stays optional.
  conversationsInfo: slackRead("/conversations.info", {
    channel: absentIfEmpty(),
    include_num_members: falseIfAbsent(),
  }),

  conversationsMembers: slackRead("/conversations.members", {
    channel: emptyIfAbsent(),
    limit: optionalInteger(),
    cursor: absentIfEmpty(),
  }),

  conversationsHistory: slackRead("/conversations.history", {
    channel: emptyIfAbsent(),
    cursor: absentIfEmpty(),
    inclusive: falseIfAbsent(),
    latest: absentIfEmpty(),
    limit: optionalInteger(),
    oldest: absentIfEmpty(),
  }),

  conversationsReplies: slackRead("/conversations.replies", {
    channel: emptyIfAbsent(),
    ts: emptyIfAbsent(),
    cursor: absentIfEmpty(),
    inclusive: falseIfAbsent(),
    latest: absentIfEmpty(),
    limit: optionalInteger(),
    oldest: absentIfEmpty(),
  }),

  reactionsGet: slackRead("/reactions.get", {
    channel: emptyIfAbsent(),
    timestamp: emptyIfAbsent(),
    full: falseIfAbsent(),
  }),

  usersList: slackRead("/users.list", {
    cursor: absentIfEmpty(),
    limit: optionalInteger(),
    include_locale: falseIfAbsent(),
    team_id: absentIfEmpty(),
  }),

  usersInfo: slackRead("/users.info", {
    user: emptyIfAbsent(),
    include_locale: falseIfAbsent(),
  }),

  usersLookupByEmail: slackRead("/users.lookupByEmail", { email: emptyIfAbsent() }),

  usersProfileGet: slackRead("/users.profile.get", {
    user: absentIfEmpty(),
    include_labels: falseIfAbsent(),
  }),

  pinsList: slackRead("/pins.list", { channel: emptyIfAbsent() }),

  searchMessages: slackRead("/search.messages", {
    query: emptyIfAbsent(),
    count: optionalInteger(),
    page: optionalInteger(),
    sort: absentIfEmpty(),
    sort_dir: absentIfEmpty(),
    highlight: falseIfAbsent(),
  }),

  filesInfo: slackRead("/files.info", { file: emptyIfAbsent() }),

  filesList: slackRead("/files.list", {
    channel: absentIfEmpty(),
    user: absentIfEmpty(),
    count: optionalInteger(),
    page: optionalInteger(),
    types: absentIfEmpty(),
  }),

  bookmarksList: slackRead("/bookmarks.list", { channel_id: emptyIfAbsent() }),

  teamInfo: slackRead("/team.info", { team: absentIfEmpty() }),

  // `domain.emojiList` reads no argument at all, and the pre-F-1179 handler
  // forwarded the whole merged bag — the silent hole this ticket exists to
  // close. `include_categories` is what Slack's `emoji.list` declares beyond
  // `token`, so that is the surface, and an unnamed argument is now refused.
  emojiList: slackRead("/emoji.list", { include_categories: falseIfAbsent() }),
};

// ─── Mutations: POST only ────────────────────────────────────────────────────

export const SLACK_WRITES = {
  conversationsCreate: slackWrite("/conversations.create", {
    name: emptyIfAbsent(),
    is_private: falseIfAbsent(),
    team_id: absentIfEmpty(),
  }),

  conversationsArchive: slackWrite("/conversations.archive", { channel: emptyIfAbsent() }),

  conversationsInvite: slackWrite("/conversations.invite", {
    channel: emptyIfAbsent(),
    users: emptyIfAbsent(),
  }),

  conversationsJoin: slackWrite("/conversations.join", { channel: emptyIfAbsent() }),

  conversationsLeave: slackWrite("/conversations.leave", { channel: emptyIfAbsent() }),

  conversationsKick: slackWrite("/conversations.kick", {
    channel: emptyIfAbsent(),
    user: emptyIfAbsent(),
  }),

  conversationsOpen: slackWrite("/conversations.open", {
    users: absentIfEmpty(),
    channel: absentIfEmpty(),
    return_im: falseIfAbsent(),
  }),

  conversationsSetTopic: slackWrite("/conversations.setTopic", {
    channel: emptyIfAbsent(),
    topic: emptyIfAbsent(),
  }),

  conversationsSetPurpose: slackWrite("/conversations.setPurpose", {
    channel: emptyIfAbsent(),
    purpose: emptyIfAbsent(),
  }),

  chatPostMessage: slackWrite("/chat.postMessage", {
    channel: emptyIfAbsent(),
    text: absentIfEmpty(),
    blocks: absentIfEmpty(),
    attachments: absentIfEmpty(),
    thread_ts: absentIfEmpty(),
    reply_broadcast: falseIfAbsent(),
    icon_emoji: absentIfEmpty(),
    icon_url: absentIfEmpty(),
    username: absentIfEmpty(),
    as_user: falseIfAbsent(),
  }),

  chatUpdate: slackWrite("/chat.update", {
    channel: emptyIfAbsent(),
    ts: emptyIfAbsent(),
    text: absentIfEmpty(),
    blocks: absentIfEmpty(),
    attachments: absentIfEmpty(),
  }),

  chatDelete: slackWrite("/chat.delete", {
    channel: emptyIfAbsent(),
    ts: emptyIfAbsent(),
  }),

  chatScheduleMessage: slackWrite("/chat.scheduleMessage", {
    channel: emptyIfAbsent(),
    text: emptyIfAbsent(),
    post_at: zeroIfAbsent(),
    thread_ts: absentIfEmpty(),
    blocks: absentIfEmpty(),
  }),

  chatDeleteScheduledMessage: slackWrite("/chat.deleteScheduledMessage", {
    channel: emptyIfAbsent(),
    scheduled_message_id: emptyIfAbsent(),
  }),

  reactionsAdd: slackWrite("/reactions.add", {
    channel: emptyIfAbsent(),
    timestamp: emptyIfAbsent(),
    name: emptyIfAbsent(),
  }),

  reactionsRemove: slackWrite("/reactions.remove", {
    channel: emptyIfAbsent(),
    timestamp: emptyIfAbsent(),
    name: emptyIfAbsent(),
  }),

  usersProfileSet: slackWrite("/users.profile.set", {
    user: absentIfEmpty(),
    profile: absentIfEmpty(),
    name: absentIfEmpty(),
    value: absentIfEmpty(),
  }),

  pinsAdd: slackWrite("/pins.add", {
    channel: emptyIfAbsent(),
    timestamp: emptyIfAbsent(),
  }),

  pinsRemove: slackWrite("/pins.remove", {
    channel: emptyIfAbsent(),
    timestamp: emptyIfAbsent(),
  }),

  filesUpload: slackWrite("/files.upload", {
    channels: absentIfEmpty(),
    channel: absentIfEmpty(),
    filename: absentIfEmpty(),
    title: absentIfEmpty(),
    filetype: absentIfEmpty(),
    content: absentIfEmpty(),
    initial_comment: absentIfEmpty(),
    thread_ts: absentIfEmpty(),
  }),

  filesDelete: slackWrite("/files.delete", { file: emptyIfAbsent() }),

  bookmarksAdd: slackWrite("/bookmarks.add", {
    channel_id: emptyIfAbsent(),
    title: emptyIfAbsent(),
    type: absentIfEmpty(),
    link: absentIfEmpty(),
    emoji: absentIfEmpty(),
    entity_id: absentIfEmpty(),
  }),

  bookmarksRemove: slackWrite("/bookmarks.remove", {
    channel_id: emptyIfAbsent(),
    bookmark_id: emptyIfAbsent(),
  }),

  canvasesCreate: slackWrite("/canvases.create", {
    title: absentIfEmpty(),
    document_content: opaque(),
    channel_id: absentIfEmpty(),
  }),

  canvasesEdit: slackWrite("/canvases.edit", {
    canvas_id: emptyIfAbsent(),
    changes: opaque(),
  }),

  canvasesDelete: slackWrite("/canvases.delete", { canvas_id: emptyIfAbsent() }),
};

/**
 * Every surface this twin publishes, in the order `routes.ts` mounts them.
 *
 * `diffRegisteredRoutes` compares this against what the registrar actually
 * mounted, so a route added without a declaration — or a declaration nothing
 * mounts — is a failing test rather than a hole in the published surface.
 */
export const SLACK_ROUTE_INPUTS: readonly RouteInputDeclaration[] = [
  ...Object.values(SLACK_READS).flatMap((surfaces) => [surfaces.get, surfaces.post]),
  ...Object.values(SLACK_WRITES),
];
