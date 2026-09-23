# @pome-sh/twin-telegram

Standalone Telegram digital twin: Bot API path `/bot<token>/<Method>`.

Not registered with the CLI. Boot this package directly.

Synthetic seed only. MCP derives its listing from the approved
[`chigwell/telegram-mcp` source capture](../../fixtures/mcp-tools-list/telegram.meta.json) at pinned
commit `45cce7e3dbf50655645f48d5f78d8a84aec6aa8f`. The capture imports the source's FastMCP
registration and schemas offline; it does not use Telegram credentials or call Telegram. This twin
projects account lookup plus the source-compatible interaction rows: pins, regular polls,
standard emoji reactions, and inline callback inspection/press. Reply keyboards and callback
answer/wait do not have source MCP registrations, so they remain HTTP-only. Every omitted source
operation is recorded in this package fixture's provenance.
