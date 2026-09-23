# Telegram Twin Fidelity

Last verified: 2026-09-21.

Staged Bot API conversation, interaction, and **HTTP-only media foundation**. Not a Bot API or Tolboy-equivalence claim.

## Methods

| Method | Heat | Fidelity | Notes |
|---|---|---|---|
| getMe / getChat | hot | semantic | Seeded bot identity and member-visible chats |
| sendMessage | hot | semantic | Text, optional reply, inline keyboard, or reply keyboard |
| editMessageText / editMessageReplyMarkup | hot | bounded | Author only; callback-data inline and text reply keyboards only |
| deleteMessage / deleteMessages | hot | semantic | Bot: fixed 48h window; batch applies in order |
| forwardMessage / copyMessage | hot | semantic | Forward keeps attribution; copy is independent |
| getUpdates | hot | semantic | SQLite queue, 24h retention, offsets, one waiter per bot |
| setWebhook / deleteWebhook / getWebhookInfo | hot | bounded | Durable local-fixture outbox; no network egress |
| pinChatMessage / unpinChatMessage / unpinAllChatMessages | hot | bounded | Persisted pin state and staged pin authority |
| answerCallbackQuery | hot | bounded | Durable one-shot callback correlation; expires at 60 seconds |
| sendPoll / stopPoll | hot | bounded | Regular polls: 1–300 character question, 2–10 1–100 character options |
| setMessageReaction | hot | bounded | One non-empty standard emoji per actor/message |
| sendPhoto / sendDocument / sendVideo / sendAudio / sendVoice | hot | bounded | Bot-scoped SQLite media handles; multipart upload or owned `file_id`; no URL or host-file fetch |
| sendMediaGroup | hot | bounded | 2–10 owned media references, atomic message creation and album id; multipart attachments total at most 64 MiB |
| editMessageCaption | hot | bounded | Author-only media captions, maximum 1024 UTF-16 code units |
| getFile / `/file/bot<TOKEN>/...` | hot | bounded | Opaque, expiring bot-scoped handle; byte download only, not a filesystem path |
| sendChatAction | warm | bounded | Validates membership and the staged Bot API action set; no transient update |

## MCP

Telegram MCP operations are deferred. The repository's permitted provenance record is
[`fixtures/mcp-tools-list/telegram.status.json`](../../fixtures/mcp-tools-list/telegram.status.json):
a compliant multi-account Tolboy `tools/list` capture requires unavailable/forbidden TDLib
configuration. No official Telegram-maintained MCP server is available, and third-party MTProto
servers require real account credentials prohibited by the no-live-account policy. This twin
therefore serves no MCP operations or twin-authored MCP fixture/listing claims until compliant
captured bytes are available. This HTTP-only media foundation deliberately does not add an MCP
media operation or tool-table entry.

Callback waiting remains an internal domain facility for a future supported operation; no currently
served MCP operation exposes optional callback waiting.

## Divergences

1. Path tokens never persist onto the tape (shared wire redaction).
2. Bot delete window is a fixed 48 hours from `date`.
3. User `revoke` of someone else's message is refused.
4. Links never fetch the network. Only the `tg://message` form this twin emits is accepted.
5. Emitted updates are `message`, `callback_query`, `poll_answer`, and `message_reaction`; all other Bot API update types are unsupported.
6. At most one long-poll `getUpdates` request may wait for a bot. A second request gets 409; cancellation and reset wake the first request with the then-current queue.
7. Webhook deliveries use an injected local receiver only. The twin makes no network request. Public URLs persist for wire fidelity but get deterministic 503 delivery attempts; loopback URLs require an exact configured local fixture.
8. The durable webhook outbox drains at most 8 due updates per pass. Delivery retries use 1, 2, 4, 8, 16, then 32-second capped exponential delays.
9. Interactive markup supports only callback-data inline buttons and text reply keyboards. URL, web-app, game, paid, and custom button forms are rejected.
10. Callback queries expire exactly at a deterministic 60 seconds.
11. Polls are regular text polls only (2–10 options, 1–300 character question, 1–100 character options), with aggregate counts. Quiz, explanation, open-period, paid, and custom forms are rejected.
12. Reactions support one non-empty standard emoji per actor/message. Custom emoji, paid reactions, and animation flags are rejected.
13. User pin authority is limited to an authored message in a private chat; a Bot API bot is the authorized group actor in this staged slice.
14. Media content is bounded to 20 MiB per uploaded file and stored as SQLite bytes for its session. Multipart album attachments have a separate 64 MiB aggregate cap; each multipart request admits at most an additional 1 MiB of framing and is budgeted while streaming, even when `Content-Length` is absent. `file_unique_id`, URLs, filesystem paths, traversal, and attachment paths are not valid references.
15. Media expires after 24 hours of twin time and is removed on seed/reset. Download paths are opaque `media/file_…` handles rather than paths beneath any host storage root.
