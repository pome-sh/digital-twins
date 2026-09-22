# @pome-sh/twin-telegram

Standalone Telegram digital twin: Bot API path `/bot<token>/<Method>`.

Not registered with the CLI. Boot this package directly.

Synthetic seed only. MCP operations are deferred until a compliant multi-account Telegram `tools/list`
capture is available; see [`fixtures/mcp-tools-list/telegram.status.json`](../../fixtures/mcp-tools-list/telegram.status.json).
No official Telegram-maintained MCP server is available, and third-party MTProto servers require
real account credentials prohibited by this twin's no-live-account policy.
