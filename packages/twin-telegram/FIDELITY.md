# Telegram Twin Fidelity

Last verified: 2026-09-21.

Staged conversation + history slice. Not a Bot API or Tolboy-equivalence claim.

## Methods

| Method | Heat | Fidelity | Notes |
|---|---|---|---|
| getMe | hot | semantic | Seeded bot identity |
| getChat | hot | semantic | Member-visible chats only |
| sendMessage | hot | semantic | Text + optional reply_to_message_id |
| editMessageText | hot | semantic | Author only; same text is a no-op |
| deleteMessage | hot | semantic | Bot: 48h window. User own: revoke. User other: local hide |
| deleteMessages | hot | semantic | Same rules, applied in order |
| forwardMessage | hot | semantic | New id, keeps forward_from |
| copyMessage | hot | semantic | New independent message |
| getUpdates | hot | semantic | SQLite queue, 24h retention, positive/negative offsets, one long poll per bot |
| setWebhook | hot | bounded | Durable local-fixture outbox; only `message` updates |
| deleteWebhook | hot | semantic | Returns to polling; can drop pending updates |
| getWebhookInfo | hot | semantic | SQLite-backed configuration, pending count, and last deterministic delivery error |

## Tools

| Tool | Heat | Fidelity | Notes |
|---|---|---|---|
| get_me | hot | semantic | Account-scoped user identity |
| list_accounts | hot | semantic | Seeded named accounts |
| _manifest | hot | shape | Twin-authored listing |
| list_chats | hot | semantic | Account-visible chats |
| get_chat | hot | semantic | Member check |
| get_history | hot | semantic | Hides local deletes |
| send_message | hot | semantic | Writes SQLite |
| reply_to_message | hot | semantic | Missing reply is 400 |
| get_messages | hot | semantic | Context window around message_id, not an id array |
| search_messages | hot | semantic | One chat, current text |
| search_global | hot | semantic | Account-visible chats only |
| edit_message | hot | semantic | Author only |
| delete_message | hot | semantic | Revoke vs local hide |
| forward_message | hot | semantic | Attribution kept |
| get_message_context | hot | semantic | Same window as get_messages |
| message_from_link | hot | semantic | Only `tg://message?chat_id=&message_id=` that this twin emits |
| get_message_link | hot | semantic | tg://message?chat_id=&message_id= |
| mark_as_read | hot | semantic | Per-account cursor |
| get_message_viewers | hot | semantic | Private: self. Group: cursors past the message |

## Divergences

1. MCP schemas are twin-authored. They are not a captured Tolboy listing.
2. Path tokens never persist onto the tape (shared wire redaction).
3. Bot delete window is a fixed 48 hours from `date`.
4. User `revoke` of someone else's message is refused.
5. Links never fetch the network. Only the `tg://message` form this twin emits is accepted.
6. Only `message` updates are emitted. Other Bot API update types are unsupported.
7. At most one long-poll `getUpdates` request may wait for a bot. A second request gets 409; cancellation and reset wake the first request with the then-current queue.
8. Webhook deliveries use an injected local receiver only. The twin makes no network request. Public URLs persist for wire fidelity but get deterministic 503 delivery attempts; loopback URLs require an exact configured local fixture.
9. The durable webhook outbox drains at most 8 due updates per pass. Delivery retries use 1, 2, 4, 8, 16, then 32-second capped exponential delays.
