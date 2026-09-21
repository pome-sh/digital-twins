# Telegram Twin Fidelity

Last verified: 2026-09-21.

Staged spine only. Not a Bot API or Tolboy-equivalence claim.

## Methods

| Method | Heat | Fidelity | Notes |
|---|---|---|---|
| getMe | hot | semantic | Seeded bot identity |
| getChat | hot | semantic | Member-visible chats only |
| sendMessage | hot | semantic | Text + optional reply_to_message_id |

## Tools

| Tool | Heat | Fidelity | Notes |
|---|---|---|---|
| get_me | hot | semantic | Account-scoped user identity |
| list_accounts | hot | semantic | Seeded named accounts |
| _manifest | hot | shape | Twin-authored listing |
| list_chats | hot | semantic | Account-visible chats |
| get_chat | hot | semantic | Member check |
| get_history | hot | semantic | Per-chat message_id order |
| send_message | hot | semantic | Writes SQLite |
| reply_to_message | hot | semantic | Missing reply is 400 |

## Divergences

1. MCP schemas are twin-authored. They are not a captured Tolboy listing.
2. Path tokens never persist onto the tape (shared wire redaction).
3. Polling, webhooks, media, and the remaining Bot API methods are unsupported.
