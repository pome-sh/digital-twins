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
| message_from_link | hot | semantic | Seeded tg:// or t.me/c links only |
| get_message_link | hot | semantic | tg://message?chat_id=&message_id= |
| mark_as_read | hot | semantic | Per-account cursor |
| get_message_viewers | hot | semantic | Private: self. Group: cursors past the message |

## Divergences

1. MCP schemas are twin-authored. They are not a captured Tolboy listing.
2. Path tokens never persist onto the tape (shared wire redaction).
3. Bot delete window is a fixed 48 hours from `date`.
4. User `revoke` of someone else's message is refused.
5. Links never fetch the network.
6. Polling, webhooks, media, and remaining Bot API methods are unsupported.
