// SPDX-License-Identifier: Apache-2.0
//
// Where Slack's MCP tools do not line up 1:1 with this twin's Web API (F-1330).
//
// Kept out of `tools.ts` so the dispatch there stays one case per tool: every
// function here exists because Slack's tool takes an argument the Web API
// method behind it has no equivalent for.
//
// Three of Slack's tools take a REQUIRED `query` over a Web API method that has
// no query at all — `slack_search_channels` and `slack_search_users` sit over
// `conversations.list` and `users.list`, and `slack_search_emojis` over
// `emoji.list`. That is the behaviour change F-1330 names: the old
// `slack_list_channels` and `slack_get_users` took no query and returned
// everything.
//
// The matching lives here rather than in the domain on purpose. It is a fact
// about the MCP tool, not about the REST surface: `GET /conversations.list`
// still lists, unfiltered, exactly as it did, and `route-inputs.json` still
// describes it.

/** Case-insensitive substring match over the fields Slack says it searches. */
function matchesQuery(query: string, ...fields: Array<unknown>): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return fields.some(
    (field) => typeof field === "string" && field.toLowerCase().includes(needle)
  );
}

type ChannelEntry = { name?: unknown; topic?: { value?: unknown }; purpose?: { value?: unknown } };
type MemberEntry = { name?: unknown; real_name?: unknown; profile?: Record<string, unknown> };

export function filterChannels(listing: Record<string, unknown>, query: string): Record<string, unknown> {
  const channels = (listing.channels as ChannelEntry[] | undefined) ?? [];
  return {
    ...listing,
    channels: channels.filter((channel) =>
      matchesQuery(query, channel.name, channel.topic?.value, channel.purpose?.value)
    ),
  };
}

export function filterMembers(listing: Record<string, unknown>, query: string): Record<string, unknown> {
  const members = (listing.members as MemberEntry[] | undefined) ?? [];
  return {
    ...listing,
    members: members.filter((member) =>
      matchesQuery(
        query,
        member.name,
        member.real_name,
        member.profile?.email,
        member.profile?.title,
        member.profile?.real_name,
        member.profile?.display_name
      )
    ),
  };
}

/** `slack_search_emojis` documents comma-separated terms; any term may match. */
export function filterEmoji(listing: Record<string, unknown>, query: string): Record<string, unknown> {
  const terms = query
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const emoji = (listing.emoji as Record<string, string> | undefined) ?? {};
  const matched: Record<string, string> = {};
  for (const [name, value] of Object.entries(emoji)) {
    if (terms.length === 0 || terms.some((term) => name.toLowerCase().includes(term))) {
      matched[name] = value;
    }
  }
  return { ...listing, emoji: matched };
}

/**
 * Slack's `sections` edit vocabulary → the twin's `changes` vocabulary.
 *
 * `slack_update_canvas` also accepts a flat single-operation form
 * (`action`/`content`/`section_id`) alongside the preferred `sections` array;
 * both are declared in the listing, so both are honoured here.
 */
const CANVAS_EDIT_OPERATIONS: Record<string, string> = {
  append: "insert_at_end",
  prepend: "insert_at_start",
  replace: "replace",
  delete: "delete",
};

export function canvasChanges(args: {
  sections?: Array<{ edit_type: string; section_id?: string; content?: string }>;
  action?: string;
  content?: string;
  section_id?: string;
}): Array<Record<string, unknown>> {
  const sections =
    args.sections ??
    (args.action ? [{ edit_type: args.action, section_id: args.section_id, content: args.content }] : []);
  return sections.map((section) => ({
    operation: CANVAS_EDIT_OPERATIONS[section.edit_type] ?? section.edit_type,
    ...(section.section_id !== undefined ? { section_id: section.section_id } : {}),
    ...(section.content !== undefined
      ? { document_content: { type: "markdown", markdown: section.content } }
      : {}),
  }));
}
